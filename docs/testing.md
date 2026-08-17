# postclerk — Test Strategy

**Status:** current as of 2026-08-17 · 108 tests, all passing
**Run:** `npm test` (≈2s, no network, no account, no API key)

## The constraint that shapes everything

postclerk cannot be tested the obvious way. There is no test mailbox, no
credentials, and no budget for model calls — and a suite that needs any of those
is a suite nobody runs, least of all in CI. So the strategy is built around one
requirement:

> **Every test runs offline, deterministically, with no account and no key.**

This is not a compromise. It forced two pieces of infrastructure that turned out
to be worth more than the tests themselves:

- **An in-process IMAP server** (`test/helpers/mock-imap-server.js`). Speaks the
  real wire protocol, including the parts that are easy to get wrong — literals,
  UID sets, and the APPEND continuation handshake. It emits literals where a
  lazier server would send quoted strings, precisely because the client must
  handle the harder form.
- **A fake model provider** (`test/helpers/fake-provider.js`). Answers
  deterministically and records every payload it was handed, which is how the
  egress tests prove redaction happened *before* the network boundary rather
  than after.

Together these mean the only things stubbed are the far end of a socket and the
model. Everything in between — the real IMAP client, real MIME decoding, the
real cascade, the real journal — is exercised as shipped.

## Distribution

```
        /  pipeline (22)  \      end-to-end, real client + real server
       /  adversarial (11)  \    attack surface, security boundaries
      /  imap (23) triage (19) \ protocol and decision logic
     /  mime (14) redact (10)    \ parsers and the security control
    /       safety (9)             \ guarantees enforced structurally
```

Weighted toward the middle rather than a classic pyramid, because the risk here
is concentrated in two places: hand-rolled protocol parsing (ADR-002 means we
own every MIME and IMAP edge case) and decision correctness (a wrong triage call
is the product failing at its job).

## What each layer covers

| Suite | Covers | Representative test |
|-------|--------|---------------------|
| `mime` | Header unfolding, RFC 2047 encoded-words, quoted-printable, multipart walking, HTML fallback, malformed input | *decodes quoted-printable bodies including soft line breaks* |
| `imap` | Response framing with literals, tokenizer, UID set compression, every command, error paths | *readResponse consumes literals rather than stopping at their CRLF* |
| `triage` | Correspondent graph, point-in-time queries, each signal in isolation, cascade ordering, determinism | *point-in-time stats do not leak the future into the past* |
| `redact` | Every redaction rule, Luhn validation, over-redaction, projection bounding and hashing | *masks card numbers that pass Luhn, and leaves other digit runs alone* |
| `pipeline` | Full runs over a real connection, apply/undo, crash recovery, backtest, state persistence | *a crashed run is still fully reversible from its intent record* |
| `adversarial` | Spoofing, prompt injection, false authority, proportionality of response | *instructions embedded in a message body do not change its classification* |
| `safety` | The product's hard guarantees, enforced against the source itself | *the codebase contains no way to delete mail* |

## The three test categories that carry the most weight

### 1. Guarantee tests (`safety.test.js`)

These do not test behavior. They assert that the product's promises are still
*structurally* true, by reading the source:

- No `EXPUNGE`, no `\Deleted`, no `DELETE` anywhere (ADR-005)
- `package.json` declares zero dependencies, and nothing imports a non-builtin
  module (ADR-002)
- TLS verification is never disabled
- Dry run is the default; applying requires an explicit flag
- The classification prompt carries a data-not-instruction boundary

A guarantee enforced only by intention decays the first time someone is in a
hurry. These fail the build instead. This is the highest-value-per-line code in
the repository.

### 2. Leakage tests (`triage`, `pipeline`, `redact`)

The privacy claim in ADR-003 is checkable, so it gets checked:

- Bodies of confidently-classified mail are never fetched, let alone sent —
  asserted by inspecting the actual `UID FETCH` commands the server received
- Secret-shaped strings never appear in anything the provider was handed
- `--explain` makes zero network calls
- The backtest builds its graph point-in-time, so accuracy cannot be inflated by
  knowledge from after the message being scored

That last one deserves emphasis: leakage in a backtest is the easiest way to
make a product look better than it is, and the only defense is a test that
fails when the future is consulted.

### 3. Adversarial tests (`adversarial.test.js`)

Email is the worst-case agent input surface — anyone on earth can put arbitrary
text in front of the agent, unsolicited, for free. The fixtures are modeled on
the failure taxonomy in the *Agents of Chaos* study (Bau Lab): identity spoofing
accepted, authority treated as conversationally constructed, prompt injection
landing through read content.

The strongest test in the suite holds headers constant and varies only the body
across four escalating injection attempts, asserting the label and confidence
are *identical* across all four. That pins down the architectural property the
defense actually rests on: the deterministic layer computes over headers and
counts, so there is no code path by which body text can instruct it.

**These tests found two real bugs**, which is the point of writing them:
`addressing:direct` was weighted so heavily that any cold email addressed to you
scored urgent (phishing is always addressed directly to you), and a spoofed
sender inherited a trusted correspondent's standing because the graph keys on a
forgeable `From:` header.

## Coverage targets and deliberate gaps

Targets, by risk rather than by line count:

| Area | Target | Rationale |
|------|--------|-----------|
| Protocol framing and MIME decode | Every branch | We own these; a bug here corrupts everything downstream |
| Redaction rules | Every rule, both directions | It is a security control |
| Guarantees | 100% | Non-negotiable by definition |
| Signals | Each in isolation + in cascade | Interaction is where triage goes wrong |
| Rendering (`report.js`) | Smoke only | Cosmetic; failures are visible and harmless |

**Known gaps, stated rather than hidden:**

1. **No test against a real IMAP server.** The mock implements the protocol as
   specified; real servers deviate. Gmail's `\All` mailbox and Exchange's UID
   handling are the likeliest sources of first-contact bugs. Mitigation is
   `postclerk doctor`, which exercises the real connection on the user's own
   server. This is the single largest residual risk.
2. **No test of the live Anthropic provider.** `anthropic.js` is exercised only
   through unit-level parsing; the HTTP path is covered by construction (it is
   a single `fetch` with a fixed body shape) but not by execution.
3. **Charset long tail.** `TextDecoder` handles what ICU handles. Exotic legacy
   encodings fall back to latin1, which is ugly rather than wrong.
4. **No performance tests.** At single-user scale the numbers are not
   interesting; the bounded-allocation tests cover the failure that would matter.

## Example: what a good test here looks like

```js
test('bodies of confidently-classified mail are never fetched or transmitted', async () => {
  // Assert against the commands the server actually received, not against
  // what the code says it does.
  const bodyFetches = server.commandLog.filter((l) => /UID FETCH .*BODY\.PEEK\[\]/.test(l));
  for (const line of bodyFetches) {
    for (const uid of uidsIn(line)) {
      assert.ok(escalatedUids.has(uid),
        `fetched body of uid ${uid}, which was resolved locally and never needed it`);
    }
  }
});
```

Two properties every test here tries to have: it asserts on **observable
effects** (commands sent, bytes handed to the provider, files on disk) rather
than on internal state, and its failure message says what went wrong in terms of
the user's interest, not the assertion's mechanics.

## Running

```bash
npm test
```

```bash
node --test "test/adversarial.test.js"
```

CI needs nothing but Node ≥ 18. No services, no secrets, no fixtures to
download — which is the whole point.
