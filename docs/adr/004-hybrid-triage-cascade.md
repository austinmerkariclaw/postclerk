# ADR-004: Hybrid triage — deterministic cascade before the model

**Status:** Accepted
**Date:** 2026-08-17
**Deciders:** project owner

## Context

Triage is the core job: decide, for each inbox message, whether it needs the
user *now*, can wait, belongs in a digest, or is noise. The obvious 2026
implementation is to hand each message to an LLM and ask. That is roughly what
the incumbent does, and it has two problems we can exploit.

**Cost.** At a few hundred input tokens plus overhead per message, a 200
message/day inbox runs somewhere between $3 and $60/month depending on model
choice — on top of being the entire reason a $20/mo subscription needs to exist.

**Accuracy, in a way that is easy to miss.** A zero-shot model judging "is this
important to this person" is guessing from priors about people in general. But
we hold something far better: the user's own outbox. If they have replied to a
sender fourteen times, that is not a prior — it is *observed behavior about this
exact relationship*. No amount of model quality beats ground truth, and the
ground truth is sitting in the Sent folder, free.

## Decision

A **cascade**. Cheap, deterministic, high-confidence signals resolve each
message first; only messages that remain genuinely ambiguous escalate to the
model. Every decision, from either layer, carries the reasons that produced it.

Stages, in order:

1. **User rules** — explicit `always`/`never` lists. Absolute, no appeal.
2. **Bulk detection** — `List-Unsubscribe`, `Precedence: bulk|list`,
   `Auto-Submitted`, list headers. Strong evidence of "not addressed to you."
3. **Correspondent graph** — built from the Sent folder. Have you written to
   this person? How often, how recently, how fast? A frequent two-way
   correspondent's mail is important; a never-answered sender's is not.
4. **Thread participation** — you already replied in this thread, so a new
   message in it is likely yours to handle.
5. **Addressing** — direct `To:` outranks one-of-many `CC:` outranks bulk.
6. **Model escalation** — only what survives with low confidence.

## Options Considered

### Option A: LLM per message

| Dimension   | Assessment                                        |
|-------------|---------------------------------------------------|
| Complexity  | Low                                               |
| Cost        | **High** — scales linearly with mail volume       |
| Latency     | High — one round trip per message                 |
| Privacy     | Poor — every message egresses (violates ADR-003)  |
| Accuracy    | Good on nuance, mediocre on personal relevance    |

### Option B: Rules only

| Dimension   | Assessment                                    |
|-------------|-----------------------------------------------|
| Complexity  | Low                                           |
| Cost        | Zero                                          |
| Latency     | Instant                                       |
| Privacy     | Perfect                                       |
| Accuracy    | Brittle — no nuance, endless rule maintenance |

### Option C: Cascade (chosen)

| Dimension   | Assessment                                                  |
|-------------|-------------------------------------------------------------|
| Complexity  | **Medium-High** — two layers, confidence model, calibration |
| Cost        | Low — only the ambiguous tail is billed                     |
| Latency     | Low — most messages resolve locally in microseconds         |
| Privacy     | Strong — implements ADR-003 Tier 0/1 directly               |
| Accuracy    | Best available — ground truth first, nuance where it helps  |

## Trade-off Analysis

The cascade wins on every axis except implementation complexity, which is the
axis we are willing to spend on.

The subtle argument worth preserving: it is tempting to treat the deterministic
layer as a cheap approximation of the "real" LLM answer — a cost hack that
trades accuracy for money. That gets the epistemics backwards. On the specific
question *"does this person need to deal with this message"*, reply history is
**better evidence** than model judgment, not worse. The cascade is not
LLM-accuracy-minus-a-bit-for-savings; on its strongest signals it is
LLM-accuracy-plus. The model earns its place on the residual — genuinely novel
senders, unusual asks, tone and urgency in unfamiliar contexts — where priors
about people in general really are the best available evidence.

This ordering also produces the property that makes the product trustworthy:
because the deterministic layer emits reasons rather than a score, every
decision it makes is explainable and reproducible. Re-running yesterday's mail
produces yesterday's answer. That is what makes ADR-005's backtest meaningful
and what makes `why` a real command instead of a post-hoc rationalization.

**The main risk is cold start.** A brand-new user has no correspondent graph, so
nearly everything escalates: slow and expensive on day one, precisely when the
user is forming an opinion. Mitigation is to build the graph from the Sent
folder *before* the first triage — a one-time backfill over recent sent mail
that is fast, local, and free. A new user's first run is therefore already
warm, which turns the worst moment in the product into an ordinary one.

Second risk: confidence thresholds are a tuning surface, and untuned thresholds
either escalate everything (expensive) or nothing (wrong). This is why
thresholds are configuration, not constants, and why `backtest` reports the
escalation rate alongside accuracy so the trade is visible rather than guessed.

## Consequences

**Easier**

- Order-of-magnitude cost reduction versus per-message inference.
- Explainability is structural, not bolted on.
- Works with no model configured at all — degraded but genuinely useful, which
  makes a zero-config first run possible.

**Harder**

- Two code paths to test, plus their interaction.
- Confidence calibration is a real, ongoing tuning problem.
- The correspondent graph is state: it needs building, refreshing, and bounding.

**To revisit**

- Escalation rate is the health metric. Persistently >30% means the
  deterministic layer is under-powered for that user's mail mix.
- If a signal turns out to be near-perfectly predictive in backtests across
  users, promote it above the model rather than feeding it to the model.

## Action Items

1. [x] Extract signals as pure functions over a parsed message.
2. [x] Build the correspondent graph from the Sent folder; backfill on init.
3. [x] Make thresholds configurable, not hard-coded.
4. [x] Attach reasons to every decision from both layers.
5. [x] Report escalation rate in run and backtest summaries.
