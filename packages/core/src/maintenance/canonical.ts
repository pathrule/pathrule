// SPDX-License-Identifier: Apache-2.0
// Knowledge Maintenance's content hash: SHA-256 over canonical JSON (keys sorted at every level).
// Open, because the engine builds the fingerprints and precondition hashes the host checks.
import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function maintenanceHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
