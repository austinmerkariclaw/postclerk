'use strict';

/**
 * IMAP response parsing (RFC 3501).
 *
 * The one thing that makes IMAP harder than it looks: literals. A response can
 * say `{412}` and then 412 raw bytes follow — bytes that may themselves contain
 * CRLF, parentheses, or quotes. So you cannot parse IMAP line-by-line, and any
 * implementation that splits on CRLF is quietly broken on real mail.
 *
 * Everything here works on Buffers and is bounded: the input is a remote server.
 */

const LIMITS = {
  /** Largest single literal we will accept. Bigger, and we skip the message. */
  literalBytes: 8 * 1024 * 1024,
  /** Largest line before a literal marker. Guards against an endless "line". */
  lineBytes: 128 * 1024,
  /** Deepest parenthesized nesting. Real responses use ~4. */
  depth: 32,
};

class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/**
 * Try to carve one complete response off the front of `buf`.
 *
 * A response ends at the first CRLF that is *not* preceded by a literal marker.
 * When a line ends with `{N}` we consume N further bytes and keep going, since
 * the response continues after the literal.
 *
 * @returns {{ response: Buffer, rest: Buffer } | null} null = need more bytes
 */
function readResponse(buf) {
  let searchFrom = 0;

  for (;;) {
    const crlf = indexOfCRLF(buf, searchFrom);
    if (crlf === -1) {
      if (buf.length - searchFrom > LIMITS.lineBytes) {
        throw new ProtocolError('response line exceeded limit without CRLF');
      }
      return null;
    }

    const literalSize = literalAtEnd(buf, searchFrom, crlf);
    if (literalSize === null) {
      return { response: buf.subarray(0, crlf), rest: buf.subarray(crlf + 2) };
    }
    if (literalSize > LIMITS.literalBytes) {
      throw new ProtocolError(`literal of ${literalSize} bytes exceeds limit`);
    }

    const literalEnd = crlf + 2 + literalSize;
    if (buf.length < literalEnd) return null; // literal not fully arrived
    searchFrom = literalEnd;
  }
}

function indexOfCRLF(buf, from) {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
}

/**
 * If the segment ending at `end` finishes with a literal marker `{N}` or
 * `{N+}`, return N. Otherwise null.
 */
function literalAtEnd(buf, start, end) {
  if (end <= start || buf[end - 1] !== 0x7d /* } */) return null;
  let i = end - 2;
  if (buf[i] === 0x2b /* + */) i--; // LITERAL+ non-synchronizing form
  let digits = '';
  while (i >= start && buf[i] >= 0x30 && buf[i] <= 0x39) {
    digits = String.fromCharCode(buf[i]) + digits;
    i--;
  }
  if (!digits || i < start || buf[i] !== 0x7b /* { */) return null;
  return Number(digits);
}

/**
 * Parse a response body into JS values.
 *
 * atoms/quoted/literals → string (NIL → null), parenthesized groups → array.
 * That is all the shape any command in this client needs.
 */
function parseTokens(buf) {
  let i = 0;

  function skipSpace() {
    while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x0d || buf[i] === 0x0a)) i++;
  }

  function parseValue(depth) {
    if (depth > LIMITS.depth) throw new ProtocolError('response nesting too deep');
    skipSpace();
    if (i >= buf.length) return undefined;

    const ch = buf[i];
    if (ch === 0x28 /* ( */) return parseList(depth);
    if (ch === 0x22 /* " */) return parseQuoted();
    if (ch === 0x7b /* { */) return parseLiteral();
    return parseAtom();
  }

  function parseList(depth) {
    i++; // consume '('
    const out = [];
    for (;;) {
      skipSpace();
      if (i >= buf.length) throw new ProtocolError('unterminated list');
      if (buf[i] === 0x29 /* ) */) { i++; return out; }
      const before = i;
      out.push(parseValue(depth + 1));
      if (i === before) throw new ProtocolError('list parser made no progress');
    }
  }

  function parseQuoted() {
    i++; // consume opening quote
    const bytes = [];
    while (i < buf.length) {
      const ch = buf[i];
      if (ch === 0x5c /* \ */ && i + 1 < buf.length) {
        bytes.push(buf[i + 1]);
        i += 2;
        continue;
      }
      if (ch === 0x22 /* " */) { i++; return Buffer.from(bytes).toString('utf8'); }
      bytes.push(ch);
      i++;
    }
    throw new ProtocolError('unterminated quoted string');
  }

  function parseLiteral() {
    const close = buf.indexOf(0x7d /* } */, i);
    if (close === -1) throw new ProtocolError('unterminated literal marker');
    const size = Number(buf.subarray(i + 1, close).toString('ascii').replace('+', ''));
    if (!Number.isFinite(size) || size < 0) throw new ProtocolError('bad literal size');
    let start = close + 1;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const end = Math.min(start + size, buf.length);
    const value = buf.subarray(start, end).toString('binary');
    i = end;
    return value;
  }

  function parseAtom() {
    const start = i;
    while (i < buf.length) {
      const ch = buf[i];
      if (ch === 0x20 || ch === 0x28 || ch === 0x29 || ch === 0x0d || ch === 0x0a) break;
      // BODY[HEADER.FIELDS (FROM TO)] is a single atom whose brackets enclose
      // spaces and parens. Consume to the matching ']' rather than splitting.
      if (ch === 0x5b /* [ */) {
        let depth = 1;
        i++;
        while (i < buf.length && depth > 0) {
          if (buf[i] === 0x5b) depth++;
          else if (buf[i] === 0x5d /* ] */) depth--;
          i++;
        }
        continue;
      }
      i++;
    }
    const atom = buf.subarray(start, i).toString('utf8');
    return /^nil$/i.test(atom) ? null : atom;
  }

  const values = [];
  for (;;) {
    skipSpace();
    if (i >= buf.length) break;
    const before = i;
    values.push(parseValue(0));
    if (i === before) { i++; } // never spin on an unexpected byte
  }
  return values;
}

/**
 * Classify a response line.
 *   `* 12 FETCH (...)`  → { kind: 'untagged', ... }
 *   `a003 OK done`      → { kind: 'tagged', tag: 'a003', status: 'OK' }
 *   `+ go ahead`        → { kind: 'continuation' }
 */
function classify(response) {
  const head = response.subarray(0, Math.min(64, response.length)).toString('ascii');

  if (head.startsWith('+')) {
    return { kind: 'continuation', text: response.subarray(1).toString('utf8').trim() };
  }
  if (head.startsWith('* ')) {
    const tokens = parseTokens(response.subarray(2));
    return { kind: 'untagged', tokens, raw: response };
  }
  const space = head.indexOf(' ');
  if (space === -1) return { kind: 'unknown', raw: response };

  const tag = head.slice(0, space);
  const rest = response.subarray(space + 1);
  const statusMatch = rest.subarray(0, 8).toString('ascii').match(/^(OK|NO|BAD)\b/i);
  if (!statusMatch) return { kind: 'unknown', raw: response };

  return {
    kind: 'tagged',
    tag,
    status: statusMatch[1].toUpperCase(),
    text: rest.subarray(statusMatch[1].length).toString('utf8').trim(),
    raw: response,
  };
}

/**
 * Turn a FETCH item list into an object.
 * `[ 'UID', '345', 'FLAGS', ['\\Seen'], 'BODY[HEADER]', '...' ]`
 *   → { uid: '345', flags: ['\\Seen'], 'body[header]': '...' }
 */
function fetchItemsToObject(items) {
  const out = {};
  if (!Array.isArray(items)) return out;
  for (let n = 0; n + 1 < items.length; n += 2) {
    const key = String(items[n] || '').toLowerCase();
    out[key] = items[n + 1];
  }
  return out;
}

/** Quote a string for use as an IMAP astring. */
function quote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

module.exports = {
  LIMITS,
  ProtocolError,
  readResponse,
  parseTokens,
  classify,
  fetchItemsToObject,
  literalAtEnd,
  indexOfCRLF,
  quote,
};
