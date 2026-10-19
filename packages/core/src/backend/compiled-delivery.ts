// SPDX-License-Identifier: Apache-2.0
// One browser-safe delivery decision for native files and the Node-only hook index.
import type { HookIndexInput } from "./hook-index.js";
import type { KnowledgeEntry } from "@pathrule/agent-ir/delivery/agent-ir.js";
import { entryKnowledgeText, renderAdvisoryLine, renderSelectionLine, renderProcedureLine, renderContextLine, renderRationaleLine } from "@pathrule/agent-ir/delivery/entry-rendering.js";
import { planCompiledDelivery, type CompiledDeliveryPlan, type SourcedAdvisoryLine } from "@pathrule/agent-ir/delivery/compiled-delivery.js";

/** The inputs the compiled-or-source decision reads: the advisories, and the memory text each is judged against. */
export type CompiledDeliveryInput = Pick<
  HookIndexInput,
  "advisories" | "selections" | "procedures" | "contexts" | "rationales" | "advisorySources"
> & { memories: ReadonlyArray<{ id: string; content: string }> };

/**
 * Every approved advisory as the exact line the agent receives, in delivery order (remedy, selection,
 * procedure, context, rationale), with its scope, the knowledge the line carries, and its source memory.
 * The ONE place lines are rendered, so the gate judges the same lines the index ships.
 */
/**
 * `guidance` marks typed guidance (REMEDY, SELECTION, PROCEDURE): what to do, scoped to where it is
 * done. It adds structure a memory body lacks, so it still reaches the agent at the point of action
 * when its memory is delivered as written. CONTEXT and RATIONALE only restate the body, and do not.
 */
export function sourcedAdvisoryLines(input: CompiledDeliveryInput): Array<SourcedAdvisoryLine & { scope: string | null; guidance: boolean }> {
  const sources = input.advisorySources ?? {};
  const out: Array<SourcedAdvisoryLine & { scope: string | null; guidance: boolean }> = [];
  const add = (entry: KnowledgeEntry, line: string, guidance: boolean): void => {
    out.push({ ref: entry.ref, line, knowledge: entryKnowledgeText(entry), sourceMemoryId: sources[entry.ref] ?? null, scope: entry.scope, guidance });
  };
  for (const a of input.advisories ?? []) add(a, renderAdvisoryLine(a), true);
  for (const s of input.selections ?? []) add(s, renderSelectionLine(s), true);
  for (const p of input.procedures ?? []) add(p, renderProcedureLine(p), true);
  for (const c of input.contexts ?? []) add(c, renderContextLine(c), false);
  for (const r of input.rationales ?? []) add(r, renderRationaleLine(r), false);
  return out;
}

/**
 * Compiled form or source, per memory (`planCompiledDelivery`). The index, the warehouse and the native
 * knowledge files all read this one plan, so a memory is delivered the same way on every channel, and
 * The host's turn context reads it through `LocalBackend.compiledMemoryDeliveries`.
 */
export function compiledDeliveryPlan(input: CompiledDeliveryInput): CompiledDeliveryPlan {
  return planCompiledDelivery(sourcedAdvisoryLines(input), input.memories);
}

/** What a memory's body slot carries: its compiled form when the gate cleared it, else the memory. */
export function deliveredMemoryBody(m: { id: string; content: string }, plan: CompiledDeliveryPlan): string {
  return plan.compiled.get(m.id)?.text ?? m.content;
}

