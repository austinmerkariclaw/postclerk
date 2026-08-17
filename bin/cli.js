#!/usr/bin/env node
'use strict';

const store = require('../lib/store');
const report = require('../lib/report');
const { Mailbox } = require('../lib/mailbox');
const { createProvider } = require('../lib/llm');
const { projectBatch, explain } = require('../lib/llm/project');
const { classify, buildThreadIndex } = require('../lib/triage/cascade');
const { buildGraph } = require('../lib/triage/correspondents');
const { backtest } = require('../lib/backtest');
const {
  runTriage, planActions, applyActions, undoLastRun, buildVoiceProfile,
} = require('../lib/run');

const USAGE = `postclerk — a local-first AI chief of staff for your inbox

  Usage
    postclerk <command> [options]

  Commands
    init          Set up the mailbox connection and learn from your Sent folder
    doctor        Check configuration, connection, and unfinished runs
    triage        Classify your inbox            (dry run unless --apply)
    backtest      Score triage against what you actually did — run this first
    brief         Summarize low-priority mail
    draft <uid>   Draft a reply into your Drafts folder
    why <uid>     Explain one triage decision
    undo          Reverse the last applied run
    cost          Report what postclerk has spent

  Common options
    --days N      Days of mail to consider        (default: config lookbackDays)
    --apply       Actually change the mailbox     (default: dry run)
    --json        Machine-readable output
    --explain     Print exactly what would be sent to the model, and send nothing
    --home DIR    Use an alternate state directory

  Setup
    POSTCLERK_PASSWORD    your mailbox app password (required)
    ANTHROPIC_API_KEY     only if llm.provider is "anthropic"

  postclerk never deletes mail. Every change is journaled and reversible.
`;

// ------------------------------------------------------------------ arg parse

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { args._.push(token); continue; }
    const [name, inline] = token.slice(2).split('=');
    const next = argv[i + 1];
    if (inline !== undefined) { args.flags[name] = inline; continue; }
    if (next !== undefined && !next.startsWith('--')) { args.flags[name] = next; i++; continue; }
    args.flags[name] = true;
  }
  return args;
}

function fail(message, code = 1) {
  process.stderr.write(`${report.red('error')} ${message}\n`);
  process.exit(code);
}

// -------------------------------------------------------------------- helpers

async function withMailbox(config, fn) {
  const password = store.resolvePassword(config);
  const mailbox = await Mailbox.open(config, password);
  try {
    return await fn(mailbox);
  } finally {
    await mailbox.close().catch(() => {});
  }
}

function providerFor(config) {
  try {
    return createProvider({ ...config.llm });
  } catch (err) {
    process.stderr.write(`${report.yellow('warning')} ${err.message}\n`);
    return createProvider({ provider: 'none' });
  }
}

function requireConfigured(config) {
  if (!config.imap.host || !config.imap.user) {
    fail('not configured yet. Run: postclerk init --host <imap-host> --user <you@example.com>');
  }
}

// ------------------------------------------------------------------- commands

async function cmdInit(args) {
  const config = store.loadConfig();
  const flags = args.flags;

  if (flags.host) config.imap.host = String(flags.host);
  if (flags.port) config.imap.port = Number(flags.port);
  if (flags.user) config.imap.user = String(flags.user);
  if (flags['password-file']) config.imap.passwordFile = String(flags['password-file']);
  if (flags.provider) config.llm.provider = String(flags.provider);
  if (flags.model) config.llm.model = String(flags.model);
  if (config.imap.user && !config.self.includes(config.imap.user)) {
    config.self = [...new Set([...config.self, config.imap.user])];
  }

  requireConfigured(config);
  store.saveConfig(config);
  process.stdout.write(`${report.dim('config')}  ${store.paths().config}\n`);

  await withMailbox(config, async (mailbox) => {
    process.stdout.write(`${report.green('✓')} connected to ${config.imap.host} as ${config.imap.user}\n`);

    const folders = mailbox.folders;
    process.stdout.write(`${report.dim('folders')} sent=${folders.sent || '?'} drafts=${folders.drafts || '?'}\n`);
    if (!folders.sent) {
      process.stdout.write(`${report.yellow('warning')} no Sent folder detected — triage accuracy will be much lower.\n`);
      process.stdout.write(`${report.dim('        ')} set folders.sent in ${store.paths().config}\n`);
    }

    // Backfill the correspondent graph before the first triage. This is what
    // makes a new user's first run already warm rather than cold (ADR-004).
    const days = Number(args.flags.days) || 365;
    process.stdout.write(`${report.dim('learning')} reading up to ${days} days of Sent mail…\n`);

    const sent = await mailbox.fetchSent(days, { withBody: true });
    const inbox = await mailbox.fetchInbox(Math.min(days, 90));

    const graph = buildGraph(sent, inbox, { vips: config.rules.vips, muted: config.rules.muted });
    store.saveGraph(graph);
    store.saveMessages([...sent, ...inbox], { append: false });

    const voice = buildVoiceProfile(sent);
    store.saveVoice(voice);

    process.stdout.write(`${report.green('✓')} learned ${graph.size} correspondent(s) from ${sent.length} sent message(s)\n`);
    process.stdout.write(`${report.green('✓')} voice profile written to ${store.paths().voice}\n`);
    process.stdout.write('\n');
    process.stdout.write(`${report.bold('Next:')} see how it would have done on your real mail —\n`);
    process.stdout.write('  postclerk backtest --days 30\n\n');
  });
}

async function cmdDoctor(args) {
  const config = store.loadConfig();
  const p = store.paths();
  const out = [];

  out.push(`${report.dim('home')}     ${p.root}`);
  out.push(`${report.dim('config')}   ${config.imap.host ? report.green('ok') : report.red('not configured')}`);

  try {
    store.resolvePassword(config);
    out.push(`${report.dim('password')} ${report.green('resolved')}`);
  } catch (err) {
    out.push(`${report.dim('password')} ${report.red(err.message)}`);
  }

  const journal = new store.Journal();
  const orphans = journal.orphanedRuns();
  out.push(`${report.dim('journal')}  ${journal.runs().length} run(s), ` +
    (orphans.length ? report.yellow(`${orphans.length} unfinished`) : report.green('clean')));
  if (orphans.length) {
    out.push(report.dim(`         run "postclerk undo" to reverse the unfinished run`));
  }

  const provider = providerFor(config);
  out.push(`${report.dim('provider')} ${provider.name}` +
    (provider.name === 'none' ? report.dim(' (deterministic triage only)') : ''));

  process.stdout.write(`\n${out.join('\n')}\n`);

  if (config.imap.host) {
    try {
      await withMailbox(config, async (mailbox) => {
        process.stdout.write(`${report.dim('mailbox')}  ${report.green('connected')}\n`);
        const missing = ['later', 'brief', 'noise']
          .map((k) => mailbox.folders[k])
          .filter((name) => name && !mailbox.folders.available.includes(name));
        if (missing.length) {
          process.stdout.write(`${report.dim('folders')}  ${report.yellow(`missing: ${missing.join(', ')}`)}\n`);
          process.stdout.write(`${report.dim('        ')} they will be created on the first --apply run\n`);
        } else {
          process.stdout.write(`${report.dim('folders')}  ${report.green('all present')}\n`);
        }
      });
    } catch (err) {
      process.stdout.write(`${report.dim('mailbox')}  ${report.red(err.message)}\n`);
    }
  }
  process.stdout.write('\n');
}

async function cmdTriage(args) {
  const config = store.loadConfig();
  requireConfigured(config);

  if (args.flags.days) config.triage.lookbackDays = Number(args.flags.days);
  const apply = Boolean(args.flags.apply);
  const provider = args.flags.explain ? providerFor(config) : providerFor(config);

  const lock = apply ? store.acquireLock() : { release() {} };
  try {
    await withMailbox(config, async (mailbox) => {
      const result = await runTriage({
        config, mailbox, provider,
        options: { explain: Boolean(args.flags.explain) },
      });

      if (args.flags.explain) {
        const blocks = result.audit.explained || [];
        process.stdout.write(blocks.length
          ? `\n${blocks.join('\n\n')}\n\n`
          : `\n${report.dim('nothing would be sent — every message resolved locally.')}\n\n`);
        return;
      }

      if (args.flags.json) {
        process.stdout.write(`${JSON.stringify(serializeResult(result), null, 2)}\n`);
        return;
      }

      let applied = null;
      if (apply) {
        const created = await mailbox.ensureFolders();
        if (created.length) {
          process.stdout.write(`${report.dim('created')} ${created.join(', ')}\n`);
        }
        const actions = planActions(result.decisions, mailbox.folders);
        const journal = new store.Journal();
        applied = await applyActions(mailbox, journal, actions);
      }

      process.stdout.write(report.renderTriage(result, { dryRun: !apply, applied }));
    });
  } finally {
    lock.release();
  }
}

async function cmdBacktest(args) {
  const config = store.loadConfig();
  requireConfigured(config);

  const days = Number(args.flags.days) || 30;

  await withMailbox(config, async (mailbox) => {
    process.stdout.write(`${report.dim('reading')} ${days} days of mail…\n`);
    const inbox = await mailbox.fetchInbox(days);
    const sent = await mailbox.fetchSent(Math.max(days, 90));

    const result = backtest({ inbox, sent, config });

    if (args.flags.json) {
      const { scored, ...summary } = result;
      process.stdout.write(`${JSON.stringify(args.flags.full ? result : summary, null, 2)}\n`);
      return;
    }
    process.stdout.write(report.renderBacktest(result));
  });
}

async function cmdBrief(args) {
  const config = store.loadConfig();
  requireConfigured(config);
  if (args.flags.days) config.triage.lookbackDays = Number(args.flags.days);

  const provider = providerFor(config);

  await withMailbox(config, async (mailbox) => {
    const result = await runTriage({ config, mailbox, provider });
    const briefUids = result.decisions
      .filter((d) => d.label === 'brief')
      .map((d) => d.uid);

    if (!briefUids.length) {
      process.stdout.write(report.renderBrief('', { count: 0 }));
      return;
    }

    const bodies = await mailbox.fetchBodies(mailbox.folders.inbox, briefUids);
    const selfAddresses = config.self.length ? config.self : [config.imap.user];
    const batch = projectBatch(bodies, selfAddresses, { bodyChars: 900 });

    if (args.flags.explain) {
      process.stdout.write(`\n${explain(batch)}\n\n`);
      return;
    }

    const summary = await provider.summarize(batch);
    if (args.flags.json) {
      process.stdout.write(`${JSON.stringify({ count: briefUids.length, text: summary.text }, null, 2)}\n`);
      return;
    }
    process.stdout.write(report.renderBrief(summary.text, {
      count: briefUids.length,
      cost: summary.usage ? summary.usage.usd : 0,
    }));
  });
}

async function cmdDraft(args) {
  const config = store.loadConfig();
  requireConfigured(config);

  const uid = Number(args._[1]);
  if (!Number.isInteger(uid)) fail('usage: postclerk draft <uid> [--apply]');

  const provider = providerFor(config);
  if (provider.name === 'none') {
    fail('drafting needs a model. Set llm.provider to "anthropic" or "ollama" in ' + store.paths().config);
  }

  await withMailbox(config, async (mailbox) => {
    const [message] = await mailbox.fetchBodies(mailbox.folders.inbox, [uid]);
    if (!message) fail(`no message with uid ${uid} in ${mailbox.folders.inbox}`);

    const selfAddresses = config.self.length ? config.self : [config.imap.user];
    const batch = projectBatch([message], selfAddresses, { bodyChars: config.llm.bodyChars });

    if (args.flags.explain) {
      process.stdout.write(`\n${explain(batch)}\n\n`);
      return;
    }

    const voice = store.loadVoice();
    const drafted = await provider.draft(batch.items[0], voice);
    const raw = composeReply(message, drafted.body, config);

    process.stdout.write(`\n${report.dim('─'.repeat(72))}\n${raw}\n${report.dim('─'.repeat(72))}\n\n`);

    if (args.flags.apply) {
      const folder = await mailbox.appendDraft(raw);
      process.stdout.write(`${report.green('✓')} staged in ${folder} — review before sending\n\n`);
    } else {
      process.stdout.write(`${report.dim('dry run — stage it with:')} postclerk draft ${uid} --apply\n\n`);
    }
  });
}

function composeReply(message, body, config) {
  const to = message.replyTo.length ? message.replyTo[0] : message.from;
  const subject = /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`;
  const from = config.self[0] || config.imap.user;

  return [
    `From: ${from}`,
    `To: ${to.name ? `${to.name} <${to.email}>` : to.email}`,
    `Subject: ${subject}`,
    message.messageId ? `In-Reply-To: ${message.messageId}` : null,
    message.messageId ? `References: ${message.messageId}` : null,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].filter((line) => line !== null).join('\n');
}

async function cmdWhy(args) {
  const config = store.loadConfig();
  const uid = Number(args._[1]);
  if (!Number.isInteger(uid)) fail('usage: postclerk why <uid>');

  // Answered from the local cache, so `why` costs nothing and works offline.
  const cached = store.loadMessages();
  const message = cached.find((m) => m.uid === uid && m.folder !== 'Sent');
  if (!message) {
    fail(`uid ${uid} is not in the local cache. Run "postclerk triage" first.`);
  }

  const graph = store.loadGraph(config);
  const sent = cached.filter((m) => m.folder !== 'INBOX');
  const decision = classify(message, {
    graph,
    threadIndex: buildThreadIndex(sent),
    config: config.triage,
    selfAddresses: config.self.length ? config.self : [config.imap.user],
  });

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    return;
  }
  process.stdout.write(report.renderWhy(decision, message));
}

async function cmdUndo() {
  const config = store.loadConfig();
  requireConfigured(config);

  const lock = store.acquireLock();
  try {
    await withMailbox(config, async (mailbox) => {
      const journal = new store.Journal();
      const result = await undoLastRun(mailbox, journal);

      if (!result.runId) {
        process.stdout.write(`\n${report.dim('nothing to undo')}\n\n`);
        return;
      }
      process.stdout.write(`\n${report.green('✓')} ${result.message} from run ${result.runId}\n`);
      for (const failure of result.failures || []) {
        process.stdout.write(`${report.yellow('  !')} ${failure}\n`);
      }
      process.stdout.write('\n');
    });
  } finally {
    lock.release();
  }
}

async function cmdCost(args) {
  const journal = new store.Journal();
  const notes = journal.entries().filter((e) => e.phase === 'note' && e.type === 'cost');

  const totals = notes.reduce((acc, n) => ({
    usd: acc.usd + (n.usd || 0),
    input: acc.input + (n.input || 0),
    output: acc.output + (n.output || 0),
    calls: acc.calls + (n.calls || 0),
    runs: acc.runs + 1,
  }), { usd: 0, input: 0, output: 0, calls: 0, runs: 0 });

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(totals, null, 2)}\n`);
    return;
  }

  process.stdout.write(`\n${report.bold('postclerk spend')}\n\n`);
  if (totals.runs === 0) {
    process.stdout.write(`${report.dim('  no model calls recorded yet')}\n\n`);
    return;
  }
  process.stdout.write(`  runs      ${totals.runs}\n`);
  process.stdout.write(`  calls     ${totals.calls}\n`);
  process.stdout.write(`  tokens    ${totals.input} in / ${totals.output} out\n`);
  process.stdout.write(`  ${report.bold('total')}     ${report.money(totals.usd)}\n\n`);
}

function serializeResult(result) {
  return {
    total: result.total,
    escalated: result.escalated,
    escalationRate: result.escalationRate,
    provider: result.provider,
    cost: result.cost,
    audit: { ...result.audit, explained: undefined },
    warnings: result.warnings,
    decisions: result.decisions.map((d) => ({
      uid: d.uid,
      messageId: d.messageId,
      label: d.label,
      confidence: d.confidence,
      tier: d.tier,
      reasons: d.reasons.map((r) => ({ code: r.code, detail: r.detail })),
    })),
  };
}

// ----------------------------------------------------------------------- main

const COMMANDS = {
  init: cmdInit,
  doctor: cmdDoctor,
  triage: cmdTriage,
  backtest: cmdBacktest,
  brief: cmdBrief,
  draft: cmdDraft,
  why: cmdWhy,
  undo: cmdUndo,
  cost: cmdCost,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (args.flags.home) process.env.POSTCLERK_HOME = String(args.flags.home);

  if (!command || command === 'help' || args.flags.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (command === 'version' || args.flags.version) {
    process.stdout.write(`${require('../package.json').version}\n`);
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
    process.exit(1);
  }

  await handler(args);
}

main().catch((err) => {
  fail(err && err.message ? err.message : String(err));
});
