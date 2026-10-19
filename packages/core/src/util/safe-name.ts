// SPDX-License-Identifier: Apache-2.0

export type SafeNameKind = "profile" | "organization" | "workspace";

export type SafeNameReason =
  | "empty"
  | "too_long"
  | "url_like"
  | "control_chars"
  | "html_like"
  | "reserved";

export interface SafeNameResult {
  ok: boolean;
  value?: string;
  reason?: SafeNameReason;
}

const MAX_LENGTH_BY_KIND: Record<SafeNameKind, number> = {
  profile: 80,
  organization: 100,
  workspace: 120,
};

const PLATFORM_RESERVED_NAMES = new Set([
  "pathrule",
  "pathrule admin",
  "pathrule support",
  "pathrule security",
]);

const PROFILE_RESERVED_NAMES = new Set(["admin", "administrator", "security", "support", "system"]);

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHAR_GLOBAL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;
const HTML_LIKE_PATTERN = /<\/?[a-z][^>]*>/i;
const URL_SCHEME_PATTERN = /(^|\s)(https?:\/\/|javascript:|data:|mailto:)/i;
const PROFILE_DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeSafeDisplayName(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function validateSafeDisplayName(input: string, kind: SafeNameKind): SafeNameResult {
  if (CONTROL_CHAR_PATTERN.test(input)) {
    return { ok: false, reason: "control_chars" };
  }

  const value = normalizeSafeDisplayName(input);

  if (value.length === 0) {
    return { ok: false, reason: "empty" };
  }

  if (Array.from(value).length > MAX_LENGTH_BY_KIND[kind]) {
    return { ok: false, reason: "too_long" };
  }

  if (HTML_LIKE_PATTERN.test(value)) {
    return { ok: false, reason: "html_like" };
  }

  if (URL_SCHEME_PATTERN.test(value)) {
    return { ok: false, reason: "url_like" };
  }

  if (kind === "profile" && PROFILE_DOMAIN_PATTERN.test(value)) {
    return { ok: false, reason: "url_like" };
  }

  const folded = value.toLocaleLowerCase("en-US");
  if (kind !== "workspace" && PLATFORM_RESERVED_NAMES.has(folded)) {
    return { ok: false, reason: "reserved" };
  }

  if (kind === "profile" && PROFILE_RESERVED_NAMES.has(folded)) {
    return { ok: false, reason: "reserved" };
  }

  return { ok: true, value };
}

export function safeDisplayNameOrNull(input: unknown, kind: SafeNameKind): string | null {
  if (typeof input !== "string") return null;
  const result = validateSafeDisplayName(input, kind);
  return result.ok ? (result.value ?? null) : null;
}

export function safeHttpUrlOrNull(input: unknown, maxLength = 2048): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (!value || value.length > maxLength || CONTROL_CHAR_PATTERN.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function escapeTerminalControlChars(input: string): string {
  return input.replace(CONTROL_CHAR_GLOBAL_PATTERN, (char) => {
    if (char === "\n") return "\\n";
    if (char === "\r") return "\\r";
    if (char === "\t") return "\\t";
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}
