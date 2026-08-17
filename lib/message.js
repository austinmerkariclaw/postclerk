'use strict';

const mime = require('./mime');

/**
 * Normalize a raw RFC 5322 message into the `Message` shape the rest of the
 * system works with.
 *
 * This is the seam that makes triage testable and transport-agnostic: nothing
 * downstream of here knows or cares that the mail arrived over IMAP.
 */

/** Fields we keep verbatim because signals or the model projection need them. */
const KEPT_HEADERS = [
  'list-unsubscribe', 'list-id', 'precedence', 'auto-submitted',
  'x-autoreply', 'x-autorespond', 'return-path', 'reply-to',
  'importance', 'x-priority', 'content-type',
  // Sender authentication. `From:` is trivially forged, so any trust granted
  // on the basis of who a message claims to be from has to be checked here.
  'authentication-results', 'arc-authentication-results', 'received-spf',
  'dkim-signature',
];

function normalize(raw, meta = {}) {
  const source = String(raw || '');
  const split = source.search(/\r?\n\r?\n/);
  const headerBlock = split === -1 ? source : source.slice(0, split);
  const headers = mime.parseHeaders(headerBlock);

  const messageId = (mime.headerValue(headers, 'message-id').match(/<[^>]+>/) || [''])[0];
  const from = mime.parseAddressList(mime.headerValue(headers, 'from'))[0]
    || { name: '', email: '', domain: '' };

  // Prefer the server's INTERNALDATE: the Date: header is sender-controlled and
  // is wrong often enough (clock skew, forgery, timezone bugs) to matter.
  const headerDate = new Date(mime.headerValue(headers, 'date'));
  const date = meta.internalDate instanceof Date && !Number.isNaN(meta.internalDate.getTime())
    ? meta.internalDate
    : (Number.isNaN(headerDate.getTime()) ? new Date(0) : headerDate);

  const kept = new Map();
  for (const name of KEPT_HEADERS) {
    const value = mime.headerValue(headers, name);
    if (value) kept.set(name, value);
  }

  // Body may be absent: a headers-only fetch is the common, cheap path.
  const hasBody = split !== -1 && source.length > split + 2;
  const structure = hasBody
    ? mime.parseStructure(source)
    : { text: '', html: '', attachments: [] };

  return {
    uid: meta.uid ?? null,
    folder: meta.folder || 'INBOX',
    messageId,
    threadId: mime.threadKeyOf(headers, messageId),
    from,
    to: mime.parseAddressList(mime.headerValue(headers, 'to')),
    cc: mime.parseAddressList(mime.headerValue(headers, 'cc')),
    replyTo: mime.parseAddressList(mime.headerValue(headers, 'reply-to')),
    subject: mime.decodeWords(mime.headerValue(headers, 'subject')).trim(),
    date,
    flags: meta.flags || [],
    size: meta.size || source.length,
    headers: kept,
    bodyText: hasBody ? mime.bestText(structure) : '',
    attachments: structure.attachments,
    hasBody,
  };
}

/**
 * What the receiving server concluded about whether the sender is who they say.
 *
 * Returns 'pass' | 'fail' | 'none'. This matters because every trust signal in
 * triage keys on the sender's address, and `From:` is a claim, not a fact —
 * anyone can put `dana@partnerco.example` in it. Trust has to be earned by
 * authentication rather than asserted by the message itself.
 *
 * 'none' is the common case for legitimate mail from servers that do not stamp
 * results, so it must not be treated as failure.
 */
function authenticationOf(message) {
  const results = [
    message.headers.get('authentication-results') || '',
    message.headers.get('arc-authentication-results') || '',
    message.headers.get('received-spf') || '',
  ].join(' ').toLowerCase();

  if (!results.trim()) {
    return message.headers.has('dkim-signature') ? 'none' : 'none';
  }

  // DMARC is the aligned verdict and outranks the individual mechanisms.
  if (/dmarc=(fail|reject|quarantine)/.test(results)) return 'fail';
  if (/dmarc=pass/.test(results)) return 'pass';

  const dkimFail = /dkim=(fail|permerror|temperror)/.test(results);
  const spfFail = /spf=(fail|softfail)/.test(results) || /^\s*fail\b/.test(results);
  if (dkimFail && spfFail) return 'fail';

  if (/dkim=pass/.test(results) || /spf=pass/.test(results)) return 'pass';
  if (dkimFail || spfFail) return 'fail';

  return 'none';
}

/** True when the message was sent by one of the user's own addresses. */
function isFromSelf(message, selfAddresses) {
  const self = new Set([...selfAddresses].map((a) => String(a).toLowerCase()));
  return self.has(message.from.email);
}

/** Every recipient address on the message. */
function recipients(message) {
  return [...message.to, ...message.cc].filter((a) => a.email);
}

/**
 * How the user was addressed: 'direct' (sole To:), 'group' (one of several),
 * 'cc', or 'bcc' (not visibly addressed at all — typical of list mail).
 */
function addressingOf(message, selfAddresses) {
  const self = new Set([...selfAddresses].map((a) => String(a).toLowerCase()));
  const toSelf = message.to.filter((a) => self.has(a.email));
  const ccSelf = message.cc.filter((a) => self.has(a.email));

  if (toSelf.length && message.to.length === 1) return 'direct';
  if (toSelf.length) return 'group';
  if (ccSelf.length) return 'cc';
  return 'bcc';
}

module.exports = {
  normalize, isFromSelf, recipients, addressingOf, authenticationOf, KEPT_HEADERS,
};
