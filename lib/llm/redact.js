'use strict';

/**
 * Mechanical redaction, applied before any byte crosses the network (ADR-003).
 *
 * WHAT THIS IS: a conservative set of regexes for secret shapes whose leakage
 * is unambiguously bad — one-time codes, API keys, bearer tokens, card numbers,
 * government IDs, and URLs carrying credentials.
 *
 * WHAT THIS IS NOT: a guarantee. No pattern list is exhaustive, and a secret
 * that does not look like a secret will pass straight through. The honest claim
 * is that this reduces accidental disclosure of common secret shapes. The
 * guarantee is `provider: ollama`, which sends nothing anywhere.
 *
 * Redaction is deliberately NOT model-mediated: asking an LLM what is sensitive
 * would require sending it the sensitive thing first.
 */

const RULES = [
  {
    name: 'api-key',
    // Vendor-prefixed keys are unmistakable and worth catching first.
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g,
  },
  {
    name: 'bearer-token',
    pattern: /\b(?:Authorization\s*:\s*)?(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: 'credential-url',
    // A URL carrying a token/key/secret/password is a credential in transit.
    pattern: /https?:\/\/[^\s<>"']*[?&](?:token|key|secret|password|passwd|auth|access_token|api_key)=[^\s<>"'&]+/gi,
  },
  {
    name: 'reset-link',
    pattern: /https?:\/\/[^\s<>"']*\/(?:reset|verify|confirm|activate|magic|login)\/[A-Za-z0-9._-]{12,}/gi,
  },
  {
    name: 'otp',
    // Only digits *labeled* as a code — a bare 6-digit number is usually a year,
    // an invoice number, or a quantity, and redacting those hurts triage.
    pattern: /\b(?:code|otp|pin|passcode|verification code|security code)\b\D{0,24}\b(\d{4,8})\b/gi,
  },
  {
    name: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    name: 'card-number',
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    // Digit runs are common; only redact ones that pass the checksum a real
    // card must satisfy. This keeps order numbers and IDs readable.
    validate: luhn,
  },
  {
    name: 'password-assignment',
    pattern: /\b(?:password|passwd|pwd|secret)\s*[:=]\s*\S{6,}/gi,
  },
];

/** Luhn checksum — the property every real payment card number satisfies. */
function luhn(candidate) {
  const digits = String(candidate).replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Redact secret-shaped strings from text.
 * @returns {{ text: string, redactions: Array<{rule:string,count:number}> }}
 */
function redact(input) {
  let text = String(input ?? '');
  const counts = new Map();

  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match, ...groups) => {
      if (rule.validate && !rule.validate(match)) return match;

      counts.set(rule.name, (counts.get(rule.name) || 0) + 1);

      // For labeled patterns keep the label and mask only the secret, so the
      // model still learns "this is a verification code email" — which is
      // exactly the kind of thing it should be filing as noise.
      if (rule.name === 'otp' && groups[0]) {
        return match.replace(groups[0], '[REDACTED:otp]');
      }
      return `[REDACTED:${rule.name}]`;
    });
  }

  return {
    text,
    redactions: [...counts].map(([rule, count]) => ({ rule, count })),
  };
}

/** True if the text contains anything the rules would mask. */
function containsSecrets(input) {
  return redact(input).redactions.length > 0;
}

module.exports = { redact, containsSecrets, luhn, RULES };
