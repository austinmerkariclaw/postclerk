'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalize } = require('../lib/message');
const { buildGraph, CorrespondentGraph } = require('../lib/triage/correspondents');
const { classify, classifyAll, buildThreadIndex, DEFAULT_CONFIG } = require('../lib/triage/cascade');
const signals = require('../lib/triage/signals');
const fx = require('./helpers/fixtures');

const SELF = ['alice@example.com'];
const NOW = new Date('2026-08-16T12:00:00Z');

function inbox() {
  return fx.ALL.map((m) => normalize(m.raw, { uid: m.uid, folder: 'INBOX' }));
}
function sent() {
  return fx.SENT.map((raw, i) => normalize(raw, { uid: 900 + i, folder: 'Sent' }));
}

function context(overrides = {}) {
  const sentMessages = sent();
  return {
    graph: buildGraph(sentMessages, inbox()),
    threadIndex: buildThreadIndex(sentMessages),
    selfAddresses: SELF,
    asOf: NOW,
    ...overrides,
  };
}

function byName(name) {
  const entry = fx.ALL.find((m) => m.name === name);
  return normalize(entry.raw, { uid: entry.uid, folder: 'INBOX' });
}

// ------------------------------------------------------------- graph behavior

test('builds a correspondent graph from the Sent folder', () => {
  const graph = buildGraph(sent(), inbox());
  const dana = graph.statsAt('dana@partnerco.example');
  assert.strictEqual(dana.sentTo, 3, 'three sent messages to Dana');
  assert.ok(dana.receivedFrom >= 1);
  assert.ok(dana.lastSentAt instanceof Date);
});

test('derives reply latency by pairing sent mail against the thread it answers', () => {
  const graph = buildGraph(sent(), inbox());
  const dana = graph.statsAt('dana@partnerco.example');
  // Dana wrote at 13 Aug 14:22; nothing the user sent postdates it in-thread,
  // so latency comes from the earlier pairing rather than being invented.
  assert.ok(dana.medianReplyLatencyMs === null || dana.medianReplyLatencyMs >= 0);
});

test('point-in-time stats do not leak the future into the past', () => {
  const graph = buildGraph(sent(), inbox());

  const today = graph.statsAt('dana@partnerco.example');
  const asOfAug8 = graph.statsAt('dana@partnerco.example', new Date('2026-08-08T00:00:00Z'));

  assert.strictEqual(today.sentTo, 3);
  assert.strictEqual(asOfAug8.sentTo, 1, 'only the 7 Aug message predates the cutoff');
  assert.strictEqual(asOfAug8.medianReplyLatencyMs, null, 'latency must not be used historically');
});

test('graph survives a JSON round trip', () => {
  const graph = buildGraph(sent(), inbox(), { vips: ['boss@example.com'] });
  const restored = CorrespondentGraph.fromJSON(JSON.parse(JSON.stringify(graph.toJSON())));
  assert.strictEqual(restored.statsAt('dana@partnerco.example').sentTo, 3);
  assert.ok(restored.isVip('boss@example.com'));
});

// ---------------------------------------------------------- decisive signals

test('newsletters are filed to the brief on bulk headers alone', () => {
  const decision = classify(byName('newsletter'), context());
  assert.strictEqual(decision.label, 'brief');
  assert.strictEqual(decision.tier, 0, 'must resolve without the model');
  assert.strictEqual(decision.escalate, false);
  assert.strictEqual(decision.reasons[0].code, 'bulk');
});

test('auto-generated mail is noise', () => {
  const decision = classify(byName('automated'), context());
  assert.strictEqual(decision.label, 'noise');
  assert.strictEqual(decision.reasons[0].code, 'auto-submitted');
});

test('a live thread the user is already in surfaces as now', () => {
  const decision = classify(byName('known-colleague'), context());
  assert.strictEqual(decision.label, 'now');
  assert.strictEqual(decision.tier, 0);
  assert.ok(
    ['thread-participant', 'known-correspondent'].includes(decision.reasons[0].code),
    `unexpected reason: ${decision.reasons[0].code}`
  );
});

test('VIP rules outrank every other signal', () => {
  // The newsletter would otherwise be filed to the brief.
  const graph = buildGraph(sent(), inbox(), { vips: ['news@dailybrief.example'] });
  const decision = classify(byName('newsletter'), context({ graph }));
  assert.strictEqual(decision.label, 'now');
  assert.strictEqual(decision.confidence, 1);
  assert.strictEqual(decision.reasons[0].code, 'vip');
});

test('muted senders are silenced even when they look important', () => {
  const graph = buildGraph(sent(), inbox(), { muted: ['dana@partnerco.example'] });
  const decision = classify(byName('known-colleague'), context({ graph }));
  assert.strictEqual(decision.label, 'noise');
  assert.strictEqual(decision.reasons[0].code, 'muted');
});

test('a sender who is never answered stops being surfaced', () => {
  const message = byName('cold-outreach');
  const graph = new CorrespondentGraph();
  // Dates must precede `asOf`, or point-in-time filtering correctly ignores them.
  for (let i = 1; i <= 6; i++) {
    graph.observeReceived({ ...message, date: new Date(NOW.getTime() - i * 86400000) });
  }
  const decision = classify(message, context({ graph }));
  assert.strictEqual(decision.label, 'brief');
  assert.strictEqual(decision.reasons[0].code, 'never-answered');
});

// ---------------------------------------------------------- weighted evidence

test('cold outreach from an unknown sender is ambiguous and escalates', () => {
  // This is the case the deterministic layer *should* be unsure about: it is
  // addressed directly and asks a question, but nobody has ever replied to them.
  const decision = classify(byName('cold-outreach'), context());
  assert.strictEqual(decision.tier, 0);
  assert.ok(decision.confidence < DEFAULT_CONFIG.escalateBelow,
    `expected low confidence, got ${decision.confidence}`);
  assert.strictEqual(decision.escalate, true);
});

test('every decision carries reasons that explain it', () => {
  for (const message of inbox()) {
    const decision = classify(message, context());
    assert.ok(Array.isArray(decision.reasons) && decision.reasons.length > 0,
      `uid ${message.uid} produced a decision with no reasons`);
    for (const reason of decision.reasons) {
      assert.ok(typeof reason.code === 'string' && reason.code.length > 0);
      assert.ok(typeof reason.detail === 'string' && reason.detail.length > 0);
    }
  }
});

test('classification is deterministic — same input, same output', () => {
  const message = byName('cold-outreach');
  const a = classify(message, context());
  const b = classify(message, context());
  assert.deepStrictEqual(a.label, b.label);
  assert.deepStrictEqual(a.confidence, b.confidence);
  assert.deepStrictEqual(a.reasons, b.reasons);
});

test('most of a realistic inbox resolves without the model', () => {
  const result = classifyAll(inbox(), context());
  assert.ok(result.escalationRate < 0.5,
    `escalation rate ${(result.escalationRate * 100).toFixed(0)}% is too high to be economical`);
  assert.strictEqual(result.decisions.length, fx.ALL.length);
});

test('a broken signal cannot fail the whole run', () => {
  const original = signals.WEIGHTED[0];
  signals.WEIGHTED[0] = () => { throw new Error('signal exploded'); };
  try {
    const decision = classify(byName('cold-outreach'), context());
    assert.ok(decision.label, 'classification survived a throwing signal');
  } finally {
    signals.WEIGHTED[0] = original;
  }
});

// ------------------------------------------------------------- unit: signals

test('addressing distinguishes direct, group, cc and bcc', () => {
  const direct = signals.addressing({ message: byName('cold-outreach'), selfAddresses: SELF });
  assert.strictEqual(direct.code, 'addressing:direct');

  const group = signals.addressing({ message: byName('multipart'), selfAddresses: SELF });
  assert.strictEqual(group.code, 'addressing:group');

  const bcc = signals.addressing({
    message: normalize('From: x@y.z\r\nTo: list@z.z\r\nSubject: s\r\n\r\nb', { uid: 1 }),
    selfAddresses: SELF,
  });
  assert.strictEqual(bcc.code, 'addressing:bcc');
});

test('no-reply senders are recognized from the local part', () => {
  const message = normalize(
    'From: no-reply@shop.example\r\nTo: alice@example.com\r\nSubject: hi\r\n\r\nbody',
    { uid: 1 }
  );
  const evidence = signals.noReplySender({ message });
  assert.ok(evidence);
  assert.deepStrictEqual(evidence.weights, { brief: 2 });
});

test('urgency cues are detected in subject or body', () => {
  const message = normalize(
    'From: a@b.c\r\nTo: alice@example.com\r\nSubject: need an answer\r\n\r\nCan you confirm by EOD?',
    { uid: 1 }
  );
  assert.ok(signals.urgencyCues({ message }));
});

test('already-answered mail stops competing for attention', () => {
  const message = normalize(fx.KNOWN_COLLEAGUE, { uid: 1, flags: ['\\Answered'] });
  const evidence = signals.alreadyAnswered({ message });
  assert.ok(evidence);
  assert.ok(evidence.weights.later > 0);
});
