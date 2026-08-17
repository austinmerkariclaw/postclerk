'use strict';

const { addressingOf, authenticationOf } = require('../message');

/**
 * Triage signals.
 *
 * Every signal is a pure function of (message, context) returning either null
 * or an evidence record. Two kinds exist:
 *
 *   decisive — settles the label on its own and short-circuits the cascade
 *   weighted — contributes evidence toward one or more labels
 *
 * Purity is the point. It makes each signal individually testable, makes
 * `why` able to replay a decision exactly, and makes `backtest` meaningful
 * rather than an approximation of what the system would have done.
 */

const LABELS = ['now', 'later', 'brief', 'noise'];

const DAY = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------------- decisive

/** Explicit user rules outrank everything. No appeal, no model. */
function vipRule({ message, stats }) {
  if (!stats.isVip) return null;
  return {
    code: 'vip',
    detail: `${message.from.email} is on your VIP list`,
    decisive: 'now',
    confidence: 1,
  };
}

function mutedRule({ message, stats }) {
  if (!stats.isMuted) return null;
  return {
    code: 'muted',
    detail: `${message.from.email} is muted`,
    decisive: 'noise',
    confidence: 1,
  };
}

/** Machine-generated mail announces itself. Believe it. */
function autoSubmitted({ message }) {
  const value = message.headers.get('auto-submitted');
  if (!value || /^no$/i.test(value.trim())) return null;
  return {
    code: 'auto-submitted',
    detail: `Auto-Submitted: ${value}`,
    decisive: 'noise',
    confidence: 0.95,
  };
}

/**
 * Bulk mail. `List-Unsubscribe` is the strongest single indicator that a
 * message was addressed to a list rather than to a person — it is present
 * because the sender is legally or conventionally obliged to offer an exit.
 */
function bulkHeaders({ message }) {
  const reasons = [];
  if (message.headers.has('list-unsubscribe')) reasons.push('List-Unsubscribe');
  if (message.headers.has('list-id')) reasons.push('List-Id');
  const precedence = message.headers.get('precedence');
  if (precedence && /^(bulk|list|junk)$/i.test(precedence.trim())) {
    reasons.push(`Precedence: ${precedence.trim()}`);
  }
  if (reasons.length === 0) return null;

  return {
    code: 'bulk',
    detail: `bulk mail headers present (${reasons.join(', ')})`,
    decisive: 'brief',
    confidence: 0.92,
  };
}

/**
 * The user already participated in this thread, so a new message in it is
 * almost certainly theirs to handle. Strong and cheap.
 */
function threadParticipant({ threadState }) {
  if (!threadState || !threadState.userParticipated) return null;
  return {
    code: 'thread-participant',
    detail: `you have already replied in this thread (${threadState.userMessages} message(s))`,
    decisive: 'now',
    confidence: 0.93,
  };
}

/**
 * A person the user writes to regularly, recently. Ground truth beats priors.
 *
 * Gated on sender authentication. `From:` is a claim anyone can make, so a
 * message that fails DMARC/DKIM/SPF while claiming to be a trusted
 * correspondent gets no trust from this signal — that is precisely the shape of
 * a targeted spoof, and granting it `now` would hand an attacker the top of the
 * user's inbox.
 *
 * Note what this deliberately does NOT do: it does not penalize the message.
 * Removing trust is proportionate; adding a penalty would let anyone bury a
 * real sender's mail by spoofing them.
 */
function frequentCorrespondent({ message, stats, config, asOf }) {
  const threshold = config.knownCorrespondentMinSent;
  if (stats.sentTo < threshold || !stats.lastSentAt) return null;
  if (authenticationOf(message) === 'fail') return null;

  const now = asOf instanceof Date ? asOf : new Date();
  const ageDays = (now - stats.lastSentAt) / DAY;
  if (ageDays > config.knownCorrespondentMaxAgeDays) return null;

  return {
    code: 'known-correspondent',
    detail: `you have written to them ${stats.sentTo} time(s), last ${Math.round(ageDays)} day(s) ago`,
    decisive: 'now',
    confidence: 0.9,
  };
}

/**
 * They write, the user never answers. After enough repetitions that is a
 * decision the user has already made; triage should stop re-litigating it.
 */
function neverAnswered({ stats, config }) {
  if (stats.sentTo > 0) return null;
  if (stats.receivedFrom < config.neverAnsweredMinReceived) return null;
  return {
    code: 'never-answered',
    detail: `${stats.receivedFrom} message(s) received, none ever answered`,
    decisive: 'brief',
    confidence: 0.85,
  };
}

// ------------------------------------------------------------------- weighted

/**
 * Being the sole addressee is a stronger claim on attention than a CC — but
 * only modestly. Direct addressing is necessary-but-not-sufficient evidence of
 * importance: every phishing attempt and every cold sales mail is also
 * addressed directly to you. Weighted high enough to matter, low enough that it
 * cannot carry a message to `now` on its own.
 */
function addressing({ message, selfAddresses }) {
  const how = addressingOf(message, selfAddresses);
  const weights = {
    direct: { now: 1.5 },
    group: { now: 1 },
    cc: { later: 1.5 },
    bcc: { brief: 1.5 },
  }[how];
  const detail = {
    direct: 'addressed directly to you, and only you',
    group: 'addressed to you among several recipients',
    cc: 'you are CC\'d, not a primary recipient',
    bcc: 'you are not visibly addressed (BCC or list delivery)',
  }[how];
  return { code: `addressing:${how}`, detail, weights };
}

/** Colleagues share a domain the user writes to often. Also authentication-gated. */
function knownDomain({ message, domainStats }) {
  if (domainStats.sentTo < 5) return null;
  if (authenticationOf(message) === 'fail') return null;
  return {
    code: 'known-domain',
    detail: `you have written to ${message.from.domain} ${domainStats.sentTo} time(s)`,
    weights: { now: 1.5 },
  };
}

/**
 * A message failing authentication while claiming to be someone the user
 * actually corresponds with. This is the shape of business email compromise:
 * a forged reply into a live thread, asking for a wire transfer.
 *
 * Decisive, and decisive to `later` — deliberately not to `noise`. The response
 * has to be proportionate (this is the "correct values, catastrophic judgment"
 * failure mode): stripping the urgency defeats the attack, while hiding the
 * message would hand anyone a way to bury a real sender's mail simply by
 * spoofing them. The message stays visible; only the unearned trust is removed,
 * and the reason says exactly why.
 */
function impersonationAttempt({ message, stats }) {
  if (authenticationOf(message) !== 'fail') return null;
  const knownIdentity = stats.sentTo > 0 || stats.receivedFrom > 2;
  if (!knownIdentity) return null;

  return {
    code: 'impersonation',
    detail: `fails sender authentication while claiming to be ${message.from.email}, ` +
      'a sender you correspond with — possible spoof',
    decisive: 'later',
    confidence: 0.88,
  };
}

/** Failed authentication from a sender with no established identity to steal. */
function failedAuthentication({ message, stats }) {
  if (authenticationOf(message) !== 'fail') return null;
  if (stats.sentTo > 0 || stats.receivedFrom > 2) return null; // handled decisively above
  return {
    code: 'failed-authentication',
    detail: 'fails sender authentication (SPF/DKIM/DMARC)',
    weights: { brief: 2 },
  };
}

const NOREPLY = /^(no-?reply|do-?not-?reply|notifications?|automated|mailer-daemon|bounce)/i;
function noReplySender({ message }) {
  const local = message.from.email.split('@')[0] || '';
  if (!NOREPLY.test(local)) return null;
  return {
    code: 'no-reply-sender',
    detail: `sender address "${local}" does not accept replies`,
    weights: { brief: 2 },
  };
}

const MARKETING = /\b(unsubscribe|view (this )?in browser|% off|limited time|webinar|free trial|act now|don't miss)\b/i;
function marketingLanguage({ message }) {
  const haystack = `${message.subject}\n${message.bodyText.slice(0, 4000)}`;
  const hit = MARKETING.exec(haystack);
  if (!hit) return null;
  return {
    code: 'marketing-language',
    detail: `promotional phrasing ("${hit[0]}")`,
    weights: { brief: 1.5 },
  };
}

const DEADLINE = /\b(by (eod|today|tomorrow|monday|tuesday|wednesday|thursday|friday)|urgent|asap|deadline|time[- ]sensitive|need(s)? (an )?answer|before the call)\b/i;
function urgencyCues({ message }) {
  const haystack = `${message.subject}\n${message.bodyText.slice(0, 4000)}`;
  const hit = DEADLINE.exec(haystack);
  if (!hit) return null;
  return {
    code: 'urgency-cue',
    detail: `time pressure indicated ("${hit[0]}")`,
    weights: { now: 1.5 },
  };
}

/** A direct question asked of you usually needs you. */
function directQuestion({ message }) {
  const body = message.bodyText.slice(0, 4000);
  if (!/\?/.test(body) && !/\?/.test(message.subject)) return null;
  const asksYou = /\b(can|could|would|will|do|did|are|is|should) you\b/i.test(body)
    || /\bwhat do you think\b/i.test(body)
    || /\?\s*$/.test(message.subject);
  if (!asksYou) return { code: 'question-mark', detail: 'contains a question', weights: { now: 0.5 } };
  return {
    code: 'direct-question',
    detail: 'asks you a direct question',
    weights: { now: 1.5 },
  };
}

/** A reply in an existing conversation carries more obligation than a cold note. */
function replySubject({ message }) {
  if (!/^\s*(re|aw|antw|sv|vs)\s*:/i.test(message.subject)) return null;
  return { code: 'reply-subject', detail: 'subject marks this as a reply', weights: { now: 0.75 } };
}

function forwardSubject({ message }) {
  if (!/^\s*(fwd?|wg)\s*:/i.test(message.subject)) return null;
  return { code: 'forward-subject', detail: 'subject marks this as a forward', weights: { later: 0.5 } };
}

/** Someone the user answers within hours is someone to surface now. */
function fastResponder({ stats }) {
  if (stats.medianReplyLatencyMs == null) return null;
  const hours = stats.medianReplyLatencyMs / (60 * 60 * 1000);
  if (hours > 8) return null;
  return {
    code: 'fast-responder',
    detail: `you normally reply to them within ${hours.toFixed(1)}h`,
    weights: { now: 1 },
  };
}

/** Mail nobody has ever corresponded with, either direction. */
function firstContact({ stats }) {
  if (stats.sentTo > 0 || stats.receivedFrom > 1) return null;
  return {
    code: 'first-contact',
    detail: 'no prior correspondence with this sender',
    weights: { later: 1 },
  };
}

function age({ message, asOf }) {
  const now = asOf instanceof Date ? asOf : new Date();
  const days = (now - message.date) / DAY;
  if (days <= 1) return { code: 'fresh', detail: 'arrived in the last 24 hours', weights: { now: 0.5 } };
  if (days >= 14) {
    return {
      code: 'stale',
      detail: `${Math.round(days)} days old and still unhandled`,
      weights: { later: 1 },
    };
  }
  return null;
}

function attachmentPresent({ message }) {
  if (!message.attachments || message.attachments.length === 0) return null;
  return {
    code: 'has-attachment',
    detail: `carries ${message.attachments.length} attachment(s)`,
    weights: { now: 0.5 },
  };
}

/** Already answered by the user — nothing further owed. */
function alreadyAnswered({ message }) {
  if (!message.flags.includes('\\Answered')) return null;
  return {
    code: 'already-answered',
    detail: 'you have already replied to this message',
    weights: { later: 2, brief: 1 },
  };
}

const DECISIVE = [
  vipRule,
  mutedRule,
  autoSubmitted,
  bulkHeaders,
  // Ahead of thread-participant and known-correspondent on purpose: a forged
  // reply into a live thread is exactly the attack, so the identity check has
  // to run before anything that grants trust on the basis of identity.
  impersonationAttempt,
  threadParticipant,
  frequentCorrespondent,
  neverAnswered,
];

const WEIGHTED = [
  addressing,
  knownDomain,
  failedAuthentication,
  noReplySender,
  marketingLanguage,
  urgencyCues,
  directQuestion,
  replySubject,
  forwardSubject,
  fastResponder,
  firstContact,
  age,
  attachmentPresent,
  alreadyAnswered,
];

module.exports = {
  LABELS,
  DECISIVE,
  WEIGHTED,
  // exported individually so each can be tested in isolation
  vipRule,
  mutedRule,
  autoSubmitted,
  bulkHeaders,
  impersonationAttempt,
  threadParticipant,
  frequentCorrespondent,
  neverAnswered,
  addressing,
  knownDomain,
  failedAuthentication,
  noReplySender,
  marketingLanguage,
  urgencyCues,
  directQuestion,
  replySubject,
  forwardSubject,
  fastResponder,
  firstContact,
  age,
  attachmentPresent,
  alreadyAnswered,
};
