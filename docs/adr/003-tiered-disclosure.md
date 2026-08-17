# ADR-003: Tiered disclosure — bound what leaves the machine

**Status:** Accepted
**Date:** 2026-08-17
**Deciders:** project owner

## Context

"Local-first" is the product's central claim against a cloud incumbent. But an
LLM has to see *something* to be useful, and for most users that model runs on
someone else's computer. If we are careless, "local-first" degrades into "we
forward your entire inbox to a different vendor than Cora does," which is not a
meaningfully better offer and would be dishonest to advertise as one.

So the real question is not *whether* data leaves — it is exactly **what**
leaves, **when**, and **whether the user can verify it**.

## Decision

Adopt **tiered disclosure**:

1. **Tier 0 — no egress.** Deterministic signals (headers, folder, flags,
   correspondent history) decide the confident majority of mail. Nothing leaves
   the machine. This is most messages.
2. **Tier 1 — bounded projection.** Only mail the deterministic layer cannot
   confidently resolve escalates to the model, and only as a *projection*:
   sender, subject, date, thread position, and a truncated body prefix
   (default 2,000 chars) with high-risk patterns redacted.
3. **Tier 2 — full local.** `provider: ollama` runs everything against a local
   model. Zero egress including Tier 1.

Egress is **auditable, not asserted**: `--explain` prints the exact payload that
would be sent, and every real call records the payload's SHA-256 and byte count
in the journal. A user can prove, after the fact, how much left and verify it
against what we said would leave.

## Options Considered

### Option A: Send full message bodies to a cloud model

**Pros:** Simplest. Best model context, so best accuracy ceiling.
**Cons:** Destroys the differentiator. For the users who most need this product
— people under NDA, attorney-client privilege, HIPAA, or an employer policy —
"we send your mail to a third party" is disqualifying regardless of which third
party it is.

### Option B: Deterministic only, no model

**Pros:** Perfect privacy, zero marginal cost, instant.
**Cons:** No drafting, no summarization, no nuance on genuinely ambiguous mail.
This is a mail filter, not a chief of staff. It loses on capability.

### Option C: Tiered disclosure (chosen)

**Pros:** Most mail never leaves. What leaves is bounded, redacted, and
provably so. Users who need absolute isolation get Tier 2 without changing how
they use the tool. Cost falls out of the same mechanism (ADR-004).
**Cons:** More machinery: a redactor, a projection format, and an audit trail —
and the redactor is a security control that can have bugs.

## Trade-off Analysis

Option A is what you build if privacy is a marketing adjective. Option B is what
you build if it is the only value. Option C treats privacy as an *engineering
budget*: we spend egress only where it buys capability we cannot get otherwise,
and we account for every unit spent.

The important design consequence is that redaction must be **conservative and
mechanical**, not model-mediated. We do not ask an LLM to decide what is
sensitive — that would require sending it the sensitive thing first. The
redactor is a set of regexes applied before any network call, covering the
patterns whose leakage is unambiguously bad:

- one-time codes and 2FA/verification codes
- `Authorization:` headers, bearer tokens, and common API-key shapes
- long random-looking strings that match key/secret formats
- credit-card-shaped and government-ID-shaped digit runs
- URLs carrying `token=`, `key=`, `secret=`, `password=`, or a reset path

This list will not be exhaustive, and claiming otherwise would be the kind of
overreach this ADR exists to prevent. The honest framing for the docs is
"redaction reduces accidental disclosure of common secret shapes; it is not a
guarantee, and Tier 2 is the guarantee." Anything stronger would be a promise we
cannot keep, and this is a product whose entire pitch is that its promises are
checkable.

A quieter but load-bearing point: because escalation is a *decision*, not a
default, the volume of egress becomes a number we can show the user. "Last run:
14 of 212 messages escalated, 41 KB sent, here are the hashes" is a far stronger
statement than any privacy policy, and no cloud product can make it.

## Consequences

**Easier**

- A credible, checkable privacy claim, which is the whole wedge.
- Cost control comes free — Tier 0 is the same mechanism as the cost cascade.
- Regulated and NDA-bound users become addressable with Tier 2.

**Harder**

- Two accuracy regimes to reason about and test.
- The redactor is a security control: it needs its own tests and a documented
  non-guarantee.
- Users may be surprised that some mail is decided without the model. The
  `why` command exists to explain exactly that.

**To revisit**

- Escalation rate is a health metric. If it drifts high, either the
  deterministic layer is too timid or the mail mix changed; both are worth an
  alert.
- If local models get good enough at drafting, promote Tier 2 to the default.

## Action Items

1. [x] Implement the redactor as pure, synchronous, pre-network code.
2. [x] Implement `--explain` to print exact outbound payloads.
3. [x] Record payload SHA-256 and byte count in the journal for every call.
4. [x] Report escalation rate and bytes egressed in every run summary.
5. [x] Document the non-guarantee plainly in `docs/security.md`.
