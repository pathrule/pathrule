// SPDX-License-Identifier: Apache-2.0
// Versioning helpers for content-addressable response shaping.
//
// `stableHash()` produces an 8-char hash over a value's canonical JSON
// (sorted keys, deterministic array order). Used by get_context to fingerprint
// `protocol` and `workspace_overview` so clients can pass back
// `known_*_version` and skip retransmission of unchanged content.
//
// `dropUndefined()` strips keys whose value is `undefined` from a shallow
// object — used by the briefing assembler to emit `{}` instead of empty
// arrays when a section has no content.

/**
 * 8-char FNV-1a 32-bit hash over the canonical JSON of `value`.
 *
 * Isomorphic (Node + browser), synchronous, zero dependencies — required
 * because this runs in a browser bundle too (node:crypto would fail
 * Vite's browser externalization).
 *
 * Collision space ≈ 4.3 billion — acceptable for per-workspace field-level
 * cache keys (we never index across workspaces with this).
 */
export function stableHash(value: unknown): string {
  const str = canonicalJson(value);
  let hash = 2166136261; // FNV offset basis (32-bit)
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV prime (32-bit)
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map(
      (k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k]),
    );
    return "{" + entries.join(",") + "}";
  }
  return JSON.stringify(value);
}

/** Strip keys whose value is `undefined` from a shallow object (non-mutating). */
export function dropUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as Array<keyof T>) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}
