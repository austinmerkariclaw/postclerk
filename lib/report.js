'use strict';

/**
 * Terminal rendering. No dependencies, so colour is hand-rolled and disabled
 * whenever output is piped or NO_COLOR is set.
 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));

const dim = c('2');
const bold = c('1');
const red = c('31');
const green = c('32');
const yellow = c('33');
const blue = c('36');

const LABEL_STYLE = {
  now: (t) => bold(red(t)),
  later: (t) => yellow(t),
  brief: (t) => blue(t),
  noise: (t) => dim(t),
};

function label(name) {
  return (LABEL_STYLE[name] || ((t) => t))(name.padEnd(5));
}

function money(usd) {
  if (!usd) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function pct(n) {
  return `${(n * 100).toFixed(0)}%`;
}

function truncate(text, width) {
  const s = String(text || '');
  return s.length <= width ? s : `${s.slice(0, width - 1)}…`;
}

// ------------------------------------------------------------------- triage

function renderTriage(result, { dryRun = true, applied = null } = {}) {
  const lines = [];
  const byLabel = { now: [], later: [], brief: [], noise: [] };
  const byUid = new Map(result.messages.map((m) => [m.uid, m]));

  for (const decision of result.decisions) {
    (byLabel[decision.label] || byLabel.later).push(decision);
  }

  lines.push('');
  lines.push(bold(`postclerk — ${result.total} message(s) in the last window`));
  lines.push('');

  for (const name of ['now', 'later', 'brief', 'noise']) {
    const group = byLabel[name];
    if (!group.length) continue;

    lines.push(`${label(name)} ${dim(`(${group.length})`)}`);
    for (const decision of group.slice(0, 20)) {
      const message = byUid.get(decision.uid);
      if (!message) continue;
      const sender = truncate(message.from.name || message.from.email, 24).padEnd(24);
      const subject = truncate(message.subject || '(no subject)', 52);
      const marker = decision.tier === 1 ? blue('~') : ' ';
      lines.push(`  ${marker} ${dim(sender)} ${subject}`);
    }
    if (group.length > 20) lines.push(dim(`     …and ${group.length - 20} more`));
    lines.push('');
  }

  lines.push(dim('─'.repeat(72)));
  lines.push(
    `${dim('resolved locally')} ${result.total - result.escalated}/${result.total} ` +
    `${dim(`(${pct(1 - result.escalationRate)})`)}   ` +
    `${dim('sent to model')} ${result.escalated} ${blue('~')}`
  );

  if (result.audit.calls > 0) {
    lines.push(
      `${dim('egress')} ${result.audit.calls} call(s), ${result.audit.bytesSent} bytes` +
      (result.audit.redactions.length
        ? dim(`, redacted ${result.audit.redactions.map((r) => `${r.rule}×${r.count}`).join(', ')}`)
        : dim(', nothing matched the secret patterns'))
    );
    lines.push(
      `${dim('cost')} ${money(result.cost.usd)} ` +
      dim(`(${result.cost.input} in / ${result.cost.output} out, ${result.provider})`)
    );
  } else if (result.provider === 'none') {
    lines.push(dim('egress   nothing left this machine (provider: none)'));
  }

  for (const warning of result.warnings) {
    lines.push(yellow(`warning  ${warning}`));
  }

  lines.push('');
  if (applied) {
    lines.push(green(`applied  ${applied.applied} action(s)` +
      (applied.failed ? red(`, ${applied.failed} failed`) : '')));
    lines.push(dim(`         undo with: postclerk undo`));
  } else if (dryRun) {
    const would = result.decisions.filter((d) => d.label !== 'now').length;
    lines.push(dim(`dry run  nothing was changed. ${would} message(s) would be filed.`));
    lines.push(dim(`         apply with: postclerk triage --apply`));
  }
  lines.push('');

  return lines.join('\n');
}

// ----------------------------------------------------------------- backtest

function renderBacktest(result) {
  const lines = [];

  lines.push('');
  lines.push(bold('postclerk backtest — scored against what you actually did'));
  lines.push('');

  if (result.total === 0) {
    lines.push(yellow('No messages old enough to score.'));
    lines.push(dim('Backtest needs mail that has had time to settle — try --days 30.'));
    lines.push('');
    return lines.join('\n');
  }

  const rate = result.agreementRate;
  const rateColor = rate >= 0.8 ? green : rate >= 0.6 ? yellow : red;
  lines.push(`  ${bold('Agreement')}  ${rateColor(pct(rate))} ` +
    dim(`(${result.agreed}/${result.total} messages)`));
  if (result.skipped) {
    lines.push(dim(`             ${result.skipped} skipped as too recent to have settled`));
  }
  lines.push('');

  lines.push(`  ${bold('Per label')}`);
  lines.push(dim('    label   predicted  actual  precision  recall'));
  for (const name of ['now', 'later', 'brief', 'noise']) {
    const s = result.perLabel[name];
    if (!s.predicted && !s.actual) continue;
    lines.push(
      `    ${label(name)} ${String(s.predicted).padStart(8)} ${String(s.actual).padStart(7)}` +
      `  ${(s.precision === null ? '   —' : pct(s.precision).padStart(8))}` +
      `  ${(s.recall === null ? '   —' : pct(s.recall).padStart(6))}`
    );
  }
  lines.push('');

  // The costly error, called out on its own.
  lines.push(`  ${bold('Errors that matter')}`);
  if (result.buried.length === 0) {
    lines.push(`    ${green('✓')} nothing important would have been buried`);
  } else {
    lines.push(`    ${red(`✗ ${result.buried.length} message(s) you answered would have been hidden`)}`);
    for (const item of result.buried.slice(0, 5)) {
      lines.push(dim(`        ${truncate(item.from, 28)}  ${truncate(item.subject, 40)}`));
      lines.push(dim(`          → predicted ${item.predicted} because ${item.topReason}`));
    }
    if (result.buried.length > 5) lines.push(dim(`        …and ${result.buried.length - 5} more`));
  }

  if (result.cluttered.length) {
    lines.push(`    ${yellow(`~ ${result.cluttered.length} message(s) surfaced that you ignored`)}`);
    for (const item of result.cluttered.slice(0, 3)) {
      lines.push(dim(`        ${truncate(item.from, 28)}  ${truncate(item.subject, 40)}`));
    }
  }
  lines.push('');

  const cost = result.projectedCost;
  lines.push(`  ${bold('Economics')}`);
  lines.push(`    escalated to model  ${result.escalated}/${result.total} ${dim(`(${pct(result.escalationRate)})`)}`);
  lines.push(`    projected cost      ${money(cost.usdPerMonth)}/month ${dim(`with ${cost.model}`)}`);
  lines.push(dim(`                        ${cost.note}`));
  lines.push('');

  lines.push(dim('  Caveats'));
  for (const caveat of result.caveats) lines.push(dim(`    ${caveat}`));
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------- why

function renderWhy(decision, message) {
  const lines = [];
  lines.push('');
  lines.push(bold(`${message.from.name || message.from.email}`));
  lines.push(`${message.subject || '(no subject)'}`);
  lines.push(dim(`uid ${message.uid} · ${message.date.toISOString()}`));
  lines.push('');
  lines.push(`  decision   ${label(decision.label).trim()} ` +
    dim(`(confidence ${decision.confidence.toFixed(2)}, tier ${decision.tier})`));
  lines.push('');
  lines.push('  because');

  for (const reason of decision.reasons) {
    const marker = reason.decisive ? green('●') : dim('○');
    const weight = reason.weight
      ? dim(` [${Object.entries(reason.weight).map(([l, w]) => `${l}+${w}`).join(' ')}]`)
      : '';
    lines.push(`    ${marker} ${reason.detail}${weight}`);
  }

  if (decision.scores) {
    lines.push('');
    lines.push(dim(`  scores     ${Object.entries(decision.scores)
      .map(([l, s]) => `${l}=${s.toFixed(1)}`).join('  ')}`));
  }
  lines.push('');
  return lines.join('\n');
}

// -------------------------------------------------------------------- brief

function renderBrief(text, meta = {}) {
  const lines = [];
  lines.push('');
  lines.push(bold(`Your brief — ${meta.count || 0} message(s)`));
  lines.push(dim(new Date().toLocaleString()));
  lines.push('');
  lines.push(text || dim('(nothing to report)'));
  lines.push('');
  if (meta.cost) lines.push(dim(`cost ${money(meta.cost)}`));
  return lines.join('\n');
}

module.exports = {
  renderTriage,
  renderBacktest,
  renderWhy,
  renderBrief,
  money,
  pct,
  dim, bold, red, green, yellow, blue,
};
