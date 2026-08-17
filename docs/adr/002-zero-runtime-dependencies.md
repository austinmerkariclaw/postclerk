# ADR-002: Zero runtime dependencies

**Status:** Accepted
**Date:** 2026-08-17
**Deciders:** project owner

## Context

This program authenticates to the user's mailbox, reads every message in it, and
holds an LLM provider API key. It is, in security terms, one of the most
sensitive things a person can install. Whatever code runs inside this process
has the user's entire correspondence and at least one billable credential.

The convenient build uses `imapflow` for IMAP, `mailparser` for MIME, and a
vendor SDK for the model API. That is roughly 200+ transitive packages, each an
independently maintained account that can be phished, hijacked, or sold — and
npm account takeovers that ship credential stealers in a patch release are a
recurring, ordinary event, not a hypothetical.

The sibling project in this repo (`ccmeter`) already establishes a zero-
dependency house style, so this is also a consistency question.

## Decision

**Zero runtime dependencies, and zero development dependencies.** Everything is
built on the Node standard library (`node:tls`, `node:net`, `node:crypto`,
`node:test`). We implement the IMAP client, the MIME decoder, and the LLM HTTP
calls ourselves.

## Options Considered

### Option A: Standard npm dependency set

| Dimension        | Assessment                                          |
|------------------|-----------------------------------------------------|
| Complexity       | Low to write, Medium to keep patched                |
| Cost             | Free in money; ongoing in attention                 |
| Attack surface   | **High** — hundreds of publishers with full process access |
| Team familiarity | High — these are well-known libraries               |

**Pros:** Days of work saved. Battle-tested MIME handling — the long tail of
malformed real-world email is genuinely nasty and these libraries have absorbed
years of it.
**Cons:** The user cannot audit what they installed. "This tool reads all your
mail" plus "it pulls 200 packages" is a combination a security-conscious buyer
will decline, and the security-conscious buyer is precisely the segment that
cannot use a cloud product like Cora and is therefore our market. Also a
permanent patch treadmill.

### Option B: Zero dependencies

| Dimension        | Assessment                                              |
|------------------|---------------------------------------------------------|
| Complexity       | **High** to write, Low to maintain                      |
| Cost             | ~1,500 lines of protocol and parsing code we own        |
| Attack surface   | **Minimal** — our code plus the Node runtime            |
| Team familiarity | We build it, so by construction                         |

**Pros:** The entire trust surface is one repository a competent reader can
review in an afternoon. `npm install` pulls nothing and takes no time. No
transitive CVE churn. The claim "audit it yourself" is literally actionable,
which converts a marketing sentence into a verifiable property.
**Cons:** We own every MIME edge case. Hand-rolled protocol code is exactly
where memory and parsing bugs live. We must be disciplined about bounding
allocations from network input.

### Option C: Vendored dependencies

Copy library source into the tree.

**Pros:** No install-time supply chain; still get mature code.
**Cons:** Inherits the code without the upstream security fixes, and the license
and attribution burden is real. Worst of both: we own the maintenance without
having designed the code. Rejected.

## Trade-off Analysis

For most products Option A is obviously correct and Option B is self-indulgent.
The calculus inverts here because of what the process holds. The value
proposition is *"your mail never goes to a vendor"* — and a reader who takes
that claim seriously will immediately ask what else is in the process. If the
answer is "200 packages I did not review," the claim is hollow, because any one
of them can read the inbox and exfiltrate the API key.

Dependencies are not free here; they are drawn from the same budget as the core
promise. Spending a few days on a protocol client to make the central claim
verifiable is a good trade.

The honest risk is MIME. IMAP itself is a tractable line protocol with a small
command subset. Real-world MIME is not tractable in full. We manage this by
scoping hard: we decode `text/plain` and `text/html` bodies with
quoted-printable, base64, and RFC 2047 encoded-words, and we treat everything
else as an opaque attachment we name but never parse. Triage does not need to
open a PowerPoint. Refusing to parse attachments is both the safe choice and the
one that keeps this decision affordable.

## Consequences

**Easier**

- Install is instant and offline-capable.
- Security review is tractable; "read the source" is a real answer.
- No dependency upgrade work, ever.

**Harder**

- We own IMAP conformance and MIME edge cases.
- Bugs that a library would have absorbed become our incident reports.
- Contributors must resist adding a dependency for convenience.

**To revisit**

- If a class of real-world mail proves undecodable and users hit it often, the
  fix is to improve the decoder, not to add a dependency — unless the decoder
  becomes larger than the rest of the program, at which point revisit honestly.

## Action Items

1. [x] Enforce with a test that asserts `package.json` has no `dependencies`.
2. [x] Bound every network-driven allocation (max literal size, max line
       length, max message size) so hostile or broken input cannot exhaust memory.
3. [x] Restrict MIME scope to text parts; name attachments without parsing them.
4. [x] Document the audit surface in `docs/security.md`.
