'use strict';

const { classify } = require('./triage/cascade');
const { buildGraph } = require('./triage/correspondents');

/**
 * Backtest: score triage against what the user actually did (ADR-005).
 *
 * The insight is that the label set is free and already on disk. We do not need
 * an annotated corpus — the user's own past behavior is the ground truth, and
 * it is drawn from exactly the distribution the system will run on. If they
 * replied, the message needed them. If it sat unread for a week, it did not.
 *
 * Two honesty requirements shape this file:
 *
 *   1. NO LEAKAGE. Every decision is made with a graph built strictly from mail
 *      that predates the message being scored. Building the graph from all
 *      history and then scoring old messages lets the future leak into the past
 *      and inflates the score — this is the single easiest way to make a
 *      backtest lie, so `asOf` is threaded through everything.
 *
 *   2. NO OVERCLAIMING. This measures agreement with past behavior, not
 *      correctness. People miss mail they should have answered and reply to
 *      things that did not need them. The report says so.
 */

/** How the user's observed behavior maps onto a label. */
const GROUND_TRUTH = {
  replied: 'now',
  flagged: 'now',
  readNotActed: 'later',
  ignored: 'brief',
};

/**
 * Infer what the user's behavior says the label should have been.
 * Returns null when the evidence is too thin to score — an unread message from
 * this morning tells us nothing yet, and guessing would be noise.
 */
function groundTruth(message, { repliedThreads, asOf, settleDays = 3, ignoreDays = 7 }) {
  const ageDays = (asOf - message.date) / (24 * 60 * 60 * 1000);

  if (message.flags.includes('\\Answered')) {
    return { label: GROUND_TRUTH.replied, evidence: 'you replied to it' };
  }
  if (repliedThreads.has(message.threadId)) {
    return { label: GROUND_TRUTH.replied, evidence: 'you replied in this thread' };
  }
  if (message.flags.includes('\\Flagged')) {
    return { label: GROUND_TRUTH.flagged, evidence: 'you flagged it' };
  }

  const seen = message.flags.includes('\\Seen');
  if (seen && ageDays >= settleDays) {
    return { label: GROUND_TRUTH.readNotActed, evidence: 'you read it but never replied' };
  }
  if (!seen && ageDays >= ignoreDays) {
    return { label: GROUND_TRUTH.ignored, evidence: `unread after ${Math.round(ageDays)} days` };
  }

  return null; // too recent to have settled
}

/**
 * Build an index of when the user replied in each thread, so ground truth can
 * be established without asking the server anything extra.
 */
function repliedThreadIndex(sentMessages) {
  const byThread = new Map();
  for (const message of sentMessages) {
    if (!message.threadId) continue;
    const dates = byThread.get(message.threadId) || [];
    dates.push(message.date.getTime());
    byThread.set(message.threadId, dates);
  }
  for (const dates of byThread.values()) dates.sort((a, b) => a - b);
  return byThread;
}

/**
 * Run the backtest.
 *
 * @param {object} args
 * @param {object[]} args.inbox   received messages to score
 * @param {object[]} args.sent    the user's sent mail (ground truth + graph)
 * @param {object}   args.config
 * @param {Date}     [args.asOf]
 */
function backtest({ inbox, sent, config, asOf = new Date() }) {
  const selfAddresses = config.self.length ? config.self : [config.imap.user];
  const threadReplies = repliedThreadIndex(sent);
  const repliedThreads = new Set(threadReplies.keys());

  // The full graph is built once. Point-in-time honesty comes from passing
  // `asOf` per message, which filters the graph's event timestamps — not from
  // rebuilding the graph for every message, which would be O(n²).
  const graph = buildGraph(sent, inbox, {
    vips: config.rules.vips,
    muted: config.rules.muted,
  });

  const scored = [];
  const skipped = [];

  for (const message of inbox) {
    const truth = groundTruth(message, { repliedThreads, asOf });
    if (!truth) {
      skipped.push({ uid: message.uid, subject: message.subject, reason: 'too recent to have settled' });
      continue;
    }

    // Thread participation must also be point-in-time: "had you already replied
    // in this thread *before* this message arrived?"
    const priorReplies = (threadReplies.get(message.threadId) || [])
      .filter((t) => t < message.date.getTime()).length;
    const threadIndex = new Map();
    if (priorReplies > 0) {
      threadIndex.set(message.threadId, { userParticipated: true, userMessages: priorReplies, lastAt: null });
    }

    const decision = classify(message, {
      graph,
      threadIndex,
      config: config.triage,
      selfAddresses,
      asOf: message.date, // <- the leakage guard
    });

    scored.push({
      uid: message.uid,
      subject: message.subject,
      from: message.from.email,
      date: message.date,
      predicted: decision.label,
      actual: truth.label,
      evidence: truth.evidence,
      confidence: decision.confidence,
      tier: decision.tier,
      escalated: decision.escalate,
      reasons: decision.reasons,
      agree: decision.label === truth.label,
    });
  }

  return summarize(scored, skipped, config);
}

function summarize(scored, skipped, config) {
  const labels = ['now', 'later', 'brief', 'noise'];
  const total = scored.length;
  const agreed = scored.filter((s) => s.agree).length;

  const matrix = {};
  for (const actual of labels) {
    matrix[actual] = Object.fromEntries(labels.map((l) => [l, 0]));
  }
  for (const s of scored) {
    if (matrix[s.actual] && matrix[s.actual][s.predicted] !== undefined) {
      matrix[s.actual][s.predicted] += 1;
    }
  }

  const perLabel = {};
  for (const label of labels) {
    const predictedCount = scored.filter((s) => s.predicted === label).length;
    const actualCount = scored.filter((s) => s.actual === label).length;
    const correct = scored.filter((s) => s.predicted === label && s.actual === label).length;
    perLabel[label] = {
      predicted: predictedCount,
      actual: actualCount,
      correct,
      precision: predictedCount ? correct / predictedCount : null,
      recall: actualCount ? correct / actualCount : null,
    };
  }

  // The two error classes that actually matter, reported separately because
  // they have wildly different costs to the user (ADR-005).
  const buried = scored.filter((s) => s.actual === 'now' && (s.predicted === 'brief' || s.predicted === 'noise'));
  const cluttered = scored.filter((s) => s.predicted === 'now' && (s.actual === 'brief' || s.actual === 'noise'));

  const escalated = scored.filter((s) => s.escalated).length;
  const escalationRate = total ? escalated / total : 0;

  return {
    total,
    skipped: skipped.length,
    agreed,
    agreementRate: total ? agreed / total : 0,
    perLabel,
    matrix,
    buried: buried.map(trim),
    cluttered: cluttered.map(trim),
    escalated,
    escalationRate,
    projectedCost: projectCost(escalated, total, config),
    scored,
    caveats: [
      'Measures agreement with your past behavior, not correctness in the abstract.',
      'Mail you should have answered but did not is counted against the tool here.',
      'Replay is not counterfactual: it cannot model how your behavior would have',
      'changed had postclerk been running at the time.',
    ],
  };
}

function trim(s) {
  return {
    uid: s.uid,
    from: s.from,
    subject: s.subject.slice(0, 80),
    predicted: s.predicted,
    actual: s.actual,
    evidence: s.evidence,
    confidence: s.confidence,
    topReason: s.reasons[0] ? s.reasons[0].detail : '',
  };
}

/**
 * Project what a month of this inbox would cost, using the batch economics the
 * real pipeline uses. Approximate and labeled as such — the honest number is
 * the one printed after a real run.
 */
function projectCost(escalated, total, config) {
  const PRICING = require('./llm/pricing.json');
  const price = PRICING.models[config.llm.model] || PRICING.models['claude-opus-5'];

  const batchSize = config.triage.batchSize || 10;
  const perMessageInputTokens = Math.ceil((config.llm.bodyChars || 2000) / 4) + 60;
  const systemTokens = 400;

  const batches = Math.ceil(escalated / batchSize);
  const inputTokens = escalated * perMessageInputTokens + batches * systemTokens;
  const outputTokens = escalated * 40;

  const usd = (inputTokens * price.input + outputTokens * price.output) / 1e6;
  const days = Math.max(1, config.triage.lookbackDays || 7);

  return {
    model: config.llm.model,
    windowDays: days,
    escalated,
    total,
    inputTokens,
    outputTokens,
    usdForWindow: usd,
    usdPerMonth: (usd / days) * 30,
    note: 'estimate; assumes batched escalation and ignores prompt-cache savings',
  };
}

module.exports = { backtest, groundTruth, repliedThreadIndex, projectCost, GROUND_TRUTH };
