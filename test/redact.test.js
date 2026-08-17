'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { redact, luhn } = require('../lib/llm/redact');
const { projectBatch } = require('../lib/llm/project');
const { normalize } = require('../lib/message');
const fx = require('./helpers/fixtures');

/**
 * The redactor is a security control, so it gets tested like one: both that it
 * catches what it claims to, and that it does not catch so much that triage
 * stops working. Over-redaction is a real failure mode — a projection reduced
 * to [REDACTED] tells the model nothing.
 */

test('masks vendor-prefixed API keys', () => {
  const cases = [
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-123456789012-abcdefghijklmnop',
  ];
  for (const secret of cases) {
    const result = redact(`here is the key ${secret} use it`);
    assert.ok(!result.text.includes(secret), `did not mask ${secret}`);
    assert.ok(result.redactions.length > 0);
  }
});

test('masks bearer tokens and JWTs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnop';
  assert.ok(!redact(`Authorization: Bearer abcdef1234567890abcdef`).text.includes('abcdef1234567890'));
  assert.ok(!redact(`token ${jwt}`).text.includes(jwt));
});

test('masks credential-bearing URLs but leaves ordinary links alone', () => {
  const withToken = redact('Visit https://x.example/go?token=9f8e7d6c5b4a3210 now');
  assert.ok(!withToken.text.includes('9f8e7d6c5b4a3210'));

  const ordinary = redact('Visit https://x.example/blog/post-42 for details');
  assert.strictEqual(ordinary.redactions.length, 0, 'a plain URL was redacted');
  assert.ok(ordinary.text.includes('https://x.example/blog/post-42'));
});

test('masks one-time codes only when they are labeled as codes', () => {
  const code = redact('Your verification code is 830412. It expires soon.');
  assert.ok(!code.text.includes('830412'));
  // The label survives, so the model can still tell this is a transactional mail.
  assert.ok(/verification code/i.test(code.text));

  // A bare six-digit number is usually an invoice or a year, not a secret.
  const invoice = redact('Invoice 830412 has been paid in full.');
  assert.strictEqual(invoice.redactions.length, 0, 'a plain number was redacted');
});

test('masks card numbers that pass Luhn, and leaves other digit runs alone', () => {
  assert.ok(luhn('4111111111111111'), 'a valid test card should pass Luhn');
  assert.ok(!luhn('4111111111111112'), 'an invalid card should fail Luhn');

  const card = redact('Card on file: 4111 1111 1111 1111');
  assert.ok(!card.text.includes('4111 1111 1111 1111'));

  const orderNumber = redact('Order 1234567890123456 shipped');
  assert.strictEqual(orderNumber.redactions.length, 0,
    'a non-Luhn digit run was redacted — over-redaction hurts triage');
});

test('masks private key blocks entirely', () => {
  const key = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAvVGH1234567890',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const result = redact(`Here:\n${key}\nregards`);
  assert.ok(!result.text.includes('MIIEowIBAAKCAQEAvVGH'));
  assert.ok(result.text.includes('regards'), 'redaction consumed surrounding text');
});

test('leaves normal correspondence completely untouched', () => {
  const body = 'Thanks for the turnaround. One thing still open on section 4 — ' +
    'can we drop the exclusivity clause entirely? Need an answer by Friday.';
  const result = redact(body);
  assert.strictEqual(result.text, body);
  assert.strictEqual(result.redactions.length, 0);
});

test('the projection is redacted, bounded, and auditable', () => {
  const message = normalize(fx.WITH_SECRETS, { uid: 108 });
  const batch = projectBatch([message], ['alice@example.com'], { bodyChars: 2000 });

  const serialized = JSON.stringify(batch.items);
  assert.ok(!serialized.includes('830412'));
  assert.ok(!serialized.includes('sk-ant-api03-abcdefghijklmnop'));
  assert.ok(!serialized.includes('4111 1111 1111 1111'));

  assert.ok(batch.audit.redactions.length > 0, 'redactions were not reported');
  assert.strictEqual(batch.audit.bytes, Buffer.byteLength(batch.serialized, 'utf8'));
  assert.match(batch.audit.sha256, /^[0-9a-f]{64}$/, 'no verifiable hash of what was sent');
});

test('the projection truncates long bodies and says so', () => {
  const long = `From: a@b.c\r\nTo: alice@example.com\r\nSubject: long\r\n\r\n${'word '.repeat(2000)}`;
  const message = normalize(long, { uid: 1 });
  const batch = projectBatch([message], ['alice@example.com'], { bodyChars: 200 });

  assert.ok(batch.items[0].preview.length <= 200);
  assert.strictEqual(batch.items[0].truncated, true);
});

test('the same batch always produces the same hash', () => {
  const messages = [normalize(fx.COLD_OUTREACH, { uid: 104 })];
  const a = projectBatch(messages, ['alice@example.com']);
  const b = projectBatch(messages, ['alice@example.com']);
  assert.strictEqual(a.audit.sha256, b.audit.sha256,
    'egress audit is not reproducible, so it cannot be verified after the fact');
});
