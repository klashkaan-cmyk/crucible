/**
 * Hardcoded-secret detection patterns, shared by the `no_secrets` assertion and
 * `crucible lint`. Conservative on purpose: each pattern targets a concrete,
 * high-confidence secret shape so the false-positive rate stays low.
 */

export interface SecretPattern {
  readonly name: string;
  readonly re: RegExp;
}

export const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "openai-key", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "anthropic-key", re: /sk-ant-[A-Za-z0-9-]{20,}/ },
  { name: "github-token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "generic-secret", re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{8,}["']/i },
];

/** Return the first matching secret pattern in `content`, or null. */
export function findSecret(content: string): { name: string } | null {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(content)) return { name };
  }
  return null;
}
