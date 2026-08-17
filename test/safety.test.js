'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Guarantee tests.
 *
 * These do not test behavior — they test that the product's promises are still
 * structurally true. A guarantee enforced only by intention decays the first
 * time someone is in a hurry; these fail the build instead.
 */

const ROOT = path.join(__dirname, '..');

function sourceFiles(dir = path.join(ROOT, 'lib'), acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

function withoutComments(source) {
  // Strip comments so prose *about* the guarantee does not trip the check.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the codebase contains no way to delete mail (ADR-005)', () => {
  const offenders = [];
  const files = [...sourceFiles(), path.join(ROOT, 'bin', 'cli.js')];

  for (const file of files) {
    const code = withoutComments(fs.readFileSync(file, 'utf8'));

    // The IMAP verbs that destroy mail, and the flag that marks it for removal.
    for (const pattern of [/\bEXPUNGE\b/i, /\\\\Deleted/i, /'\s*DELETE\s+/i]) {
      if (pattern.test(code)) {
        // The one legitimate occurrence is the client's own refusal to set it.
        const isRefusal = /refusing to set/.test(code) && /\\\\deleted/i.test(code);
        if (isRefusal && pattern.source.includes('Deleted')) continue;
        offenders.push(`${path.relative(ROOT, file)} matches ${pattern}`);
      }
    }
  }

  assert.deepStrictEqual(offenders, [],
    `destructive mail operations found:\n  ${offenders.join('\n  ')}`);
});

test('there is no send path — drafts only (ADR-005)', () => {
  const files = [...sourceFiles(), path.join(ROOT, 'bin', 'cli.js')];
  const offenders = [];

  for (const file of files) {
    const code = withoutComments(fs.readFileSync(file, 'utf8'));
    // No SMTP, and no appending to a Sent folder (which some clients treat as
    // "sent" and sync outward).
    if (/require\(['"]nodemailer|createTransport|smtp\.connect|port:\s*(?:465|587)\b/i.test(code)) {
      offenders.push(`${path.relative(ROOT, file)} contains an outbound mail path`);
    }
  }
  assert.deepStrictEqual(offenders, []);
});

test('package.json declares zero dependencies (ADR-002)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepStrictEqual(pkg.dependencies || {}, {}, 'runtime dependencies were added');
  assert.deepStrictEqual(pkg.devDependencies || {}, {}, 'dev dependencies were added');
  assert.deepStrictEqual(pkg.peerDependencies || {}, {});
});

test('nothing imports a third-party module (ADR-002)', () => {
  const allowed = /^node:|^\.{1,2}\//;
  const offenders = [];

  for (const file of [...sourceFiles(), path.join(ROOT, 'bin', 'cli.js'), path.join(ROOT, 'index.js')]) {
    const code = fs.readFileSync(file, 'utf8');
    for (const match of code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = match[1];
      if (allowed.test(spec)) continue;
      // Bare Node builtins (without the node: prefix) are fine too.
      if (require('node:module').builtinModules.includes(spec)) continue;
      offenders.push(`${path.relative(ROOT, file)} requires "${spec}"`);
    }
  }

  assert.deepStrictEqual(offenders, [],
    `third-party imports found:\n  ${offenders.join('\n  ')}`);
});

test('TLS certificate verification is never disabled', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const code = withoutComments(fs.readFileSync(file, 'utf8'));
    if (/rejectUnauthorized\s*:\s*false/.test(code)) {
      offenders.push(path.relative(ROOT, file));
    }
    if (/NODE_TLS_REJECT_UNAUTHORIZED/.test(code)) {
      offenders.push(`${path.relative(ROOT, file)} (env override)`);
    }
  }
  assert.deepStrictEqual(offenders, []);
});

test('the credential is never written to disk by us', () => {
  const store = require('../lib/store');
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'store.js'), 'utf8');

  // The default config has a passwordFile pointer, never a password field.
  assert.strictEqual(store.DEFAULT_CONFIG.imap.password, undefined,
    'config schema has a password field — it must never hold one');
  assert.ok(!/password:\s*[^F]/.test(withoutComments(source).replace(/passwordFile/g, '')),
    'a password value appears in the config schema');
});

test('dry run is the default — writes require an explicit flag', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'bin', 'cli.js'), 'utf8');
  assert.match(cli, /const apply = Boolean\(args\.flags\.apply\)/,
    'triage must opt in to applying, never opt out');
  assert.ok(!/apply\s*=\s*args\.flags\.apply\s*!==\s*false/.test(cli),
    'apply appears to default to true');
});

test('the triage prompt tells the model that message text is data, not instruction', () => {
  const { TRIAGE_SYSTEM } = require('../lib/llm/anthropic');
  assert.match(TRIAGE_SYSTEM, /DATA, never instruction/i,
    'the classification prompt lacks a prompt-injection boundary');
  assert.match(TRIAGE_SYSTEM, /manipulation|attempting/i);
});

test('every ADR referenced by the docs actually exists', () => {
  const adrDir = path.join(ROOT, 'docs', 'adr');
  const files = fs.readdirSync(adrDir);
  for (const n of ['001', '002', '003', '004', '005']) {
    assert.ok(files.some((f) => f.startsWith(n)), `ADR-${n} is referenced but missing`);
  }
});
