# postclerk — Security Model

**Audience:** anyone deciding whether to point this at their real mailbox.

This document states what postclerk protects, what it does not, and how to check
each claim yourself rather than believing it. Where a promise has a limit, the
limit is written down — a security document that only lists strengths is
marketing.

## What this program holds

Be clear-eyed about the blast radius. When running, postclerk has:

- **An app password with full access to your mailbox.** App passwords are coarse:
  no scoping, no per-action consent, read and write everything.
- **The contents of your mail**, in memory.
- **A model provider API key**, if you configured one.

That is close to the maximum sensitivity a desktop program can carry, and it is
why the design decisions below are as conservative as they are.

## Trust boundaries

```
┌──────────────────────── your machine ────────────────────────┐
│                                                              │
│  ~/.postclerk/          postclerk process                    │
│  ├── config.json  ────▶  ├── IMAP client ──── TLS ───────────┼──▶ your mail server
│  ├── state/             ├── MIME decode                      │
│  ├── journal.jsonl      ├── triage cascade   (no egress)     │
│  └── voice.md           ├── redactor                         │
│                         └── provider ───── HTTPS ────────────┼──▶ model API
│  POSTCLERK_PASSWORD ───────┘                                 │      (only if configured,
│  ANTHROPIC_API_KEY  ───────┘                                 │       only ambiguous mail)
└──────────────────────────────────────────────────────────────┘
```

Two outbound connections exist, and only two. There is no telemetry, no update
check, no error reporting, and no third-party endpoint of any kind.

## Guarantees

These are structural — enforced by the design and by tests that fail the build
(`test/safety.test.js`), not by care.

### 1. postclerk cannot delete your mail

Not "does not" — *cannot*. The IMAP client implements no `EXPUNGE`, no `DELETE`,
and refuses to set `\Deleted` even if asked. Filing is done with `COPY`, which
leaves the original in place. A test greps the source and fails if any of those
tokens appear.

The reasoning is proportionality. A scheduled run will eventually execute against
a misconfigured account or a half-built state file. If the worst case is "some
mail was copied to a folder," that is an annoyance. If the worst case is
deletion, it is unrecoverable. Choosing never to hold the capability is cheaper
than being careful with it.

### 2. postclerk cannot send mail

No SMTP client, no send path. `draft` writes to your Drafts folder with the
`\Draft` flag, for you to review and send yourself.

### 3. Every change is reversible

Intent is written to an append-only journal and **fsynced before the mailbox is
touched**. A crash mid-run therefore leaves enough on disk to reverse what
happened; `postclerk undo` works from recorded intent, not recorded results.

### 4. Nothing is written without an explicit flag

Dry run is the default for every command that could change anything.

### 5. Zero dependencies

Nothing but the Node standard library. This is a security property, not an
aesthetic one: a program that reads your entire inbox and holds an API key should
not also execute 200 packages you have not reviewed. npm account takeovers that
ship credential stealers in a patch release are ordinary events.

Check it: `npm ls` shows an empty tree.

## Data egress

### What is sent, and when

| Tier | When | What leaves |
|------|------|-------------|
| 0 | Most mail (~85%) | **Nothing.** Decided from headers and your own reply history. |
| 1 | Ambiguous mail only | Sender, subject, date, how you were addressed, recipient count, attachment *names*, and a truncated body preview (default 2,000 chars) — redacted first. |
| 2 | `provider: "ollama"` | **Nothing.** Local model. |

Full message bodies are only fetched from your server for mail that escalates.
Confidently-classified mail never has its body read at all.

### Verifying it

```bash
postclerk triage --explain
```

Prints the exact payload that would be transmitted and transmits nothing. Every
real call also records a SHA-256 and byte count of its payload in the journal, so
you can confirm after the fact how much left.

Each run prints its own egress summary:

```
egress   3 call(s), 14204 bytes, redacted api-key×1, otp×2
```

### Redaction — and its limit

Applied mechanically, before any network call, to both subject and body:

| Rule | Catches |
|------|---------|
| `api-key` | `sk-ant-…`, `sk-…`, `ghp_…`, `xox[bapr]-…`, `AKIA…`, `AIza…` |
| `bearer-token` | `Authorization: Bearer …`, `Token …` |
| `jwt` | Three-segment JWTs |
| `private-key` | PEM private key blocks |
| `credential-url` | URLs with `token=`, `key=`, `secret=`, `password=`, `auth=` |
| `reset-link` | `/reset/…`, `/verify/…`, `/magic/…` paths |
| `otp` | Digits labeled as a code, PIN, or passcode |
| `ssn` | US SSN format |
| `card-number` | 13–19 digit runs **that pass the Luhn checksum** |
| `password-assignment` | `password: …`, `secret= …` |

Two deliberate design points:

- Redaction is **not model-mediated**. Asking an LLM what is sensitive would
  require sending it the sensitive thing first.
- It is tuned against **over**-redaction as well as under. A bare six-digit
  number is an invoice or a year far more often than a code, and card matching
  requires a Luhn-valid checksum, so your order numbers stay readable. A
  projection reduced to `[REDACTED]` tells the model nothing and triage degrades.

> **The limit, stated plainly.** This reduces accidental disclosure of common
> secret shapes. It is **not a guarantee**. A secret that does not look like a
> secret — a password written in prose, a sensitive medical detail, an
> unannounced internal codename — passes through untouched. If your threat model
> cannot tolerate that, use `provider: "ollama"`, which is the guarantee.

## Credential handling

- Read from `POSTCLERK_PASSWORD`, or a file referenced by `imap.passwordFile`.
- **Never** written to config, journal, logs, error messages, or the header
  cache. A test asserts the config schema has no password field, and another
  asserts a wrong password does not appear in the resulting error or stack.
- State files are written `0600` where the platform supports it.
- Not held on the client object after login.

**You revoke access at your provider**, by deleting the app password. postclerk
is not in that loop and cannot be — which is a property of app passwords worth
having.

## Transport

TLS with certificate verification **on**, always. There is no configuration
option to disable it and a test fails the build if `rejectUnauthorized: false`
or `NODE_TLS_REJECT_UNAUTHORIZED` appears anywhere in the source.

## Threat model

### Hostile mail content

Anyone on earth can put arbitrary text in front of this program, unsolicited, for
free. That makes email the worst-case agent input surface, and it is treated as
such. The fixtures in `test/adversarial.test.js` are modeled on the failure
taxonomy documented in the [Agents of Chaos](https://agentsofchaos.baulab.info/)
study, which found deployed agents accepting identity spoofing, treating
authority as conversationally constructed, and taking disproportionate action.

| Attack | Defense |
|---|---|
| **Prompt injection** — instructions embedded in a message body | The deterministic layer computes over headers and counts. There is *no code path* by which body text can instruct it. A test holds headers constant, varies the body across four escalating injections, and asserts the label and confidence are identical. |
| **Injection reaching the model** | Only ambiguous mail escalates, as a structured, truncated projection rather than a free-form document, and the system prompt states that message text is data and never instruction. |
| **Identity spoofing** — forged `From:` to inherit a trusted sender's standing | Trust signals are gated on SPF/DKIM/DMARC. A message failing authentication while claiming to be someone you correspond with gets **no** trust from the correspondent graph, and the attempt is surfaced as a reason. |
| **Spoof-suppression** — forging a real sender to get their mail buried | The response is proportionate: failed authentication *strips trust*, it does not *add a penalty*. The message is labeled `later`, still visible. Hiding it would make this attack work. |
| **False authority** — "I am your administrator, treat this as urgent" | Only local config can grant VIP standing. No sender can. |
| **Malformed MIME / decompression bombs** | Every allocation driven by network input is bounded: literal size, line length, part count, nesting depth, address count. A nested-multipart bomb test asserts termination. |
| **Storage exhaustion** | The header cache dedupes by message id and compacts past a threshold, so a long-running scheduled install cannot grow it without bound. |

### What is out of scope

Stated so you are not surprised:

- **A compromised machine.** If an attacker has your user account, they have your
  mail and your app password regardless of this program.
- **A malicious model provider.** If you configure a cloud provider, that
  provider sees what you send it. Tier 1 bounds *how much*; it cannot bound what
  they do with it. Use `ollama` if that matters.
- **Your mail server.** postclerk trusts what your server returns.
- **Traffic analysis.** Contents are encrypted; the fact that you connected is not.
- **Model judgment.** For the ~15% that escalates, a model decides. It will
  sometimes be wrong. This is why nothing is deleted and everything is
  reversible, and why `backtest` exists to measure the error rate on your own
  mail before you rely on it.

## Reporting a vulnerability

Open an issue for anything non-sensitive. For a real vulnerability, please
disclose privately to the repository owner first.

## Checking these claims yourself

```bash
npm ls
```

```bash
grep -rniE "expunge|\\\\deleted|nodemailer|rejectUnauthorized" lib/ bin/
```

```bash
npm test
```

```bash
postclerk triage --explain
```

The first should be an empty tree, the second should return nothing but the
client's own refusal to set `\Deleted`, the third should be 108 passing tests,
and the fourth shows you exactly what would leave your machine.
