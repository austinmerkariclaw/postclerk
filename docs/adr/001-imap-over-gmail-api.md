# ADR-001: Talk IMAP, not the Gmail API

**Status:** Accepted
**Date:** 2026-08-17
**Deciders:** project owner

## Context

The product is a local-first AI email chief of staff competing with Cora
(by Every, $20/mo). Cora's single largest structural limitation is that it
supports **Gmail and Google Workspace only**. Everyone on Fastmail, iCloud,
Proton, Outlook/Office 365, or a self-hosted or corporate mail server is not a
customer they can serve.

We have a second, self-imposed constraint that pushes the same direction: this
project must be installable by one person in a few minutes without the author
registering anything on their behalf. Any design requiring us to stand up and
maintain a cloud application identity is disqualified.

Forces at play:

- Reaching the users Cora structurally cannot reach is our cheapest wedge.
- OAuth-based Gmail access is not just a code path; it is a compliance program.
- Whatever we choose, the user has to be able to revoke our access trivially.

## Decision

Speak **IMAP over TLS**, authenticating with a user-generated app password, and
isolate per-provider quirks behind a small capability layer. We do not
integrate the Gmail API.

## Options Considered

### Option A: Gmail API (OAuth2)

| Dimension        | Assessment                                                     |
|------------------|----------------------------------------------------------------|
| Complexity       | Medium code, **High** program (verification, CASA assessment)   |
| Cost             | Google OAuth verification + CASA Tier 2 audit; recurring        |
| Reach            | Gmail/Workspace only — same ceiling as the incumbent            |
| Time-to-first-run| Days-to-months (app review) before a stranger can use it        |

**Pros:** Native threads and labels; server-side search; push via Pub/Sub;
generous quotas; no password handling at all.
**Cons:** Restricted-scope access to Gmail requires app verification and an
annual third-party CASA security assessment before unaffiliated users can
connect. That is a funded-company activity, not something a CLI ships with. It
also reproduces exactly the lock-in we are attacking.

### Option B: IMAP + app password

| Dimension        | Assessment                                            |
|------------------|-------------------------------------------------------|
| Complexity       | **High** code (hand-rolled protocol), Low program      |
| Cost             | Zero — no vendor relationship exists                  |
| Reach            | Effectively every mail provider in existence          |
| Time-to-first-run| ~2 minutes (user pastes an app password)              |

**Pros:** Universal. No application identity to register, verify, or renew — the
user's credential is between them and their own provider, and they revoke it in
their own account settings without involving us. Works against corporate and
self-hosted servers that will never be on a vendor's integration list.
**Cons:** We implement the protocol ourselves (see ADR-002). No native thread
objects — threads must be reconstructed from `References`/`In-Reply-To`. No
cheap push; `IDLE` or polling. Gmail exposes labels as folders with a special
`\All` mailbox, so provider quirks are real. App passwords require the user to
have 2FA on, and some Workspace admins disable them outright.

### Option C: JMAP

| Dimension        | Assessment                                  |
|------------------|---------------------------------------------|
| Complexity       | Low — clean, modern JSON protocol           |
| Cost             | Zero                                        |
| Reach            | **Very low** — Fastmail and a short tail     |

**Pros:** By far the nicest protocol to implement; efficient batching and push.
**Cons:** Adoption is too thin to be a primary transport in 2026.

## Trade-off Analysis

The decision reduces to *where we spend our complexity budget*. Option A moves
complexity out of the code and into a compliance program we cannot staff, and
buys reach we have explicitly decided not to want. Option B concentrates
complexity in one hard, bounded, testable module — an IMAP client — and buys the
entire non-Gmail market plus a much shorter path from install to first run.

Bounded, testable complexity that we own beats unbounded process complexity that
a third party owns. A protocol client is finished when its tests pass; an app
verification is finished when someone else says so.

Option C is a strictly better protocol serving too few people to matter. It is a
natural second transport once the mailbox interface has one real implementation
behind it, which is why the transport is an interface from day one.

The genuine cost of Option B is honest and worth stating: app passwords are
coarse credentials — full mailbox access, no scoping, no per-action consent.
This is why the security model (ADR-003) treats the credential as the crown
jewel, never writes it to the journal or any log, and defaults to reading from
the OS environment or a 0600 file rather than a config file under version
control.

## Consequences

**Easier**

- Supporting a new provider becomes documentation, not engineering.
- Users can audit and revoke access without us being in the loop.
- Local integration tests can run against an in-process IMAP server (ADR-002),
  so the full pipeline is testable with no network and no accounts.

**Harder**

- Threading is our problem. We reconstruct conversations from message headers.
- Folder semantics vary. We probe `SPECIAL-USE` and fall back to name matching.
- No push without holding an `IDLE` connection open; scheduled polling is the
  default cadence.

**To revisit**

- If Workspace admins disabling app passwords turns out to be the top support
  issue, revisit Option A as an *additional* transport behind the same
  interface — not a replacement.
- Add JMAP once a second transport is cheap to add.

## Action Items

1. [x] Define a `Mailbox` interface so transport is swappable.
2. [x] Implement the IMAP client against that interface.
3. [x] Probe `SPECIAL-USE`, fall back to name heuristics, per provider.
4. [x] Ship a per-provider setup guide (app password steps for each).
