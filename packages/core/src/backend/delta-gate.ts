// SPDX-License-Identifier: Apache-2.0
/**
 * Delta gate — the pure core of cache-stable, delta-driven context injection.
 *
 * Given the SELECTED relevant items (from the selector / moat) and the session
 * LEDGER of what has already been injected, it emits ONLY the items that are new
 * or changed. When nothing is new, it emits nothing — so the hook injects
 * nothing, the agent context stays byte-identical, and the prompt cache holds
 * (the cache-stability invariant). Full bodies for emitted items are fetched
 * from the warehouse by the caller; this module is pure (no I/O, no clock).
 *
 * Re-injection triggers, per item:
 *   1. id not seen this session            → new
 *   2. content_hash changed since last      → edited (warehouse body is stale in context)
 *   3. relevance_signature changed          → newly relevant for this path/intent
 */

export type DeltaItemType = "memory" | "rule" | "skill";

export interface SelectedItem {
  id: string;
  type: DeltaItemType;
  /** sha256(content) prefix from the matching index (see hook-index.ts). */
  content_hash: string;
  /** Selection key: rule event signature, or memory/skill relevance key. */
  relevance_signature: string;
}

export interface InjectedRecord {
  id: string;
  content_hash: string;
  relevance_signature: string;
  last_at?: string;
  last_file_tool_count?: number;
}

export type DeltaReason = "new" | "content_changed" | "relevance_changed";

export interface DeltaResult {
  /** Items to inject this turn (full body), new or changed only. */
  emit: Array<SelectedItem & { reason: DeltaReason }>;
  /** Ids present in both and identical — deliberately NOT re-injected (silence). */
  unchanged: string[];
}

/**
 * Pure delta computation. `ledger` is the session's already-injected records.
 * Empty `emit` ⇒ the hook injects nothing this turn (cache holds).
 */
export function computeDelta(selected: SelectedItem[], ledger: InjectedRecord[]): DeltaResult {
  const byId = new Map<string, InjectedRecord>();
  for (const r of ledger) byId.set(r.id, r);

  const emit: DeltaResult["emit"] = [];
  const unchanged: string[] = [];

  for (const item of selected) {
    const prior = byId.get(item.id);
    if (!prior) {
      emit.push({ ...item, reason: "new" });
    } else if (prior.content_hash !== item.content_hash) {
      emit.push({ ...item, reason: "content_changed" });
    } else if (prior.relevance_signature !== item.relevance_signature) {
      emit.push({ ...item, reason: "relevance_changed" });
    } else {
      unchanged.push(item.id);
    }
  }

  return { emit, unchanged };
}

/**
 * Pure ledger update: fold the emitted items back into the ledger so the next
 * turn sees them as already-injected. Caller stamps `at` / `fileToolCount`.
 * Returns a NEW ledger (does not mutate the input).
 */
export function applyDelta(
  ledger: InjectedRecord[],
  emitted: Array<SelectedItem>,
  stamp?: { at?: string; fileToolCount?: number },
): InjectedRecord[] {
  const byId = new Map<string, InjectedRecord>();
  for (const r of ledger) byId.set(r.id, r);
  for (const item of emitted) {
    byId.set(item.id, {
      id: item.id,
      content_hash: item.content_hash,
      relevance_signature: item.relevance_signature,
      last_at: stamp?.at ?? byId.get(item.id)?.last_at,
      last_file_tool_count: stamp?.fileToolCount ?? byId.get(item.id)?.last_file_tool_count,
    });
  }
  return [...byId.values()];
}
