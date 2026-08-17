'use strict';

/**
 * A model provider that answers deterministically, so the full pipeline can be
 * exercised end to end without a network, an API key, or a bill.
 *
 * It also records every payload it was handed, which is how the egress tests
 * verify that redaction happened *before* the boundary rather than after.
 */
class FakeProvider {
  /**
   * @param {object} opts
   * @param {string|function} [opts.answer] label to return, or (item) => label
   * @param {Error} [opts.throws] error to throw instead of answering
   */
  constructor(opts = {}) {
    this.name = 'fake';
    this.answer = opts.answer || 'later';
    this.throws = opts.throws || null;
    this.seen = [];      // every batch handed to classify()
    this.calls = 0;
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, usd: 0 };
  }

  /** Every projection this provider was ever given, flattened. */
  get seenItems() {
    return this.seen.flatMap((batch) => batch.items);
  }

  /** All text that crossed the boundary, for leak assertions. */
  get seenText() {
    return JSON.stringify(this.seen.map((b) => b.items));
  }

  async classify(batch) {
    this.calls += 1;
    this.seen.push(batch);
    if (this.throws) throw this.throws;

    const decisions = batch.items.map((item, i) => ({
      uid: batch.uids[i],
      label: typeof this.answer === 'function' ? this.answer(item) : this.answer,
      confidence: 0.88,
      rationale: 'fake provider',
      cost: null,
    }));

    const usage = { input: 100 * batch.items.length, output: 20 * batch.items.length, cacheRead: 0, cacheWrite: 0, usd: 0.001 };
    this.usage.input += usage.input;
    this.usage.output += usage.output;
    this.usage.usd += usage.usd;
    this.usage.calls += 1;

    return { decisions, usage };
  }

  async summarize(batch) {
    this.calls += 1;
    this.seen.push(batch);
    if (this.throws) throw this.throws;
    return {
      text: batch.items.map((i) => `- ${i.from}: ${i.subject}`).join('\n'),
      usage: { input: 50, output: 30, cacheRead: 0, cacheWrite: 0, usd: 0.0005 },
    };
  }

  async draft(projection) {
    this.calls += 1;
    this.seen.push({ items: [projection], uids: [projection.id] });
    if (this.throws) throw this.throws;
    return {
      body: 'Thanks — looking at this now and will come back to you today.',
      usage: { input: 80, output: 25, cacheRead: 0, cacheWrite: 0, usd: 0.0008 },
    };
  }

  totals() { return { ...this.usage, model: 'fake' }; }
}

module.exports = { FakeProvider };
