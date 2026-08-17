# ADR-005: Earn trust — backtest before acting, reverse anything done

**Status:** Accepted
**Date:** 2026-08-17
**Deciders:** project owner

## Context

Every inbox-automation product faces the same adoption wall: to be useful it
must act on mail without asking, and the first time it is wrong about something
that mattered, the user turns it off permanently and tells other people to.
The asymmetry is brutal — a hundred correct archives buy less goodwill than one
missed message costs.

Incumbents ask the user to absorb that risk on faith: connect your inbox, let it
archive things, trust the marketing. The user has no way to evaluate the claim
except by living through it on their real mail, and the cost of a bad outcome is
paid entirely by them.

That is a weakness, not just a UX gap. We can convert the trust question from a
matter of belief into a matter of evidence, because unlike a cloud product
running someone else's model, we can replay the user's own history locally for
free.

## Decision

Two guarantees, both load-bearing:

**1. Backtest before acting.** `postclerk backtest` replays triage over the last
N days of real mail and scores its decisions against what the user actually did
— did they reply, did they archive, how fast. It reports agreement, the
decisions it got wrong *in each direction*, projected cost, and escalation rate.
It writes nothing to the mailbox. A user can evaluate the product on their own
inbox before granting it a single write.

**2. Nothing is ever destroyed, and everything is reversible.** We never delete,
never expunge, never permanently remove. Triage moves or labels, and every
mutation is written to an append-only journal with enough information to invert
it. `postclerk undo` reverses the last run.

The default mode is `--dry-run`. Acting requires an explicit flag.

## Options Considered

### Option A: Trust-me automation (incumbent model)

**Pros:** Simplest to build; best demo; no extra machinery.
**Cons:** Adoption rests on faith. One bad archive is unrecoverable reputational
damage. Nothing to show a skeptical or regulated buyer.

### Option B: Human-in-the-loop for every action

**Pros:** Maximum safety — nothing happens without approval.
**Cons:** Defeats the purpose. If the user reviews every decision, they have
read their inbox, which is the work we were supposed to remove.

### Option C: Backtest + reversible-by-construction (chosen)

**Pros:** Trust is established with evidence *before* any write. Mistakes are
recoverable, so the cost of being wrong drops from catastrophic to annoying.
Backtest doubles as the tuning instrument and as honest marketing material.
**Cons:** Significant extra machinery — a scoring harness, a labeled notion of
"what the user actually did," a journal format, and an inverse for every action.

## Trade-off Analysis

Option C's machinery is not overhead; it is most of the product's defensibility.

The scoring insight is that **the user's own past behavior is the label set**.
We do not need a hand-annotated corpus or a benchmark. If a message sat unread
and got archived, it was noise. If they replied within a day, it needed them.
This is free, personal, and exactly the distribution the system will run on —
better than any generic benchmark could be, because generic benchmarks measure
performance on someone else's inbox.

Two honest limits, which the report states rather than hides:

- **Labels are noisy.** People miss mail they should have answered and reply to
  things that did not need them. Backtest measures agreement with past behavior,
  not correctness in the abstract. It answers "would this have behaved like
  you?" — which is the right question for a delegate, but is not the same as
  "was it right."
- **Replay is not counterfactual.** We score what the system would have decided
  given history it can see. It cannot model how the user's behavior would have
  changed had the tool been running. We do not claim otherwise.

On reversibility: the reason to make it structural rather than a feature is that
"safe by default, dangerous by flag" is the only arrangement that survives
contact with automation. A cron job that runs unattended at 6am will eventually
run against a misconfigured account or a half-built correspondent graph. If the
worst case is "some mail moved to a folder and one command puts it back," that
is an incident report. If the worst case is deletion, it is a disaster. Choosing
never to hold the destructive capability at all is cheaper than being careful
with it, and it is a property we can state flatly: **postclerk cannot delete
your mail, because it never issues a delete.**

## Consequences

**Easier**

- A skeptical user can be converted with numbers from their own inbox.
- Mistakes are cheap, so we can be more aggressive with defaults.
- Backtest is the tuning harness, the regression test, and the sales demo.
- Unattended scheduled runs become defensible.

**Harder**

- Every action needs a defined, tested inverse.
- The journal is now durable state with format-compatibility obligations.
- Backtest needs the correspondent graph as of a *past* date to avoid scoring
  with knowledge from the future, which is real work to get right.

**To revisit**

- Leakage in backtest is the top correctness risk: building the graph from all
  sent mail and then scoring old messages lets the future leak into the past and
  inflates the score. The graph must be built strictly from mail predating each
  scored message.

## Action Items

1. [x] `--dry-run` is the default; writes require `--apply`.
2. [x] Append-only JSONL journal; every mutation records its inverse.
3. [x] `undo` reverses the last applied run.
4. [x] No `\Deleted`, no `EXPUNGE`, anywhere in the codebase — enforced by test.
5. [x] Backtest builds the correspondent graph point-in-time to prevent leakage.
6. [x] Backtest reports errors in both directions, not just aggregate accuracy.
