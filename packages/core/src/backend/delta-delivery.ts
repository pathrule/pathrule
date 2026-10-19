// SPDX-License-Identifier: Apache-2.0
/**
 * Delta delivery — turns the delta gate's `emit` list into the actual text
 * injected into the agent context, using FULL bodies from the warehouse.
 *
 * Properties (all pure, no I/O):
 *  - Empty emit ⇒ empty text (silence ⇒ context byte-identical ⇒ prompt cache holds).
 *  - Stable serialization (sorted by id, fixed headings) ⇒ an unchanged delta
 *    serializes byte-identically across turns.
 *  - Token-budgeted ⇒ a large burst can't blow the context; overflow is deferred
 *    (returned in `deferredIds`), never silently dropped.
 */
import type { DeltaResult } from "./delta-gate.js";
import type { Warehouse } from "./inputs.js";

const DEFAULT_BUDGET_TOKENS = 3000;

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export interface DeliveryResult {
  /** Injection text (empty string when the delta is empty). */
  text: string;
  injectedIds: string[];
  /** Items skipped: missing body, or over budget. Caller may nudge for these. */
  deferredIds: string[];
  tokens: number;
}

export function buildDeltaInjection(opts: {
  emit: DeltaResult["emit"];
  warehouse: Warehouse;
  budgetTokens?: number;
}): DeliveryResult {
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  // Stable order so an unchanged delta serializes identically across turns.
  const ordered = [...opts.emit].sort((a, b) => a.id.localeCompare(b.id));

  const blocks: string[] = [];
  const injectedIds: string[] = [];
  const deferredIds: string[] = [];
  let tokens = 0;

  for (const item of ordered) {
    const entry = opts.warehouse[item.id];
    if (!entry) {
      deferredIds.push(item.id); // body not in warehouse → caller may fall back to a nudge
      continue;
    }
    const block = `## ${entry.type}: ${entry.title}\n${entry.body}`;
    const blockTokens = estimateTokens(block);
    // Always allow at least one block; otherwise enforce the budget.
    if (injectedIds.length > 0 && tokens + blockTokens > budget) {
      deferredIds.push(item.id);
      continue;
    }
    blocks.push(block);
    injectedIds.push(item.id);
    tokens += blockTokens;
  }

  return { text: blocks.join("\n\n"), injectedIds, deferredIds, tokens };
}
