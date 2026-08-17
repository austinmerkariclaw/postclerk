'use strict';

const { classifyAll, applyModelDecisions, buildThreadIndex } = require('./triage/cascade');
const { buildGraph } = require('./triage/correspondents');
const { projectBatch, explain } = require('./llm/project');
const { ModelRefusal, BatchTooLarge } = require('./llm');
const store = require('./store');

/**
 * The triage pipeline (design §2).
 *
 * Deterministic first, model only for the ambiguous remainder, everything
 * journaled before it is applied.
 */

async function runTriage({ config, mailbox, provider, options = {} }) {
  const lookback = options.lookbackDays ?? config.triage.lookbackDays;
  const asOf = options.asOf || new Date();

  // --- gather ---------------------------------------------------------------
  const inbox = await mailbox.fetchInbox(lookback);
  const sent = await mailbox.fetchSent(Math.max(lookback, 90));

  const graph = buildGraph(sent, inbox, {
    vips: config.rules.vips,
    muted: config.rules.muted,
  });
  const threadIndex = buildThreadIndex(sent);

  store.saveGraph(graph);
  store.saveMessages([...inbox, ...sent]);

  // --- tier 0: deterministic ------------------------------------------------
  const pass = classifyAll(inbox, {
    graph,
    threadIndex,
    config: config.triage,
    selfAddresses: config.self.length ? config.self : [config.imap.user],
    asOf,
  });

  const result = {
    total: inbox.length,
    decisions: pass.decisions,
    escalated: pass.escalate.length,
    escalationRate: pass.escalationRate,
    audit: { calls: 0, bytesSent: 0, hashes: [], redactions: [] },
    cost: { usd: 0, input: 0, output: 0, calls: 0 },
    provider: provider ? provider.name : 'none',
    messages: inbox,
    graph,
    warnings: [],
  };

  if (!provider || provider.name === 'none' || pass.escalate.length === 0) {
    if (pass.escalate.length && (!provider || provider.name === 'none')) {
      result.warnings.push(
        `${pass.escalate.length} message(s) were ambiguous but no model is configured; ` +
        `they were left as "later". Set llm.provider to improve this.`
      );
    }
    return result;
  }

  // --- tier 1: bounded escalation ------------------------------------------
  // Only ambiguous mail gets bodies fetched — the confident majority never
  // has its body read at all, let alone transmitted.
  const withBodies = await mailbox.fetchBodies(
    mailbox.folders.inbox,
    pass.escalate.map((m) => m.uid)
  );
  const bodyByUid = new Map(withBodies.map((m) => [m.uid, m]));
  const escalating = pass.escalate.map((m) => bodyByUid.get(m.uid) || m);

  const selfAddresses = config.self.length ? config.self : [config.imap.user];
  const modelDecisions = [];

  for (const chunk of chunkBy(escalating, config.triage.batchSize)) {
    const batch = projectBatch(chunk, selfAddresses, { bodyChars: config.llm.bodyChars });

    if (options.explain) {
      result.audit.explained = (result.audit.explained || []);
      result.audit.explained.push(explain(batch));
      continue; // --explain never transmits
    }

    try {
      const response = await provider.classify(batch);
      modelDecisions.push(...response.decisions);
      recordAudit(result, batch, response.usage);
    } catch (err) {
      if (err instanceof BatchTooLarge && chunk.length > 1) {
        // Halve and retry: the batch, not the run, is what failed.
        for (const half of chunkBy(chunk, Math.ceil(chunk.length / 2))) {
          const smaller = projectBatch(half, selfAddresses, { bodyChars: config.llm.bodyChars });
          try {
            const response = await provider.classify(smaller);
            modelDecisions.push(...response.decisions);
            recordAudit(result, smaller, response.usage);
          } catch (inner) {
            result.warnings.push(`batch failed after split: ${inner.message}`);
          }
        }
        continue;
      }
      if (err instanceof ModelRefusal) {
        result.warnings.push(`model declined a batch of ${chunk.length}; left as "later"`);
        continue;
      }
      // Degrade to Tier 0 rather than failing the run. A partial triage that
      // errs toward showing mail is far better than no triage at all.
      result.warnings.push(`model unavailable (${err.message}); ${chunk.length} message(s) left as "later"`);
    }
  }

  result.decisions = applyModelDecisions(result.decisions, modelDecisions);
  result.cost.calls = result.audit.calls;
  return result;
}

function recordAudit(result, batch, usage) {
  result.audit.calls += 1;
  result.audit.bytesSent += batch.audit.bytes;
  result.audit.hashes.push(batch.audit.sha256);
  for (const r of batch.audit.redactions) {
    const existing = result.audit.redactions.find((x) => x.rule === r.rule);
    if (existing) existing.count += r.count;
    else result.audit.redactions.push({ ...r });
  }
  if (usage) {
    result.cost.usd += usage.usd || 0;
    result.cost.input += usage.input || 0;
    result.cost.output += usage.output || 0;
  }
}

/**
 * Turn decisions into mailbox actions.
 *
 * `now` is deliberately a no-op: mail that needs you stays exactly where you
 * expect it, untouched. Only the quieter labels are filed.
 */
function planActions(decisions, folders, { flagUrgent = true } = {}) {
  const actions = [];
  for (const decision of decisions) {
    if (decision.label === 'now') {
      if (flagUrgent) {
        actions.push({
          action: 'flag',
          uid: decision.uid,
          messageId: decision.messageId,
          from: folders.inbox,
          flags: ['\\Flagged'],
          label: decision.label,
        });
      }
      continue;
    }
    const destination = folders[decision.label];
    if (!destination) continue;
    actions.push({
      action: 'move',
      uid: decision.uid,
      messageId: decision.messageId,
      from: folders.inbox,
      to: destination,
      label: decision.label,
    });
  }
  return actions;
}

/**
 * Apply actions, journaling intent durably *before* touching the mailbox.
 */
async function applyActions(mailbox, journal, actions, { runId = null } = {}) {
  if (!actions.length) return { runId: null, applied: 0, failed: 0 };

  const id = runId || require('./store').Journal.newRunId();
  journal.writeIntent(id, actions);

  let applied = 0;
  let failed = 0;

  for (const action of actions) {
    try {
      await mailbox.applyAction(action);
      journal.writeResult(id, action, { applied: true });
      applied += 1;
    } catch (err) {
      journal.writeResult(id, action, { applied: false, error: err });
      failed += 1;
    }
  }

  return { runId: id, applied, failed };
}

/**
 * Reverse the last applied run.
 *
 * Works from recorded intent rather than recorded results, so a run that
 * crashed halfway is still fully reversible — the actions we intended but
 * never confirmed are attempted too, and a redundant reversal is harmless.
 */
async function undoLastRun(mailbox, journal) {
  const run = journal.lastAppliedRun();
  if (!run) return { runId: null, reversed: 0, message: 'nothing to undo' };

  let reversed = 0;
  const failures = [];

  for (const action of run.intents) {
    const inverse = store.invertAction(action);
    if (!inverse) continue;
    try {
      await mailbox.applyAction(inverse);
      reversed += 1;
    } catch (err) {
      failures.push(`${action.action} uid ${action.uid}: ${err.message}`);
    }
  }

  journal.markUndone(run.runId, reversed);
  return { runId: run.runId, reversed, failures, message: `reversed ${reversed} action(s)` };
}

/**
 * Derive a voice profile from the user's own Sent folder — locally, with no
 * model call. Everything here is a measurement, not a guess.
 */
function buildVoiceProfile(sentMessages, limit = 200) {
  const sample = sentMessages
    .filter((m) => m.bodyText && m.bodyText.length > 20)
    .slice(-limit);

  if (sample.length === 0) {
    return store.VOICE_TEMPLATE;
  }

  const lengths = sample.map((m) => m.bodyText.split(/\s+/).length).sort((a, b) => a - b);
  const medianLength = lengths[Math.floor(lengths.length / 2)];

  const greetings = tally(sample, (m) => {
    const first = m.bodyText.split('\n').find((l) => l.trim());
    const match = /^(hi|hello|hey|dear|good morning|good afternoon|thanks|thank you)\b/i.exec(first || '');
    return match ? match[1].toLowerCase() : null;
  });

  const signoffs = tally(sample, (m) => {
    const lines = m.bodyText.split('\n').map((l) => l.trim()).filter(Boolean);
    const tail = lines.slice(-3).join(' ');
    const match = /\b(best|thanks|cheers|regards|best regards|talk soon|sincerely)\b/i.exec(tail);
    return match ? match[1].toLowerCase() : null;
  });

  const exclamations = sample.filter((m) => m.bodyText.includes('!')).length;
  const contractions = sample.filter((m) => /\b(don't|can't|it's|we'll|I'm|that's)\b/i.test(m.bodyText)).length;

  const examples = sample
    .slice(-3)
    .map((m) => m.bodyText.split('\n').filter((l) => l.trim()).slice(0, 4).join('\n'))
    .map((text) => `> ${text.replace(/\n/g, '\n> ')}`);

  return `# Voice profile

Learned from ${sample.length} of your sent messages. This is a plain file —
edit it freely. Anything you write here overrides what was inferred.

## Observed

- Typical reply length: **${medianLength} words**
- Common greetings: ${format(greetings) || '_none consistently_'}
- Common sign-offs: ${format(signoffs) || '_none consistently_'}
- Uses exclamation marks in ${pct(exclamations, sample.length)} of messages
- Uses contractions in ${pct(contractions, sample.length)} of messages

## Examples of how you actually write

${examples.join('\n\n')}

## Your notes

_(Add anything the numbers above miss — tone with particular people, phrases
you never use, how formal to be with new contacts.)_
`;
}

function tally(items, extract) {
  const counts = new Map();
  for (const item of items) {
    const key = extract(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3);
}

function format(pairs) {
  return pairs.map(([word, n]) => `"${word}" (${n}×)`).join(', ');
}

function pct(n, total) {
  return `${Math.round((n / total) * 100)}%`;
}

function chunkBy(items, size) {
  const out = [];
  const step = Math.max(1, size || 1);
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

module.exports = {
  runTriage,
  planActions,
  applyActions,
  undoLastRun,
  buildVoiceProfile,
  chunkBy,
};
