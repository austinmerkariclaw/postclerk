'use strict';

const { DECISIVE, WEIGHTED, LABELS } = require('./signals');

/**
 * The triage cascade (ADR-004).
 *
 * Cheap, high-confidence evidence resolves the confident majority of mail with
 * zero network egress and zero cost. Only what remains genuinely ambiguous is
 * handed to a model. The ordering is not a cost hack: on its strongest signals
 * this layer is *more* accurate than a zero-shot judgment, because it is
 * reading the user's own behavior rather than guessing at it.
 */

const DEFAULT_CONFIG = {
  /** Below this confidence, escalate to the model. */
  escalateBelow: 0.75,
  /** Sent-message count at which someone counts as a known correspondent. */
  knownCorrespondentMinSent: 3,
  /** ...and how recently you must have written to them for that to still hold. */
  knownCorrespondentMaxAgeDays: 180,
  /** Received-count at which "never answered" becomes a decision, not an accident. */
  neverAnsweredMinReceived: 5,
  /** Ceiling on confidence for a decision reached by weights alone. */
  weightedConfidenceCeiling: 0.9,
};

/**
 * Index the user's own messages by thread, so `threadParticipant` can fire.
 */
function buildThreadIndex(sentMessages) {
  const index = new Map();
  for (const message of sentMessages) {
    if (!message.threadId) continue;
    const entry = index.get(message.threadId) || { userParticipated: true, userMessages: 0, lastAt: null };
    entry.userMessages += 1;
    if (!entry.lastAt || message.date > entry.lastAt) entry.lastAt = message.date;
    index.set(message.threadId, entry);
  }
  return index;
}

/**
 * Classify one message.
 *
 * @param {object} message normalized Message
 * @param {object} ctx { graph, config, selfAddresses, threadIndex, asOf }
 * @returns {object} Decision
 */
function classify(message, ctx = {}) {
  const config = { ...DEFAULT_CONFIG, ...(ctx.config || {}) };
  const graph = ctx.graph;
  const asOf = ctx.asOf || null;

  const stats = graph
    ? graph.statsAt(message.from.email, asOf)
    : { sentTo: 0, receivedFrom: 0, lastSentAt: null, medianReplyLatencyMs: null, isVip: false, isMuted: false };
  const domainStats = graph
    ? graph.domainStatsAt(message.from.domain, asOf)
    : { domain: message.from.domain, sentTo: 0 };

  const threadState = ctx.threadIndex ? ctx.threadIndex.get(message.threadId) || null : null;

  const signalCtx = {
    message,
    stats,
    domainStats,
    threadState,
    config,
    selfAddresses: ctx.selfAddresses || [],
    asOf,
  };

  // --- stage 1: decisive signals, in priority order --------------------------
  for (const signal of DECISIVE) {
    let evidence = null;
    try {
      evidence = signal(signalCtx);
    } catch {
      continue; // a broken signal must never fail a whole run
    }
    if (!evidence) continue;

    return {
      uid: message.uid,
      messageId: message.messageId,
      label: evidence.decisive,
      confidence: evidence.confidence,
      tier: 0,
      reasons: [{ code: evidence.code, detail: evidence.detail, weight: null, decisive: true }],
      escalate: false,
      cost: null,
    };
  }

  // --- stage 2: weighted evidence -------------------------------------------
  const scores = Object.fromEntries(LABELS.map((l) => [l, 0]));
  const reasons = [];

  for (const signal of WEIGHTED) {
    let evidence = null;
    try {
      evidence = signal(signalCtx);
    } catch {
      continue;
    }
    if (!evidence || !evidence.weights) continue;

    for (const [label, weight] of Object.entries(evidence.weights)) {
      if (scores[label] === undefined) continue;
      scores[label] += weight;
    }
    reasons.push({
      code: evidence.code,
      detail: evidence.detail,
      weight: evidence.weights,
      decisive: false,
    });
  }

  const ranked = LABELS
    .map((label) => ({ label, score: scores[label] }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  const second = ranked[1];

  // No evidence at all: say so honestly and let the model decide.
  if (top.score === 0) {
    return {
      uid: message.uid,
      messageId: message.messageId,
      label: 'later',
      confidence: 0.2,
      tier: 0,
      reasons: [{ code: 'no-signal', detail: 'no deterministic evidence available', weight: null, decisive: false }],
      escalate: true,
      cost: null,
      scores,
    };
  }

  // Confidence is the margin between the top two labels. A clear winner is
  // trusted; a near-tie is exactly the case worth paying a model to resolve.
  const margin = (top.score - second.score) / (top.score + second.score || 1);
  const confidence = Math.min(
    config.weightedConfidenceCeiling,
    Number((0.4 + 0.5 * margin).toFixed(3))
  );

  return {
    uid: message.uid,
    messageId: message.messageId,
    label: top.label,
    confidence,
    tier: 0,
    reasons,
    escalate: confidence < config.escalateBelow,
    cost: null,
    scores,
  };
}

/**
 * Classify a batch, partitioning into confident and escalating.
 */
function classifyAll(messages, ctx = {}) {
  const decisions = [];
  const escalate = [];

  for (const message of messages) {
    const decision = classify(message, ctx);
    decisions.push(decision);
    if (decision.escalate) escalate.push(message);
  }

  return {
    decisions,
    escalate,
    escalationRate: messages.length ? escalate.length / messages.length : 0,
  };
}

/** Merge model verdicts back over the deterministic ones. */
function applyModelDecisions(decisions, modelDecisions) {
  const byUid = new Map(modelDecisions.map((d) => [d.uid, d]));
  return decisions.map((decision) => {
    const model = byUid.get(decision.uid);
    if (!model) return decision;
    return {
      ...decision,
      label: model.label,
      confidence: model.confidence,
      tier: 1,
      cost: model.cost || null,
      reasons: [
        ...decision.reasons,
        { code: 'model', detail: model.rationale || 'model judgment', weight: null, decisive: true },
      ],
      escalate: false,
    };
  });
}

module.exports = {
  DEFAULT_CONFIG,
  classify,
  classifyAll,
  applyModelDecisions,
  buildThreadIndex,
};
