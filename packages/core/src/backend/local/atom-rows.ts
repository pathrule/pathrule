// SPDX-License-Identifier: Apache-2.0
/**
 * One `knowledge_atoms` row back to its typed atom, for every kind.
 *
 * The payload is the whole atom, so the columns are an index, except for lifecycle: a decision
 * updates the columns, and a stale payload must never resurrect a status or an authority the user
 * already changed. `trusted` names the authorities this kind may carry besides `inferred`.
 */
export const ADVISORY_TRUSTED = ["human", "grounded"] as const;
export const HUMAN_ONLY = ["human"] as const;

export function rowToAtom<T extends { status: string; authority: string; approved_by: string | null }>(
  row: Record<string, unknown>,
  parse: (raw: unknown) => T | null,
  trusted: readonly T["authority"][],
): T | null {
  const payload = typeof row["payload"] === "string" ? row["payload"] : "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const atom = parse(parsed);
  if (!atom) return null;
  const status = row["status"];
  const authority = row["authority"] as T["authority"];
  return {
    ...atom,
    status: status === "active" || status === "rejected" ? status : "proposed",
    authority: trusted.includes(authority) ? authority : "inferred",
    approved_by: typeof row["approved_by"] === "string" ? row["approved_by"] : null,
  };
}
