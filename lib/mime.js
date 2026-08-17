'use strict';

/**
 * Minimal MIME decoding — enough to triage mail, and no more.
 *
 * Scope is deliberately narrow (ADR-002): we decode headers and text bodies.
 * Attachments are named but never parsed. Refusing to open a PowerPoint is both
 * the safe choice and the one that keeps a zero-dependency decoder affordable.
 *
 * Every function here is pure and synchronous. Everything that reads from the
 * network is bounded, because the input is attacker-influenced by definition:
 * anyone can send you mail.
 */

/** Hard ceilings. Hostile or broken input must not exhaust memory. */
const LIMITS = {
  headerBytes: 256 * 1024,
  bodyBytes: 2 * 1024 * 1024,
  parts: 64,
  depth: 8,
  addresses: 256,
};

/**
 * RFC 5322 folding: a CRLF followed by whitespace is a continuation, not a
 * line break. Unfold before doing anything else or every long header lies.
 */
function unfold(text) {
  return text.replace(/\r?\n[ \t]+/g, ' ');
}

/**
 * Parse a header block into a case-insensitive multimap.
 * Repeated headers (Received, References) keep every occurrence.
 */
function parseHeaders(raw) {
  const headers = new Map();
  if (!raw) return headers;

  const block = unfold(String(raw).slice(0, LIMITS.headerBytes));
  for (const line of block.split(/\r?\n/)) {
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 1) continue; // not a header line; tolerate and skip
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers.get(name);
    if (existing === undefined) headers.set(name, value);
    else if (Array.isArray(existing)) existing.push(value);
    else headers.set(name, [existing, value]);
  }
  return headers;
}

/** First value of a possibly-repeated header. */
function headerValue(headers, name) {
  const v = headers.get(name.toLowerCase());
  return Array.isArray(v) ? v[0] : v === undefined ? '' : v;
}

/** All values of a possibly-repeated header. */
function headerValues(headers, name) {
  const v = headers.get(name.toLowerCase());
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Decode bytes in `charset` to a JS string.
 * TextDecoder covers the real-world long tail (ICU is bundled in modern Node);
 * unknown labels fall back to latin1, which never throws and never mojibakes
 * into an exception — the worst case is ugly text, which triage tolerates.
 */
function decodeBytes(buf, charset) {
  const label = String(charset || 'utf-8').toLowerCase().replace(/["']/g, '');
  try {
    return new TextDecoder(label, { fatal: false }).decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

/**
 * RFC 2047 encoded-words: =?charset?B?...?= and =?charset?Q?...?=
 * Subjects and display names from non-English senders are unreadable without
 * this, and unreadable subjects poison both triage and the digest.
 */
function decodeWords(input) {
  if (!input || input.indexOf('=?') === -1) return input || '';

  // Adjacent encoded-words separated only by whitespace encode a single run of
  // text; the whitespace between them is an artifact of folding, not content.
  const collapsed = String(input).replace(/(\?=)[ \t]+(=\?)/g, '$1$2');

  return collapsed.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (match, charset, encoding, text) => {
      try {
        if (encoding.toUpperCase() === 'B') {
          return decodeBytes(Buffer.from(text, 'base64'), charset);
        }
        // Q encoding is quoted-printable with '_' standing in for space.
        const bytes = qpToBuffer(text.replace(/_/g, ' '));
        return decodeBytes(bytes, charset);
      } catch {
        return match; // undecodable: show the raw token rather than dropping it
      }
    }
  );
}

/** Quoted-printable text → Buffer, honoring soft line breaks. */
function qpToBuffer(text) {
  const out = [];
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '=') {
      out.push(s.charCodeAt(i) & 0xff);
      continue;
    }
    const next = s.slice(i + 1, i + 3);
    if (/^\r?\n/.test(next) || next === '') {
      // Soft line break — consume it and emit nothing.
      i += next.startsWith('\r\n') ? 2 : 1;
      continue;
    }
    if (/^[0-9a-fA-F]{2}$/.test(next)) {
      out.push(parseInt(next, 16));
      i += 2;
    } else {
      out.push(0x3d); // stray '='; keep it literal
    }
  }
  return Buffer.from(out);
}

/** Decode a body part according to its Content-Transfer-Encoding. */
function decodeBody(raw, encoding, charset) {
  const enc = String(encoding || '7bit').toLowerCase().trim();
  const text = String(raw).slice(0, LIMITS.bodyBytes);
  if (enc === 'base64') {
    return decodeBytes(Buffer.from(text.replace(/\s+/g, ''), 'base64'), charset);
  }
  if (enc === 'quoted-printable') {
    return decodeBytes(qpToBuffer(text.replace(/\r\n/g, '\n')), charset);
  }
  return decodeBytes(Buffer.from(text, 'latin1'), charset);
}

/**
 * Split a header value into its main value and parameters.
 * `text/plain; charset="utf-8"` → { value: 'text/plain', params: { charset: 'utf-8' } }
 */
function parseParams(headerVal) {
  const raw = String(headerVal || '');
  const parts = splitRespectingQuotes(raw, ';');
  const value = (parts.shift() || '').trim().toLowerCase();
  const params = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1);
    }
    // RFC 2231 continuations (name*0, name*1) and charset-tagged (name*).
    params[key.replace(/\*\d*$/, '').replace(/\*$/, '')] = decodeWords(val);
  }
  return { value, params };
}

/** Split on `sep`, ignoring separators inside quotes or angle brackets. */
function splitRespectingQuotes(input, sep) {
  const out = [];
  let buf = '';
  let quoted = false;
  let angle = 0;
  let escaped = false;
  for (const ch of String(input)) {
    if (escaped) { buf += ch; escaped = false; continue; }
    if (ch === '\\') { buf += ch; escaped = true; continue; }
    if (ch === '"') { quoted = !quoted; buf += ch; continue; }
    if (!quoted && ch === '<') angle++;
    if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    if (ch === sep && !quoted && angle === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out;
}

/**
 * Parse an address list into { name, email, domain } records.
 * Tolerant by design: malformed addresses are common and are not a reason to
 * fail a run — an address we cannot parse simply carries no name.
 */
function parseAddressList(input) {
  if (!input) return [];
  const out = [];
  for (const chunk of splitRespectingQuotes(String(input), ',')) {
    const addr = parseAddress(chunk);
    if (addr) out.push(addr);
    if (out.length >= LIMITS.addresses) break;
  }
  return out;
}

function parseAddress(input) {
  const raw = String(input).trim();
  if (!raw) return null;

  let name = '';
  let email = '';

  const angle = raw.match(/^(.*?)<([^>]*)>\s*$/s);
  if (angle) {
    name = angle[1].trim();
    email = angle[2].trim();
  } else {
    email = raw;
  }

  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
    name = name.slice(1, -1);
  }
  name = decodeWords(name).replace(/\\(.)/g, '$1').trim();

  email = email.replace(/^mailto:/i, '').trim().toLowerCase();
  if (!email || email.indexOf('@') === -1) {
    // Group syntax ("Team:;") and bare tokens land here. Keep the label as a
    // name so the digest can still say who it was addressed to.
    return email || name ? { name: name || raw.trim(), email: '', domain: '' } : null;
  }

  const domain = email.slice(email.lastIndexOf('@') + 1);
  return { name, email, domain };
}

/** Very small HTML → text reducer, for mail with no text/plain alternative. */
function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * Walk a MIME message and pull out text and attachment names.
 * Returns { text, html, attachments }.
 */
function parseStructure(rawMessage, depth = 0) {
  const empty = { text: '', html: '', attachments: [] };
  if (depth > LIMITS.depth) return empty;

  const source = String(rawMessage || '');
  const split = source.search(/\r?\n\r?\n/);
  const headerPart = split === -1 ? source : source.slice(0, split);
  const bodyPart = split === -1 ? '' : source.slice(split).replace(/^\r?\n\r?\n/, '');

  const headers = parseHeaders(headerPart);
  const contentType = parseParams(headerValue(headers, 'content-type') || 'text/plain');
  const encoding = headerValue(headers, 'content-transfer-encoding');
  const disposition = parseParams(headerValue(headers, 'content-disposition'));

  // A named part with an attachment disposition is cargo. Record it, don't open it.
  const filename = disposition.params.filename || contentType.params.name;
  if (disposition.value === 'attachment' || (filename && !contentType.value.startsWith('text/'))) {
    return {
      text: '',
      html: '',
      attachments: [{
        filename: filename || '(unnamed)',
        contentType: contentType.value || 'application/octet-stream',
        size: bodyPart.length,
      }],
    };
  }

  if (contentType.value.startsWith('multipart/')) {
    const boundary = contentType.params.boundary;
    if (!boundary) return empty;

    const result = { text: '', html: '', attachments: [] };
    const segments = splitMultipart(bodyPart, boundary);
    const isAlternative = contentType.value === 'multipart/alternative';

    for (const segment of segments.slice(0, LIMITS.parts)) {
      const child = parseStructure(segment, depth + 1);
      if (child.text && !result.text) result.text = child.text;
      if (child.html && !result.html) result.html = child.html;
      result.attachments.push(...child.attachments);
      // In an alternative group the parts are the same content in different
      // formats — once we have readable text, the rest is redundant.
      if (isAlternative && result.text) break;
    }
    return result;
  }

  const decoded = decodeBody(bodyPart, encoding, contentType.params.charset);
  if (contentType.value === 'text/html') {
    return { text: '', html: decoded, attachments: [] };
  }
  if (contentType.value.startsWith('text/') || contentType.value === '') {
    return { text: decoded, html: '', attachments: [] };
  }
  return {
    text: '',
    html: '',
    attachments: [{
      filename: filename || '(inline)',
      contentType: contentType.value,
      size: bodyPart.length,
    }],
  };
}

function splitMultipart(body, boundary) {
  const marker = `--${boundary}`;
  const out = [];
  const lines = String(body).split(/\r?\n/);
  let current = null;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === marker) {
      if (current !== null) out.push(current.join('\n'));
      current = [];
      continue;
    }
    if (trimmed === `${marker}--`) {
      if (current !== null) out.push(current.join('\n'));
      current = null;
      break;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null && current.length) out.push(current.join('\n'));
  return out;
}

/** Best readable text for a message: prefer text/plain, fall back to HTML. */
function bestText(structure) {
  if (structure.text && structure.text.trim()) return structure.text.trim();
  if (structure.html) return htmlToText(structure.html);
  return '';
}

/**
 * Thread key: the root of the References chain, else In-Reply-To, else the
 * message's own id. Reconstructing threads from headers is our problem now
 * (ADR-001) and this is the cheap 95% of it.
 */
function threadKeyOf(headers, messageId) {
  const refs = headerValues(headers, 'references')
    .join(' ')
    .match(/<[^>]+>/g);
  if (refs && refs.length) return refs[0];
  const inReplyTo = headerValue(headers, 'in-reply-to').match(/<[^>]+>/);
  if (inReplyTo) return inReplyTo[0];
  return messageId || '';
}

module.exports = {
  LIMITS,
  unfold,
  parseHeaders,
  headerValue,
  headerValues,
  decodeWords,
  decodeBody,
  decodeBytes,
  qpToBuffer,
  parseParams,
  splitRespectingQuotes,
  parseAddressList,
  parseAddress,
  htmlToText,
  parseStructure,
  bestText,
  threadKeyOf,
};
