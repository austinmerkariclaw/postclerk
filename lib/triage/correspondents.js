'use strict';

const { recipients } = require('../message');

/**
 * The correspondent graph: what the user's own outbox says about who matters.
 *
 * This is the single most valuable signal in the system, and it is free. A
 * model asked "is this important to Alice?" is reasoning from priors about
 * people in general. This structure knows Alice has written to Dana fourteen
 * times and answers her within the hour — which is not a prior, it is observed
 * behavior about that exact relationship (ADR-004).
 *
 * Timestamps are retained per correspondent (bounded) rather than pre-summed
 * counters, because `backtest` must be able to ask what the graph looked like
 * *before* a given date. Summed counters would leak the future into the past
 * and silently inflate backtest accuracy (ADR-005).
 */

/** Keep at most this many timestamps per correspondent per direction. */
const MAX_EVENTS = 500;

class CorrespondentGraph {
  constructor(data = {}) {
    /** @type {Map<string, {sentAt:number[], receivedAt:number[], latencies:number[], name:string}>} */
    this.people = new Map();
    this.vips = new Set((data.vips || []).map((v) => String(v).toLowerCase()));
    this.muted = new Set((data.muted || []).map((v) => String(v).toLowerCase()));

    for (const [email, rec] of Object.entries(data.people || {})) {
      this.people.set(email, {
        sentAt: rec.sentAt || [],
        receivedAt: rec.receivedAt || [],
        latencies: rec.latencies || [],
        name: rec.name || '',
      });
    }
  }

  _entry(email) {
    const key = String(email || '').toLowerCase();
    if (!key) return null;
    let rec = this.people.get(key);
    if (!rec) {
      rec = { sentAt: [], receivedAt: [], latencies: [], name: '' };
      this.people.set(key, rec);
    }
    return rec;
  }

  /** Record that the user wrote to these people. */
  observeSent(message) {
    const at = message.date.getTime();
    for (const addr of recipients(message)) {
      const rec = this._entry(addr.email);
      if (!rec) continue;
      if (addr.name && !rec.name) rec.name = addr.name;
      push(rec.sentAt, at);
    }
  }

  /** Record that someone wrote to the user. */
  observeReceived(message) {
    const rec = this._entry(message.from.email);
    if (!rec) return;
    if (message.from.name && !rec.name) rec.name = message.from.name;
    push(rec.receivedAt, message.date.getTime());
  }

  /** Record how fast the user answered a particular person. */
  observeLatency(email, ms) {
    const rec = this._entry(email);
    if (!rec || !Number.isFinite(ms) || ms < 0) return;
    push(rec.latencies, ms);
  }

  isVip(email) { return this.vips.has(String(email || '').toLowerCase()); }
  isMuted(email) { return this.muted.has(String(email || '').toLowerCase()); }

  /**
   * Stats for one correspondent, optionally as of a point in time.
   *
   * `asOf` is what keeps backtest honest: scoring a message from three weeks
   * ago must not use knowledge of replies that happened afterwards.
   */
  statsAt(email, asOf = null) {
    const key = String(email || '').toLowerCase();
    const rec = this.people.get(key);
    const cutoff = asOf instanceof Date ? asOf.getTime() : (asOf ?? Infinity);

    if (!rec) {
      return {
        email: key, name: '', sentTo: 0, receivedFrom: 0,
        lastSentAt: null, medianReplyLatencyMs: null,
        isVip: this.isVip(key), isMuted: this.isMuted(key),
      };
    }

    const sent = rec.sentAt.filter((t) => t < cutoff);
    const received = rec.receivedAt.filter((t) => t < cutoff);

    return {
      email: key,
      name: rec.name,
      sentTo: sent.length,
      receivedFrom: received.length,
      lastSentAt: sent.length ? new Date(Math.max(...sent)) : null,
      // Latencies are not individually timestamped; when asking a historical
      // question we drop them rather than risk leaking future behavior.
      medianReplyLatencyMs: cutoff === Infinity ? median(rec.latencies) : null,
      isVip: this.isVip(key),
      isMuted: this.isMuted(key),
    };
  }

  /** Also treat the sender's domain as evidence — colleagues share a domain. */
  domainStatsAt(domain, asOf = null) {
    const key = String(domain || '').toLowerCase();
    if (!key) return { domain: '', sentTo: 0 };
    let sentTo = 0;
    const cutoff = asOf instanceof Date ? asOf.getTime() : (asOf ?? Infinity);
    for (const [email, rec] of this.people) {
      if (!email.endsWith(`@${key}`)) continue;
      sentTo += rec.sentAt.filter((t) => t < cutoff).length;
    }
    return { domain: key, sentTo };
  }

  get size() { return this.people.size; }

  toJSON() {
    const people = {};
    for (const [email, rec] of this.people) people[email] = rec;
    return { version: 1, people, vips: [...this.vips], muted: [...this.muted] };
  }

  static fromJSON(data) { return new CorrespondentGraph(data || {}); }
}

function push(arr, value) {
  arr.push(value);
  if (arr.length > MAX_EVENTS) arr.splice(0, arr.length - MAX_EVENTS);
}

function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Build a graph from the user's Sent folder and (optionally) received mail.
 *
 * Reply latency is derived by pairing a sent message against the most recent
 * received message in the same thread. That pairing is what turns "you know
 * this person" into "you answer this person quickly", which is a much sharper
 * signal for whether new mail from them needs attention now.
 */
function buildGraph(sentMessages, receivedMessages = [], options = {}) {
  const graph = new CorrespondentGraph({
    vips: options.vips || [],
    muted: options.muted || [],
  });

  const receivedByThread = new Map();
  for (const message of receivedMessages) {
    graph.observeReceived(message);
    const list = receivedByThread.get(message.threadId) || [];
    list.push(message);
    receivedByThread.set(message.threadId, list);
  }

  for (const message of sentMessages) {
    graph.observeSent(message);

    const priorInThread = (receivedByThread.get(message.threadId) || [])
      .filter((m) => m.date < message.date)
      .sort((a, b) => b.date - a.date)[0];

    if (priorInThread) {
      graph.observeLatency(priorInThread.from.email, message.date - priorInThread.date);
    }
  }

  return graph;
}

module.exports = { CorrespondentGraph, buildGraph, median, MAX_EVENTS };
