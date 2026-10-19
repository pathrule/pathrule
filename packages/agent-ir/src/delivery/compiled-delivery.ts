// SPDX-License-Identifier: Apache-2.0
/**
 * Compiled form or source, per memory: the production call site of the completeness gate.
 *
 * Approved atoms are compiled from a memory and rendered into advisory lines. Before those lines may
 * stand in for the memory, the gate (`decideDelivery` -> `irCompletenessGate`) reads the memory as
 * written against the knowledge the lines actually carry, and the whole memory goes one way:
 *
 *  - SUFFICIENT: the memory is delivered as its compiled form everywhere its body would go (the hook's
 *    body channel, the native knowledge files, the host's turn context), and its lines reach the agent
 *    through the advisory channel as one group, all or none.
 *  - INSUFFICIENT: the memory is delivered as written, and its lines are withheld everywhere. A partial
 *    projection must never reach the agent as if it were the knowledge; that is the failure the gate
 *    exists for (a SELECTION that kept the winner and lost what to avoid).
 *
 * A line with no source memory to judge against (a rule's atoms, or an atom whose memory is no longer
 * active) keeps the additive delivery it had before: there is no body to replace and none to fall back to.
 *
 * Explicit reads are not delivery. `pathrule_read_memory` and friends always return the memory as
 * written, which is also what the compiled form points to.
 *
 * Pure and deterministic: no model, no clock, no I/O. Same lines and memories, same plan.
 */
import { decideDelivery } from "./ir-delivery.js";

/** One rendered advisory line, with what the gate reads and where it came from. */
export interface SourcedAdvisoryLine {
  /** The atom ref (fingerprint id). */
  ref: string;
  /** The exact line the agent receives. */
  line: string;
  /** The knowledge that line carries, without its fixed wording (`entryKnowledgeText`). */
  knowledge: string;
  /** The memory the atom was compiled from, or null when it has none. */
  sourceMemoryId: string | null;
}

/** A memory the gate cleared: the text that replaces its body, and the refs that text is made of. */
export interface CompiledMemoryDelivery {
  memoryId: string;
  refs: string[];
  text: string;
  /** The gate's reason, for diagnostics. */
  reason: string;
}

export interface MemoryDeliveryDecision {
  memoryId: string;
  mode: "ir" | "prose";
  reason: string;
  refs: string[];
}

export interface CompiledDeliveryPlan {
  /** Memories delivered as their compiled form, by memory id. */
  compiled: Map<string, CompiledMemoryDelivery>;
  /** Refs whose memory fell back to its source text. Never delivered on their own. */
  withheldRefs: Set<string>;
  /** Every decision, both ways, in line order. */
  decisions: MemoryDeliveryDecision[];
}

/**
 * The text that stands in for a cleared memory's body. The first line says what it is, that it stays
 * advisory, and where the full text is, so an agent that needs more than the compiled form is one read
 * away from it rather than left to guess that something was condensed.
 */
export function compiledMemoryText(memoryId: string, lines: readonly string[]): string {
  return [
    `_Compiled form of this memory (advisory, never overrides a rule). Full text: pathrule_read_memory("${memoryId}")._`,
    ...lines,
  ].join("\n");
}

/** Decide, per source memory, whether its compiled form or its source text is delivered. */
export function planCompiledDelivery(
  lines: readonly SourcedAdvisoryLine[],
  memories: ReadonlyArray<{ id: string; content: string }>,
): CompiledDeliveryPlan {
  const source = new Map(memories.map((m) => [m.id, m.content]));
  const groups = new Map<string, SourcedAdvisoryLine[]>();
  const seen = new Set<string>();
  for (const l of lines) {
    if (!l.sourceMemoryId || !source.has(l.sourceMemoryId) || seen.has(l.ref)) continue;
    seen.add(l.ref);
    const group = groups.get(l.sourceMemoryId);
    if (group) group.push(l);
    else groups.set(l.sourceMemoryId, [l]);
  }

  const plan: CompiledDeliveryPlan = { compiled: new Map(), withheldRefs: new Set(), decisions: [] };
  for (const [memoryId, group] of groups) {
    const refs = group.map((l) => l.ref);
    const decision = decideDelivery({
      compiledIrAvailable: true,
      deliveredText: group.map((l) => l.knowledge).join("\n"),
      atomCount: group.length,
      sourceText: source.get(memoryId) ?? "",
    });
    plan.decisions.push({ memoryId, mode: decision.mode, reason: decision.reason, refs });
    if (decision.mode === "ir") {
      plan.compiled.set(memoryId, {
        memoryId,
        refs,
        text: compiledMemoryText(memoryId, group.map((l) => l.line)),
        reason: decision.reason,
      });
    } else {
      for (const ref of refs) plan.withheldRefs.add(ref);
    }
  }
  return plan;
}
