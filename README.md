# postclerk

**A local-first AI chief of staff for your inbox.** It triages your mail, writes
you a digest, and drafts replies in your voice — over plain IMAP, on your own
machine, with zero dependencies.

It will not delete your mail. It cannot: there is no delete anywhere in the
codebase, and a test fails the build if one appears.

```bash
postclerk backtest --days 30
```

```
  Agreement  84% (211/251 messages)

  Errors that matter
    ✓ nothing important would have been buried
    ~ 6 message(s) surfaced that you ignored

  Economics
    escalated to model  38/251 (15%)
    projected cost      $0.91/month with claude-haiku-4-5
```

That command is the point of the whole project. Before postclerk touches
anything, it replays your last month of real mail and scores its decisions
against what you actually did — did you reply, did you archive, how fast. You
get to evaluate it on your own inbox before granting it a single write.

---

## Why this instead of a hosted assistant

The incumbent in this space is [Cora](https://cora.computer) ($20/month). It is
a good product. It is also Gmail-only, processes your entire inbox on someone
else's servers, and asks you to take its accuracy on faith.

| | Cora | postclerk |
|---|---|---|
| Mail providers | Gmail / Workspace only | Any IMAP host — Fastmail, iCloud, Proton Bridge, Outlook, self-hosted, corporate |
| Where your mail is processed | Vendor servers | Your machine |
| What leaves your machine | Everything | ~15% of messages, redacted and truncated — or nothing at all |
| Cost | $20/month | ~$1–4/month at your own API rates, or $0 with a local model |
| Can it delete your mail? | Yes (archives) | **No — structurally incapable** |
| Prove it works before trusting it | — | `postclerk backtest` |
| Auditable | No | ~3,000 lines, zero dependencies |
| Extensible | No | MIT, `--json` on everything |

The honest version of that table: Cora is a polished product with a real team
behind it, and if you are on Gmail and comfortable with cloud processing, it will
be a smoother experience today. postclerk is for the people that offer does not
reach — anyone not on Gmail, and anyone who cannot send their correspondence to a
third party at all.

---

## Quick start

**Requirements:** Node ≥ 18. Nothing else.

### 1. Get an app password

postclerk authenticates with an app password, not OAuth, which is why it works
with any provider and needs nothing registered anywhere.

| Provider | Where | Host |
|---|---|---|
| Fastmail | Settings → Privacy & Security → App passwords | `imap.fastmail.com` |
| Gmail | myaccount.google.com → Security → App passwords (needs 2FA) | `imap.gmail.com` |
| iCloud | appleid.apple.com → Sign-In and Security → App-Specific Passwords | `imap.mail.me.com` |
| Outlook / 365 | Security → Advanced → App passwords (if your admin permits) | `outlook.office365.com` |
| Proton | Run Proton Bridge; use the credentials it gives you | `127.0.0.1` (port 1143) |

### 2. Connect

```bash
export POSTCLERK_PASSWORD='your-app-password'
```

```bash
npx postclerk init --host imap.fastmail.com --user you@example.com
```

`init` connects, finds your Sent and Drafts folders, and reads your sent mail to
learn who you actually correspond with and how you write. Nothing is sent
anywhere; nothing in your mailbox is modified.

### 3. See how it would do

```bash
npx postclerk backtest --days 30
```

### 4. Triage

```bash
npx postclerk triage
```

Dry run — it prints what it would do and changes nothing. When the output looks
right:

```bash
npx postclerk triage --apply
```

Wrong about something? One command:

```bash
npx postclerk undo
```

---

## How it decides

Most inbox assistants ask a model about every message. postclerk asks itself
first, and only escalates what it genuinely cannot resolve.

```
  message ──▶ your rules ──▶ bulk headers ──▶ identity check
                                                    │
              ┌─────────────────────────────────────┘
              ▼
        thread history ──▶ correspondent graph ──▶ addressing & cues
              │
              ├── confident (≈85%) ──▶ decided locally, $0, nothing sent
              └── ambiguous (≈15%) ──▶ redacted projection ──▶ model
```

The correspondent graph is the interesting part. It is built from your **Sent
folder** — who you write to, how often, how fast you reply. On the question
*"does this person need my attention"*, that is not a guess: it is observed
behavior about that exact relationship. A model reasoning from priors about
people in general cannot beat it, and the graph costs nothing to consult.

Every decision carries its reasons:

```bash
postclerk why 4821
```

```
  Dana Whitfield
  Re: contract redline — one open question
  uid 4821 · 2026-08-13T14:22:00.000Z

  decision   now (confidence 0.90, tier 0)

  because
    ● you have written to them 14 time(s), last 2 day(s) ago
```

---

## Labels and what happens to mail

| Label | Meaning | Action |
|---|---|---|
| `now` | Needs you, soon | **Stays in your inbox**, flagged |
| `later` | Yours, not urgent | Copied to `postclerk/Later` |
| `brief` | Informational | Copied to `postclerk/Brief`, included in the digest |
| `noise` | No value | Copied to `postclerk/Noise` |

Filing is done with IMAP `COPY`, never `MOVE` — the original stays where it was.
The worst case of a wrong decision is a duplicate, never a lost message.

---

## Commands

| Command | What it does |
|---|---|
| `init` | Connect, detect folders, learn from Sent |
| `doctor` | Check config, connection, folders, unfinished runs |
| `backtest [--days N]` | Score triage against your real behavior |
| `triage [--apply]` | Classify the inbox (dry run by default) |
| `brief [--days N]` | Digest of low-priority mail |
| `draft <uid> [--apply]` | Draft a reply into Drafts — never sends |
| `why <uid>` | Explain one decision |
| `undo` | Reverse the last applied run |
| `cost` | What postclerk has spent |

Useful flags: `--json` on everything, `--explain` to print the exact bytes that
*would* go to a model without sending them, `--home DIR` for an alternate state
directory.

---

## Configuration

`~/.postclerk/config.json`, created by `init`.

```jsonc
{
  "imap": { "host": "imap.fastmail.com", "port": 993, "user": "you@example.com" },
  "self": ["you@example.com", "you@work.example"],
  "folders": {
    "later": "postclerk/Later",
    "brief": "postclerk/Brief",
    "noise": "postclerk/Noise"
  },
  "triage": {
    "escalateBelow": 0.75,        // below this confidence, ask the model
    "knownCorrespondentMinSent": 3,
    "lookbackDays": 7,
    "batchSize": 10
  },
  "llm": {
    "provider": "none",           // none | anthropic | ollama
    "model": "claude-opus-5",
    "bodyChars": 2000             // how much body text may ever be sent
  },
  "rules": { "vips": [], "muted": [] }
}
```

**Your password is never stored here.** It is read from `POSTCLERK_PASSWORD`, or
from a file you point `imap.passwordFile` at.

### Choosing a model

`provider: "none"` is a real configuration, not a placeholder — deterministic
triage alone is genuinely useful, and it is the default so your first run works
before you decide to trust anything with your mail.

| Provider | Monthly (≈200 msgs/day) | Mail leaves machine? |
|---|---|---|
| `none` | $0 | Never |
| `ollama` (local) | $0 | Never |
| `anthropic` + `claude-haiku-4-5` | ~$0.77 | ~15%, redacted |
| `anthropic` + `claude-sonnet-5` | ~$2.25 | ~15%, redacted |
| `anthropic` + `claude-opus-5` (default) | ~$3.80 | ~15%, redacted |

For comparison, asking a model about *every* message — the obvious way to build
this — costs about $18/month on Opus 5, which is roughly a subscription's worth.
The cascade is what makes running it yourself cheaper rather than merely
different. Every run prints what it actually spent, so you never have to take
these projections on faith.

### Voice

`~/.postclerk/voice.md` is a plain Markdown file learned from your Sent folder —
typical reply length, how you open and close, whether you use contractions.
**Edit it.** Anything you write there overrides what was inferred, which is not
something you can do with a hosted assistant.

---

## Privacy, in specific terms

Three tiers, and you choose which one you are on:

- **Nothing leaves.** Most mail is decided from headers and your own reply
  history. No network call, no cost.
- **A bounded projection leaves.** Ambiguous mail only: sender, subject, date,
  how you were addressed, and a truncated body preview with secret-shaped
  strings masked first. Every call's payload hash and byte count is journaled.
- **Nothing leaves, ever.** `provider: "ollama"` runs everything locally.

Verify rather than trust:

```bash
postclerk triage --explain
```

That prints the exact bytes that would be transmitted, and transmits nothing.

Redaction masks API keys, bearer tokens, one-time codes, card numbers (Luhn-
checked, so your order numbers stay readable), government IDs, and URLs carrying
credentials. **It is a reduction in accidental disclosure, not a guarantee** —
no pattern list is exhaustive. If you need a guarantee, use `ollama`. Full
detail in [docs/security.md](docs/security.md).

---

## Safety guarantees

These are enforced by tests that fail the build, not by good intentions:

- **No delete path exists.** No `\Deleted`, no `EXPUNGE`, no `DELETE`.
- **No send path exists.** Drafts are staged with `\Draft` for your review.
- **Dry run is the default.** Writes require `--apply`.
- **Every mutation is journaled before it happens**, with its inverse, so a run
  interrupted halfway is still fully reversible.
- **Zero dependencies.** Nothing but the Node standard library, so the code that
  reads your mail is code you can actually review.

See [docs/adr/005](docs/adr/005-earned-trust-backtest-and-reversibility.md).

---

## Automating it

```bash
0 8,17 * * * POSTCLERK_PASSWORD=$(cat ~/.postclerk/pw) postclerk triage --apply
```

Unattended runs are defensible here specifically because the worst case is
"some mail was copied to a folder and one command puts it back."

---

## Documentation

| Doc | What's in it |
|---|---|
| [Design](docs/design.md) | Components, data model, failure modes, cost model |
| [Security](docs/security.md) | Threat model, what leaves, what we don't promise |
| [Testing](docs/testing.md) | Strategy, coverage, known gaps |
| [ADR-001](docs/adr/001-imap-over-gmail-api.md) | Why IMAP, not the Gmail API |
| [ADR-002](docs/adr/002-zero-runtime-dependencies.md) | Why zero dependencies |
| [ADR-003](docs/adr/003-tiered-disclosure.md) | What may leave the machine |
| [ADR-004](docs/adr/004-hybrid-triage-cascade.md) | Why rules before the model |
| [ADR-005](docs/adr/005-earned-trust-backtest-and-reversibility.md) | Backtest and reversibility |

## Development

```bash
npm test
```

108 tests, ~2 seconds, no network and no account — there is an in-process IMAP
server and a fake model provider in `test/helpers/`.

**If you contribute, please do not add a dependency.** It is the one rule. The
central claim of this project is that you can read all of it in an afternoon,
and every package added is a package the reader has to trust instead.

## License

MIT.
