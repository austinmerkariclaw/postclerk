'use strict';

const test = require('node:test');
const assert = require('node:assert');
const mime = require('../lib/mime');
const fx = require('./helpers/fixtures');

function headersOf(raw) {
  const split = raw.search(/\r?\n\r?\n/);
  return mime.parseHeaders(split === -1 ? raw : raw.slice(0, split));
}

test('unfolds folded headers before parsing', () => {
  const headers = mime.parseHeaders(
    'Subject: a very long subject\r\n that continues here\r\nFrom: x@y.z'
  );
  assert.strictEqual(mime.headerValue(headers, 'subject'), 'a very long subject that continues here');
  assert.strictEqual(mime.headerValue(headers, 'from'), 'x@y.z');
});

test('header lookup is case-insensitive and keeps repeats', () => {
  const headers = mime.parseHeaders('Received: one\r\nRECEIVED: two\r\nTo: a@b.c');
  assert.deepStrictEqual(mime.headerValues(headers, 'received'), ['one', 'two']);
  assert.strictEqual(mime.headerValue(headers, 'TO'), 'a@b.c');
});

test('decodes RFC 2047 base64 and quoted-printable encoded-words', () => {
  const headers = headersOf(fx.ENCODED);
  assert.strictEqual(
    mime.decodeWords(mime.headerValue(headers, 'subject')),
    'Re: Presupuesto para el próximo trimestre'
  );
  const from = mime.parseAddressList(mime.headerValue(headers, 'from'))[0];
  assert.strictEqual(from.name, 'José Martínez');
  assert.strictEqual(from.email, 'jose@example.es');
  assert.strictEqual(from.domain, 'example.es');
});

test('joins adjacent encoded-words without inserting the folding space', () => {
  // Two encoded-words separated by whitespace encode one continuous run.
  const decoded = mime.decodeWords('=?utf-8?Q?Hello?= =?utf-8?Q?World?=');
  assert.strictEqual(decoded, 'HelloWorld');
});

test('decodes quoted-printable bodies including soft line breaks', () => {
  const structure = mime.parseStructure(fx.ENCODED);
  const text = mime.bestText(structure);
  assert.match(text, /€42\.500/);
  assert.match(text, /—/);
  // The soft break (`=` at end of line) must join, not leave a stray '='.
  assert.match(text, /un poco más de lo previsto/);
  assert.ok(!text.includes('=\n'), 'soft line break was not consumed');
});

test('multipart: prefers text/plain and names attachments without parsing them', () => {
  const structure = mime.parseStructure(fx.MULTIPART);
  assert.match(structure.text, /Revenue up 12% QoQ/);
  assert.strictEqual(structure.attachments.length, 1);
  assert.strictEqual(structure.attachments[0].filename, 'q3.xlsx');
  assert.strictEqual(structure.attachments[0].contentType, 'application/vnd.ms-excel');
});

test('html-only mail falls back to a text rendering', () => {
  const structure = mime.parseStructure(fx.HTML_ONLY);
  const text = mime.bestText(structure);
  assert.match(text, /Order #7781 shipped/);
  assert.match(text, /Track it & relax — arriving Tuesday/);
  assert.ok(!/color:red/.test(text), 'style contents leaked into text');
  assert.ok(!/track\(\)/.test(text), 'script contents leaked into text');
});

test('parses address lists with commas inside quoted display names', () => {
  const list = mime.parseAddressList('"Whitfield, Dana" <dana@x.example>, bob@y.example');
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].name, 'Whitfield, Dana');
  assert.strictEqual(list[0].email, 'dana@x.example');
  assert.strictEqual(list[1].email, 'bob@y.example');
});

test('content-type parameters are split correctly', () => {
  const parsed = mime.parseParams('multipart/mixed; boundary="a;b"; charset=utf-8');
  assert.strictEqual(parsed.value, 'multipart/mixed');
  assert.strictEqual(parsed.params.boundary, 'a;b');
  assert.strictEqual(parsed.params.charset, 'utf-8');
});

test('thread key resolves to the root of the References chain', () => {
  const headers = headersOf(fx.KNOWN_COLLEAGUE);
  const key = mime.threadKeyOf(headers, '<dana-88213@partnerco.example>');
  assert.strictEqual(key, '<alice-77001@example.com>');
});

test('thread key falls back to the message id when there is no chain', () => {
  const headers = headersOf(fx.COLD_OUTREACH);
  const key = mime.threadKeyOf(headers, '<outreach-55012@growthsaas.example>');
  assert.strictEqual(key, '<outreach-55012@growthsaas.example>');
});

test('malformed mail parses without throwing', () => {
  // Real inboxes contain mail that violates the RFCs. Tolerance is a feature.
  assert.doesNotThrow(() => {
    const structure = mime.parseStructure(fx.MALFORMED);
    mime.bestText(structure);
    const headers = headersOf(fx.MALFORMED);
    mime.parseAddressList(mime.headerValue(headers, 'from'));
  });
});

test('every fixture parses to something usable', () => {
  for (const { name, raw } of fx.ALL) {
    const structure = mime.parseStructure(raw);
    assert.ok(structure && typeof structure.text === 'string', `${name} produced no structure`);
  }
});

test('bounded against a hostile multipart bomb', () => {
  // A message that nests boundaries far past our depth limit must terminate.
  let bomb = 'Content-Type: text/plain\r\n\r\ninner';
  for (let i = 0; i < 40; i++) {
    bomb = `Content-Type: multipart/mixed; boundary="B${i}"\r\n\r\n--B${i}\r\n${bomb}\r\n--B${i}--`;
  }
  const started = Date.now();
  assert.doesNotThrow(() => mime.parseStructure(bomb));
  assert.ok(Date.now() - started < 2000, 'nested multipart parsing did not terminate promptly');
});
