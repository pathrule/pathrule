// SPDX-License-Identifier: Apache-2.0

const REDACTED = "[redacted]";
const REDACTED_EMAIL = "[redacted-email]";
const REDACTED_PATH = "[redacted-path]";

const SENSITIVE_KEY_RE =
  /(authorization|password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|pair[_-]?token|session|cookie|env|environment|cache|content|body|file[_-]?content)/i;
const PATH_KEY_RE =
  /(^|[_-])(path|paths|cwd|directory|root|repo|local_root|workspace_root)([_-]|$)/i;
const TOKEN_VALUE_RE = /\b(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{24,}\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const POSIX_PATH_RE =
  /(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+|\/var\/folders\/[^\s"']+|\/tmp\/[^\s"']+)/g;
const WINDOWS_PATH_RE = /[A-Za-z]:\\(?:[^\\\s"']+\\?)+/g;

export type SupportBundleJson =
  | null
  | boolean
  | number
  | string
  | SupportBundleJson[]
  | { [key: string]: SupportBundleJson };

export function redactSupportBundleValue(value: unknown, keyHint = ""): SupportBundleJson {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (isSensitiveKey(keyHint)) return REDACTED;
  if (typeof value === "string") return redactSupportString(value, keyHint);
  if (Array.isArray(value)) {
    return value.map((item) => redactSupportBundleValue(item, keyHint));
  }
  if (typeof value === "object") {
    const output: Record<string, SupportBundleJson> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactSupportBundleValue(child, key);
    }
    return output;
  }
  return REDACTED;
}

export function redactSupportString(value: string, keyHint = ""): string {
  if (!value) return value;
  if (isPathKey(keyHint)) return REDACTED_PATH;
  if (isSensitiveKey(keyHint)) return REDACTED;

  return value
    .replace(EMAIL_RE, REDACTED_EMAIL)
    .replace(POSIX_PATH_RE, REDACTED_PATH)
    .replace(WINDOWS_PATH_RE, REDACTED_PATH)
    .replace(TOKEN_VALUE_RE, REDACTED);
}

export function sanitizeBridgeSupportState(state: unknown): SupportBundleJson {
  return redactSupportBundleValue(state);
}

export function assertSupportBundleHasNoSecrets(value: unknown): void {
  const serialized = JSON.stringify(value);
  const leakedPatterns = [
    /Bearer\s+[A-Za-z0-9._~+/=-]+/i,
    /access[_-]?token["':\s]+[A-Za-z0-9._~+/=-]{8,}/i,
    /refresh[_-]?token["':\s]+[A-Za-z0-9._~+/=-]{8,}/i,
    /pair[_-]?token["':\s]+[A-Za-z0-9._~+/=-]{8,}/i,
    /\/Users\/[^/"']+/,
    /\/home\/[^/"']+/,
    /[A-Za-z]:\\[^"']+/,
  ];
  for (const pattern of leakedPatterns) {
    if (pattern.test(serialized)) {
      throw new Error(`support bundle contains sensitive material matching ${pattern}`);
    }
  }
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

function isPathKey(key: string): boolean {
  return PATH_KEY_RE.test(key);
}
