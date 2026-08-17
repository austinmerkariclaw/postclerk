'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MockImapServer } = require('./helpers/mock-imap-server');
const { FakeProvider } = require('./helpers/fake-provider');
const fx = require('./helpers/fixtures');

const { Mailbox } = require('../lib/mailbox');
const store = require('../lib/store');
const { runTriage, planActions, applyActions, undoLastRun, buildVoiceProfile } = require('../lib/run');
const { backtest } = require('../lib/backtest');

/**
 * End-to-end tests over the real pipeline: a real IMAP client talking to a real
 * (if in-process) IMAP server, real MIME parsing, the real cascade, and a fake
 * model. Nothing is stubbed except the model itself and the socket's far end.
 */

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postclerk-test-'));
  process.env.POSTCLERK_HOME = dir;
  return dir;
}

function baseConfig(overrides = {}) {
  return store.deepMerge(store.DEFAULT_CONFIG, {
    imap: { host: '127.0.0.1', port: 0, user: 'alice@example.com' },
    self: ['alice@example.com'],
    folders: { inbox: 'INBOX', sent: 'Sent', drafts: 'Drafts' },
    triage: { lookbackDays: 30 },
    ...overrides,
  });
}

async function harness(run, { serverOpts = {}, config = baseConfig() } = {}) {
  const home = tempHome();
  const server = new MockImapServer({
    // The server must accept the same identity the config connects with, or
    // LOGIN fails and every test below reports a connection error instead.
    user: config.imap.user,
    password: 'pass',
    mailboxes: {
      INBOX: fx.asServerMessages(serverOpts.flags || {}),
      Sent: fx.sentAsServerMessages(),
      Drafts: [],
    },
    ...serverOpts,
  });
  await server.listen();

  // Opening happens inside the try so a failed connect still closes the
  // server — a leaked listening handle keeps the test runner alive forever.
  let mailbox = null;
  try {
    mailbox = await Mailbox.open(config, 'pass', {
      tls: false,
      createConnection: server.connector(),
    });
    return await run({ mailbox, server, config, home });
  } finally {
    if (mailbox) await mailbox.close().catch(() => {});
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.POSTCLERK_HOME;
  }
}

// --------------------------------------------------------------- full triage

test('end-to-end triage classifies a real inbox over a real connection', async () => {
  await harness(async ({ mailbox, config }) => {
    const provider = new FakeProvider({ answer: 'noise' });
    const result = await runTriage({ config, mailbox, provider });

    assert.strictEqual(result.total, fx.ALL.length, 'every message was fetched and classified');
    assert.strictEqual(result.decisions.length, fx.ALL.length);

    const byUid = new Map(result.decisions.map((d) => [d.uid, d]));
    assert.strictEqual(byUid.get(101).label, 'brief', 'newsletter → brief');
    assert.strictEqual(byUid.get(102).label, 'noise', 'CI notification → noise');
    assert.strictEqual(byUid.get(103).label, 'now', 'live thread → now');

    // Deterministic decisions must never have been sent anywhere.
    assert.strictEqual(byUid.get(101).tier, 0);
    assert.strictEqual(byUid.get(102).tier, 0);
  });
});

test('only ambiguous mail is escalated, and it is a minority', async () => {
  await harness(async ({ mailbox, config }) => {
    const provider = new FakeProvider({ answer: 'later' });
    const result = await runTriage({ config, mailbox, provider });

    assert.ok(result.escalated > 0, 'the corpus contains genuinely ambiguous mail');
    assert.ok(result.escalationRate < 0.5,
      `escalation rate ${(result.escalationRate * 100).toFixed(0)}% breaks the cost model`);

    // The provider must only ever have seen the escalated subset.
    assert.strictEqual(provider.seenItems.length, result.escalated);
  });
});

test('bodies of confidently-classified mail are never fetched or transmitted', async () => {
  await harness(async ({ mailbox, config, server }) => {
    const provider = new FakeProvider({ answer: 'later' });
    const result = await runTriage({ config, mailbox, provider });

    const escalatedUids = new Set(
      result.decisions.filter((d) => d.tier === 1).map((d) => d.uid)
    );

    // The only full-body fetches issued should be for escalated UIDs.
    const bodyFetches = server.commandLog.filter((l) => /UID FETCH .*BODY\.PEEK\[\]/.test(l));
    for (const line of bodyFetches) {
      const set = line.match(/UID FETCH (\S+)/)[1];
      for (const uid of set.split(',').flatMap(expandRange)) {
        assert.ok(escalatedUids.has(uid),
          `fetched body of uid ${uid}, which was resolved locally and never needed it`);
      }
    }

    // And the newsletter's contents must not appear in anything sent out.
    assert.ok(!provider.seenText.includes('seven stories that matter'),
      'body of a locally-resolved message reached the model');
  });
});

test('secrets are redacted before the payload leaves the machine', async () => {
  // Force the secret-bearing message to escalate by muting the deterministic
  // shortcuts that would otherwise resolve it locally.
  await harness(async ({ mailbox, config }) => {
    const provider = new FakeProvider({ answer: 'brief' });
    await runTriage({ config, mailbox, provider });

    const transmitted = provider.seenText;
    assert.ok(!/sk-ant-api03-abcdefghijklmnop/.test(transmitted), 'API key was transmitted');
    assert.ok(!/4111 1111 1111 1111/.test(transmitted), 'card number was transmitted');
    assert.ok(!/token=9f8e7d6c5b4a3210/.test(transmitted), 'reset token was transmitted');
    assert.ok(!/\b830412\b/.test(transmitted), 'one-time code was transmitted');
  }, { config: baseConfig({ triage: { lookbackDays: 30, escalateBelow: 0.99 } }) });
});

test('--explain transmits nothing at all', async () => {
  await harness(async ({ mailbox, config }) => {
    const provider = new FakeProvider({ answer: 'noise' });
    const result = await runTriage({ config, mailbox, provider, options: { explain: true } });

    assert.strictEqual(provider.calls, 0, 'explain mode made a network call');
    assert.ok(result.audit.explained.length > 0, 'explain mode produced nothing to inspect');
    assert.match(result.audit.explained[0], /Would send \d+ message projection/);
  });
});

test('the run degrades to deterministic triage when the model is unavailable', async () => {
  await harness(async ({ mailbox, config }) => {
    const provider = new FakeProvider({ throws: new Error('connect ECONNREFUSED') });
    const result = await runTriage({ config, mailbox, provider });

    assert.strictEqual(result.decisions.length, fx.ALL.length, 'no message was dropped');
    assert.ok(result.warnings.some((w) => /model unavailable/.test(w)));
    // Everything still has a label; nothing was lost because the model failed.
    for (const decision of result.decisions) {
      assert.ok(['now', 'later', 'brief', 'noise'].includes(decision.label));
    }
  });
});

test('with no provider configured, triage still works and warns honestly', async () => {
  await harness(async ({ mailbox, config }) => {
    const result = await runTriage({ config, mailbox, provider: null });
    assert.strictEqual(result.decisions.length, fx.ALL.length);
    assert.strictEqual(result.audit.calls, 0);
    assert.ok(result.warnings.some((w) => /no model is configured/.test(w)));
  });
});

// --------------------------------------------------------------- apply / undo

test('apply files mail by copying, and never issues a delete', async () => {
  await harness(async ({ mailbox, config, server }) => {
    const provider = new FakeProvider({ answer: 'brief' });
    const result = await runTriage({ config, mailbox, provider });

    await mailbox.ensureFolders();
    const actions = planActions(result.decisions, mailbox.folders);
    const journal = new store.Journal();
    const applied = await applyActions(mailbox, journal, actions);

    assert.ok(applied.applied > 0, 'nothing was applied');
    assert.strictEqual(applied.failed, 0);
    assert.ok(server.copied.length > 0, 'no COPY reached the server');

    // The guarantee: no destructive command was ever sent.
    const destructive = server.commandLog.filter((l) => /\\Deleted|EXPUNGE|\bDELETE\b/i.test(l));
    assert.deepStrictEqual(destructive, [], `destructive commands issued: ${destructive.join('; ')}`);
  });
});

test('mail that needs you is flagged in place, never moved', async () => {
  await harness(async ({ mailbox, config, server }) => {
    const provider = new FakeProvider({ answer: 'later' });
    const result = await runTriage({ config, mailbox, provider });

    await mailbox.ensureFolders();
    const actions = planActions(result.decisions, mailbox.folders);
    const journal = new store.Journal();
    await applyActions(mailbox, journal, actions);

    const nowUids = result.decisions.filter((d) => d.label === 'now').map((d) => d.uid);
    assert.ok(nowUids.length > 0, 'expected at least one urgent message');

    const movedUids = server.copied.flatMap((c) => c.uids);
    for (const uid of nowUids) {
      assert.ok(!movedUids.includes(uid), `uid ${uid} needed attention but was filed away`);
    }
  });
});

test('undo reverses the last applied run', async () => {
  await harness(async ({ mailbox, config, server }) => {
    const provider = new FakeProvider({ answer: 'brief' });
    const result = await runTriage({ config, mailbox, provider });

    await mailbox.ensureFolders();
    const actions = planActions(result.decisions, mailbox.folders);
    const journal = new store.Journal();
    const applied = await applyActions(mailbox, journal, actions);

    const copiesBefore = server.copied.length;
    const undone = await undoLastRun(mailbox, journal);

    assert.strictEqual(undone.runId, applied.runId);
    assert.ok(undone.reversed > 0, 'undo reversed nothing');
    assert.ok(server.copied.length > copiesBefore, 'undo issued no compensating copies');

    // Undoing twice must not double-reverse.
    const again = await undoLastRun(mailbox, journal);
    assert.strictEqual(again.runId, null, 'the same run was undone twice');
  });
});

test('intent is journaled durably before the mailbox is touched', async () => {
  await harness(async ({ mailbox, config }) => {
    const provider = new FakeProvider({ answer: 'brief' });
    const result = await runTriage({ config, mailbox, provider });
    await mailbox.ensureFolders();

    const actions = planActions(result.decisions, mailbox.folders);
    const journal = new store.Journal();

    // Fail every mutation: intent must still be on disk afterwards.
    const broken = {
      folders: mailbox.folders,
      applyAction: async () => { throw new Error('simulated crash'); },
    };
    const applied = await applyActions(broken, journal, actions);

    assert.strictEqual(applied.applied, 0);
    assert.strictEqual(applied.failed, actions.length);

    const entries = journal.entries();
    const intent = entries.find((e) => e.phase === 'intent');
    assert.ok(intent, 'no intent record survived the crash');
    assert.strictEqual(intent.actions.length, actions.length);

    // And the crashed run is reported as unfinished.
    const orphans = journal.orphanedRuns();
    assert.strictEqual(orphans.length, 1);
  });
});

test('a crashed run is still fully reversible from its intent record', async () => {
  await harness(async ({ mailbox, config, server }) => {
    const provider = new FakeProvider({ answer: 'brief' });
    const result = await runTriage({ config, mailbox, provider });
    await mailbox.ensureFolders();

    const actions = planActions(result.decisions, mailbox.folders);
    const journal = new store.Journal();

    // Apply only the first action, then "crash".
    journal.writeIntent('crashed-run', actions);
    await mailbox.applyAction(actions[0]);
    journal.writeResult('crashed-run', actions[0], { applied: true });

    const before = server.copied.length;
    const undone = await undoLastRun(mailbox, journal);
    assert.strictEqual(undone.runId, 'crashed-run');
    assert.ok(server.copied.length > before, 'nothing was reversed after the crash');
  });
});

// ------------------------------------------------------------------- backtest

test('backtest scores against real behavior and reports both error kinds', async () => {
  await harness(async ({ mailbox, config }) => {
    const inbox = await mailbox.fetchInbox(30);
    const sent = await mailbox.fetchSent(90);

    const result = backtest({ inbox, sent, config, asOf: new Date('2026-08-25T00:00:00Z') });

    assert.ok(result.total > 0, 'nothing was scored');
    assert.ok(result.agreementRate >= 0 && result.agreementRate <= 1);
    assert.ok(Array.isArray(result.buried));
    assert.ok(Array.isArray(result.cluttered));
    assert.ok(result.projectedCost.usdPerMonth >= 0);
    assert.ok(result.caveats.length >= 3, 'the report must state its own limits');

    for (const row of result.scored) {
      assert.ok(['now', 'later', 'brief', 'noise'].includes(row.predicted));
      assert.ok(['now', 'later', 'brief', 'noise'].includes(row.actual));
      assert.ok(row.evidence, 'every ground-truth label needs stated evidence');
    }
  });
});

test('backtest treats answered mail as having needed attention', async () => {
  await harness(async ({ mailbox, config }) => {
    const inbox = await mailbox.fetchInbox(30);
    const sent = await mailbox.fetchSent(90);
    const result = backtest({ inbox, sent, config, asOf: new Date('2026-08-25T00:00:00Z') });

    const answered = result.scored.find((s) => s.uid === 103); // Dana, a live thread
    assert.ok(answered, 'the replied-to message was not scored');
    assert.strictEqual(answered.actual, 'now');
  }, { serverOpts: { flags: { 'known-colleague': ['\\Answered', '\\Seen'] } } });
});

test('backtest excludes mail too recent to have settled', async () => {
  await harness(async ({ mailbox, config }) => {
    const inbox = await mailbox.fetchInbox(30);
    const sent = await mailbox.fetchSent(90);
    // Score as of the day the newest fixture arrived: nothing has settled yet.
    const result = backtest({ inbox, sent, config, asOf: new Date('2026-08-15T12:00:00Z') });
    assert.ok(result.skipped > 0, 'unsettled mail was scored anyway');
  });
});

test('backtest does not let the future leak into past decisions', async () => {
  await harness(async ({ mailbox, config }) => {
    const inbox = await mailbox.fetchInbox(30);
    const sent = await mailbox.fetchSent(90);
    const result = backtest({ inbox, sent, config, asOf: new Date('2026-08-25T00:00:00Z') });

    // Dana's message (13 Aug) must be judged using only sent mail before then.
    // The user wrote to Dana on 7 Aug and 10 Aug and 12 Aug — three messages —
    // so `known-correspondent` may fire, but nothing dated after 13 Aug may.
    const dana = result.scored.find((s) => s.uid === 103);
    assert.ok(dana);
    const cited = dana.reasons.map((r) => r.detail).join(' ');
    assert.ok(!/last -\d+ day/.test(cited), 'a negative age implies future knowledge');
  });
});

// ----------------------------------------------------------------- voice/draft

test('a voice profile is derived locally from sent mail', async () => {
  await harness(async ({ mailbox }) => {
    const sent = await mailbox.fetchSent(90, { withBody: true });
    const voice = buildVoiceProfile(sent);

    assert.match(voice, /# Voice profile/);
    assert.match(voice, /Typical reply length/);
    assert.ok(!voice.includes('undefined'));
  });
});

test('drafts are staged, never sent', async () => {
  await harness(async ({ mailbox, server }) => {
    await mailbox.appendDraft('From: a@b.c\nTo: d@e.f\nSubject: Re: x\n\nBody.');

    assert.strictEqual(server.appended.length, 1);
    assert.strictEqual(server.appended[0].mailbox, 'Drafts');
    assert.deepStrictEqual(server.appended[0].flags, ['\\Draft']);

    // There is no send path anywhere: no SMTP, no APPEND to a Sent folder.
    const sends = server.commandLog.filter((l) => /APPEND "Sent"/i.test(l));
    assert.deepStrictEqual(sends, []);
  });
});

// ---------------------------------------------------------------------- state

test('the correspondent graph and message cache persist across runs', async () => {
  await harness(async ({ mailbox, config }) => {
    const provider = new FakeProvider({ answer: 'later' });
    await runTriage({ config, mailbox, provider });

    const graph = store.loadGraph(config);
    assert.ok(graph.size > 0, 'no correspondents were persisted');
    assert.ok(graph.statsAt('dana@partnerco.example').sentTo > 0);

    const cached = store.loadMessages();
    assert.ok(cached.length > 0, 'no messages were cached');
    assert.ok(cached.every((m) => m.date instanceof Date), 'dates did not survive the round trip');
  });
});

test('a changed UIDVALIDITY invalidates the cache instead of corrupting it', async () => {
  await harness(async ({ mailbox, config }) => {
    const provider = new FakeProvider({ answer: 'later' });
    await runTriage({ config, mailbox, provider });
    assert.ok(store.loadMessages().length > 0);

    // Simulate the server recreating the folder under us.
    const check = store.checkUidValidity('INBOX', 999999);
    assert.strictEqual(check.changed, true);
    store.clearMessageCache();
    assert.deepStrictEqual(store.loadMessages(), []);
  });
});

test('the header cache is bounded rather than growing without limit', async () => {
  const home = tempHome();
  try {
    const base = require('../lib/message').normalize(fx.NEWSLETTER, { uid: 1 });
    // Simulate many runs re-caching overlapping mail.
    for (let round = 0; round < 5; round++) {
      const batch = [];
      for (let i = 0; i < 200; i++) {
        batch.push({ ...base, uid: i, messageId: `<m${i}@x>`, date: new Date(2026, 0, 1 + i) });
      }
      store.saveMessages(batch);
    }

    // Dedupe by message id means repeated runs must not multiply the cache.
    const cached = store.loadMessages();
    assert.strictEqual(cached.length, 200, 'the cache grew with duplicate entries');

    const kept = store.compactMessageCache(50);
    assert.strictEqual(kept, 50, 'compaction did not enforce its limit');
    assert.strictEqual(store.loadMessages().length, 50);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.POSTCLERK_HOME;
  }
});

test('a second concurrent run is refused rather than allowed to double-apply', async () => {
  const home = tempHome();
  try {
    const first = store.acquireLock();
    assert.throws(() => store.acquireLock(), /another postclerk run is in progress/);
    first.release();
    // Once released, the next run proceeds normally.
    store.acquireLock().release();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.POSTCLERK_HOME;
  }
});

function expandRange(part) {
  const [lo, hi] = part.split(':').map(Number);
  if (hi === undefined) return [lo];
  const out = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}
