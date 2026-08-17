# postclerk — System Design

**Status:** accepted
**Date:** 2026-08-17
**Related:** [ADR-001](adr/001-imap-over-gmail-api.md) · [ADR-002](adr/002-zero-runtime-dependencies.md) ·
[ADR-003](adr/003-tiered-disclosure.md) · [ADR-004](adr/004-hybrid-triage-cascade.md) ·
[ADR-005](adr/005-earned-trust-backtest-and-reversibility.md)

## 1. Requirements

### Functional

| # | Capability | Command |
|---|------------|---------|
| F1 | Connect to any IMAP mailbox with an app password | `init`, `doctor` |
| F2 | Classify inbox mail into `now` / `later` / `brief` / `noise` | `triage` |
| F3 | Explain any individual decision | `why <uid>` |
| F4 | Summarize non-urgent mail into a digest | `brief` |
| F5 | Draft replies in the user's voice into the Drafts folder | `draft` |
| F6 | Apply decisions to the mailbox reversibly | `triage --apply` |
| F7 | Reverse the last applied run | `undo` |
| F8 | Score decisions against the user's real past behavior | `backtest` |
| F9 | Report its own token spend | `cost`, run summaries |

### Non-functional

| # | Requirement | Target |
|---|-------------|--------|
| N1 | Daily triage latency | < 30 s for a 200-message inbox |
| N2 | Marginal cost | < $4/month at 200 msg/day (vs. Cora's $20 flat) |
| N3 | Data egress | 0 bytes for deterministic decisions; bounded and auditable otherwise |
| N4 | Mail safety | No message is ever deleted or expunged; all mutations reversible |
| N5 | Dependencies | Zero runtime, zero dev |
| N6 | Portability | Node ≥ 18, Windows / macOS / Linux |
| N7 | Testability | Full pipeline testable offline with no account |

### Constraints

- Cannot register an OAuth application → IMAP + app password (ADR-001).
- Single-user, single-machine. No server, no multi-tenancy, no shared state.
- The author cannot create accounts, so the product must reach "ready to run"
  and hand off at exactly one user-performed step.

### Explicit non-goals

Not a mail client. No message rendering, no search UI, no attachment handling,
no calendar. It is a background process that decides, drafts, and explains.

## 2. High-level design

```
                        ┌──────────────────────────────┐
        CLI ───────────▶│  commands/                   │
   bin/cli.js           │  init triage brief draft     │
                        │  apply undo backtest why cost│
                        └───────┬──────────────────────┘
                                │
        ┌───────────────────────┼────────────────────────┐
        ▼                       ▼                        ▼
┌───────────────┐      ┌─────────────────┐      ┌─────────────────┐
│  mailbox/     │      │  triage/        │      │  store/         │
│  ┌──────────┐ │      │  ┌────────────┐ │      │  ┌────────────┐ │
│  │ Mailbox  │◀┼──────┤  │ signals    │ │      │  │ config     │ │
│  │ interface│ │      │  │ cascade    │◀┼──────┤  │ correspond.│ │
│  └────┬─────┘ │      │  │ correspond.│ │      │  │ journal    │ │
│       ▼       │      │  └─────┬──────┘ │      │  │ voice.md   │ │
│  ┌──────────┐ │      │        │        │      │  └────────────┘ │
│  │ imap/    │ │      │        ▼        │      └─────────────────┘
│  │ conn     │ │      │  ┌────────────┐ │
│  │ parser   │ │      │  │ llm/       │ │      ┌─────────────────┐
│  └──────────┘ │      │  │ redact ────┼─┼─────▶│ provider        │
└───────┬───────┘      │  │ anthropic  │ │      │ (network egress)│
        │              │  │ ollama     │ │      └─────────────────┘
        ▼              │  │ none       │ │
┌───────────────┐      │  └────────────┘ │
│  mime/        │      └─────────────────┘
│  headers      │
│  bodies       │              ▼
│  addresses    │      ┌─────────────────┐
└───────────────┘      │  report/        │
                       │  text · json    │
                       └─────────────────┘
```

**Dependency rule:** arrows point one way. `triage/` never imports `mailbox/`;
it operates on normalized `Message` objects. That is what makes the engine
testable without a server and what will let a second transport (JMAP, Gmail API)
drop in later without touching triage logic.

### Data flow — one `triage` run

```
1. config.load()                    → credentials from env or 0600 file
2. mailbox.connect()                → TLS + LOGIN + SELECT INBOX
3. mailbox.fetchHeaders(since)      → UID SEARCH + UID FETCH (headers only)
4. mime.parse()                     → normalized Message[]
5. correspondents.load()            → reply-history graph from disk
6. cascade.classify(msg, graph)     → Decision{label, confidence, reasons}  ← Tier 0
7. partition by confidence          → confident[] | ambiguous[]
8. redact + project ambiguous       → bounded payload                       ← Tier 1
9. llm.classifyBatch(payload)       → Decision[] merged back
10. report / or apply:
      journal.writeIntent(actions)  → write-ahead, fsync
      mailbox.applyLabels(actions)  → UID STORE / UID COPY, never delete
      journal.writeResult(actions)  → completion record
```

Step 10's ordering is deliberate: intent is durable *before* mutation, so a
crash mid-apply leaves a journal that `undo` can still act on. Writing the
journal after the mutation would create exactly the window where mail has moved
and nothing knows how to move it back.

## 3. Data model

```js
// Normalized message — the currency of the whole system.
Message {
  uid: number,              // IMAP UID, stable within a uidvalidity epoch
  messageId: string,        // RFC 5322 Message-ID
  threadId: string,         // derived: root of References chain
  from: Address,            // { name, email, domain }
  to: Address[], cc: Address[],
  subject: string,
  date: Date,
  flags: string[],          // \Seen, \Answered, \Flagged
  headers: Map<string,string>,
  bodyPreview: string,      // decoded text, truncated at projection time
  attachments: [{ filename, contentType, size }],  // named, never parsed
}

// Everything postclerk knows about a person, learned from the Sent folder.
Correspondent {
  email: string,
  sentTo: number,           // times the user wrote to them
  receivedFrom: number,
  lastSentAt: Date|null,
  medianReplyLatencyMs: number|null,   // how fast the user answers them
  isVip: boolean,           // explicit user rule
}

// A decision, always explainable.
Decision {
  uid: number,
  label: 'now'|'later'|'brief'|'noise',
  confidence: number,       // 0..1
  tier: 0|1,                // 0 = deterministic, 1 = model
  reasons: [{ code, detail, weight }],
  cost: { inputTokens, outputTokens, usd } | null,
}

// Append-only journal record. Every mutation stores its own inverse.
JournalEntry {
  runId: string, ts: string,
  phase: 'intent'|'result',
  action: 'move'|'flag'|'draft',
  uid: number, messageId: string,
  from: string, to: string,        // folder names — the inverse is (to → from)
  applied: boolean, error: string|null,
}
```

### Storage layout

```
~/.postclerk/
  config.json          # non-secret settings (mode 0600 anyway)
  state/
    correspondents.json  # the graph — rebuilt by `init`, updated per run
    messages.jsonl       # header cache; makes backtest possible without refetch
    uidvalidity.json     # per-folder epoch; mismatch invalidates the cache
  journal.jsonl        # append-only, every mutation + inverse
  voice.md             # learned writing style — plain text, user-editable
```

Everything is a plain file the user can read, diff, edit, or delete. There is no
database and no binary format. `voice.md` being editable Markdown rather than an
opaque embedding is a deliberate product choice: the user can correct how the
system thinks they write, which is impossible with a hosted competitor.

## 4. Key mechanisms

### 4.1 The cascade (ADR-004)

Signals are pure functions `(Message, Graph) → Signal|null`, evaluated in order.
Each contributes a labeled reason and a weight; the first *decisive* signal
short-circuits.

| Order | Signal | Evidence | Decisive? |
|-------|--------|----------|-----------|
| 1 | `user-rule` | explicit always/never list | yes |
| 2 | `bulk-header` | `List-Unsubscribe`, `Precedence: bulk` | yes → `brief` |
| 3 | `auto-submitted` | `Auto-Submitted: auto-*` | yes → `noise` |
| 4 | `thread-participant` | user sent in this thread | yes → `now` |
| 5 | `known-correspondent` | `sentTo ≥ 3` and recent | yes → `now` |
| 6 | `never-answered` | received ≥ 5, sentTo = 0 | yes → `brief` |
| 7 | `addressing` | direct `To:` vs. bulk `CC:` | no — weight only |
| 8 | `recency`, `subject-cues` | | no — weight only |

If no decisive signal fires and accumulated weight leaves confidence below
`escalateBelow` (default 0.75), the message escalates to Tier 1.

### 4.2 Escalation batching

Ambiguous messages are **batched into one model call**, not one call each. This
matters more than it looks:

- The system prompt + rubric is a stable prefix, so `cache_control: ephemeral`
  makes it a ~0.1× cache read on every subsequent call.
- Per-message overhead collapses from one round trip to one array element.
- Structured outputs (`output_config.format` with a JSON schema) guarantee a
  parseable array back, so there is no regex-scraping of prose.

Batch size defaults to 10 and is bounded by a projection-token budget.

### 4.3 Cost model

Measured assumptions: 200 inbox messages/day, 80% resolved at Tier 0, 40
escalating, batched 10/call → 4 calls/day. Projection ≈ 350 tokens/message,
system prefix ≈ 800 tokens (cached), output ≈ 40 tokens/message.

| Configuration | Input/day | Output/day | Monthly |
|---------------|-----------|------------|---------|
| Cascade + `claude-haiku-4-5` | 17.2K | 1.6K | **≈ $0.77** |
| Cascade + `claude-sonnet-5` | 17.2K | 1.6K | ≈ $2.25 |
| Cascade + `claude-opus-5` | 17.2K | 1.6K | ≈ $3.80 |
| *No cascade*, Opus 5 per message | 80K | 8K | ≈ $18.00 |
| Cora (flat subscription) | — | — | $20.00 |
| `provider: ollama` | 0 | 0 | $0.00 |

The last two rows are the argument. A naive LLM-per-message build lands at
essentially Cora's price with none of Cora's polish — the cascade is what makes
a self-hosted tool cheaper rather than merely different. The default model is
`claude-opus-5`; model choice is configuration, and the table is in the docs so
the trade is the user's to make, not one made silently on their behalf.

Every run prints actual measured spend, so these projections are checkable
rather than promotional.

### 4.4 Provider interface

```js
Provider {
  name: string,
  classify(batch, opts) → { decisions, usage },
  summarize(messages, opts) → { text, usage },
  draft(message, voice, opts) → { subject, body, usage },
}
```

Three implementations: `anthropic` (raw HTTPS to `/v1/messages`), `ollama`
(localhost, zero egress), and `none` (Tier 0 only — degraded but functional,
which is what makes a zero-config first run possible).

**Deviation recorded:** house guidance is to call Claude through the official
SDK. This project calls the Messages API over raw `fetch` instead, because
ADR-002 forbids adding any dependency to a process that holds the user's whole
mailbox and an API key. The deviation is confined to `lib/llm/anthropic.js`.

## 5. Failure modes

| # | Failure | Detection | Response |
|---|---------|-----------|----------|
| 1 | IMAP connection drops mid-run | socket error / timeout | Reconnect once, resume from last UID; decisions already journaled stay valid |
| 2 | Crash between intent and mutation | intent record with no result on next start | `undo` replays from intent; `doctor` reports the orphan |
| 3 | `UIDVALIDITY` changed (folder recreated) | probe on SELECT | Invalidate header cache and correspondent UIDs; full resync |
| 4 | Model returns malformed output | schema validation fails | Fall back to `later` (the safe label) and record the failure as a reason |
| 5 | Model rate-limited (429) | HTTP status + `retry-after` | Honor `retry-after`, exponential backoff, then degrade the run to Tier 0 |
| 6 | Model refuses (`stop_reason: refusal`) | response field | Treat as no-answer → `later`; never surface partial content as a decision |
| 7 | `max_tokens` truncation | `stop_reason: max_tokens` | Halve batch size and retry once |
| 8 | Credential invalid / expired | LOGIN fails | Clear actionable error naming the provider's app-password page |
| 9 | Two runs concurrently | `~/.postclerk/lock` with pid | Second process exits non-zero rather than double-applying |
| 10 | Hostile / malformed MIME | bounded parser | Bounded allocations; undecodable parts become named attachments |
| 11 | Clock skew between server and client | — | All comparisons use server `INTERNALDATE`, never local time |

Failure 4 deserves a note: the safe fallback is `later`, never `noise`. Every
degradation path in this system fails toward *the user seeing the message*,
because the cost of a false `noise` is unbounded and the cost of a false `later`
is a few seconds of attention.

## 6. Security model

- **Credential** — read from `POSTCLERK_PASSWORD` or a 0600 file; never written
  to the journal, logs, error messages, or the header cache. A test asserts it
  never appears in any artifact.
- **Transport** — TLS with certificate verification on. No plaintext IMAP, no
  `rejectUnauthorized: false`, ever.
- **Egress** — only to the configured model provider. Auditable via `--explain`
  and the per-call SHA-256 + byte count in the journal.
- **Redaction** — mechanical, pre-network, regex-based (ADR-003). Reduces
  accidental disclosure of common secret shapes; explicitly not a guarantee.
  `provider: ollama` is the guarantee.
- **Destructive capability** — absent by construction. No `\Deleted`, no
  `EXPUNGE`, enforced by a test that greps the source.

## 7. What I'd revisit as this grows

- **Correspondent graph is O(sent mail)** in memory. Fine at 10⁴–10⁵ messages;
  above that it needs an on-disk index. Not worth building now.
- **`IDLE` for push.** Currently scheduled polling. `IDLE` is a modest addition
  once someone actually wants sub-minute latency.
- **Multi-account.** The config is single-account. Making it a list is easy; the
  interesting part is whether triage state should be shared or separate, and
  that should be answered by a user with two accounts, not guessed now.
- **Thread reconstruction** is `References`-based and will mis-thread mail from
  clients with broken headers. Acceptable; revisit if backtest shows it costs
  accuracy.
- **The escalation threshold is global.** Per-sender or per-folder thresholds
  are the obvious next tuning surface once backtest data exists across users.
