'use strict';

const crypto = require('node:crypto');
const { redact } = require('./redact');
const { addressingOf } = require('../message');

/**
 * Build the bounded projection of a message that may cross the network.
 *
 * This is the Tier 1 boundary from ADR-003. A projection is deliberately much
 * smaller than the message: enough for a model to judge relevance, never the
 * whole document. Everything here is auditable — `postclerk triage --explain`
 * prints exactly these bytes, and the journal records their hash and size.
 */

const DEFAULTS = {
  /** Characters of body text included per message. */
  bodyChars: 2000,
  /** Characters of subject retained. */
  subjectChars: 200,
};

function projectMessage(message, index, selfAddresses = [], opts = {}) {
  const config = { ...DEFAULTS, ...opts };

  const subject = redact(String(message.subject || '').slice(0, config.subjectChars));
  const body = redact(collapse(message.bodyText || '').slice(0, config.bodyChars));

  const redactions = mergeRedactions(subject.redactions, body.redactions);

  return {
    id: index,
    from: redact(displayFrom(message)).text,
    domain: message.from.domain || '',
    subject: subject.text,
    date: message.date instanceof Date ? message.date.toISOString() : null,
    addressedAs: addressingOf(message, selfAddresses),
    recipientCount: message.to.length + message.cc.length,
    attachments: (message.attachments || []).map((a) => a.filename).slice(0, 10),
    preview: body.text,
    truncated: (message.bodyText || '').length > config.bodyChars,
    _redactions: redactions,
  };
}

function displayFrom(message) {
  const { name, email } = message.from;
  return name ? `${name} <${email}>` : email;
}

function collapse(text) {
  return String(text)
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function mergeRedactions(...lists) {
  const counts = new Map();
  for (const list of lists) {
    for (const { rule, count } of list || []) {
      counts.set(rule, (counts.get(rule) || 0) + count);
    }
  }
  return [...counts].map(([rule, count]) => ({ rule, count }));
}

/**
 * Project a batch and produce the audit record that accompanies it.
 * The hash lets a user verify after the fact exactly what was transmitted.
 */
function projectBatch(messages, selfAddresses = [], opts = {}) {
  const items = messages.map((m, i) => projectMessage(m, i, selfAddresses, opts));

  const redactions = mergeRedactions(...items.map((i) => i._redactions));
  const payload = items.map(({ _redactions, ...rest }) => rest);
  const serialized = JSON.stringify(payload);

  return {
    items: payload,
    /** Maps projection index back to the real message. */
    uids: messages.map((m) => m.uid),
    audit: {
      messages: messages.length,
      bytes: Buffer.byteLength(serialized, 'utf8'),
      sha256: crypto.createHash('sha256').update(serialized).digest('hex'),
      redactions,
    },
    serialized,
  };
}

/** Human-readable rendering of what would be sent, for `--explain`. */
function explain(batch) {
  const lines = [];
  lines.push(`Would send ${batch.audit.messages} message projection(s), ` +
    `${batch.audit.bytes} bytes, sha256 ${batch.audit.sha256.slice(0, 16)}…`);

  if (batch.audit.redactions.length) {
    const summary = batch.audit.redactions.map((r) => `${r.rule}×${r.count}`).join(', ');
    lines.push(`Redacted before send: ${summary}`);
  } else {
    lines.push('Redacted before send: nothing matched the secret patterns');
  }

  lines.push('');
  lines.push(JSON.stringify(batch.items, null, 2));
  return lines.join('\n');
}

module.exports = { projectMessage, projectBatch, explain, DEFAULTS };
