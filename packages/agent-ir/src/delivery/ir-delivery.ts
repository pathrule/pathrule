// SPDX-License-Identifier: Apache-2.0
/**
 * Production delivery decision for a knowledge candidate: deliver the task-scoped Agent IR, or fall back to
 * the prose body. A pure, fail-closed function so every surface shares ONE decision path; the delivery path
 * calls it through `planCompiledDelivery` (agent-ir/compiled-delivery.ts), once per source memory, when the
 * hook index, the warehouse, the native knowledge files and the host's turn context are built. It composes the
 * shipped `irCompletenessGate` with the runtime fact the delivery path knows: whether compiled IR EXISTS for
 * this memory yet (nothing approved yet).
 *
 * Order of decisions (fail-closed; when in doubt, PROSE):
 *  1. No compiled IR yet (lazy compile pending) -> PROSE. Deterministic CONSTRAINT/CHECK
 *     enforcement and already-compiled knowledge are unaffected; they do not depend on this call.
 *  2. Compiled IR exists -> run the completeness gate on the DELIVERED projection -> IR if FULL, else PROSE.
 */
import { irCompletenessGate, type IrCompletenessResult } from "./ir-completeness-gate.js";

export interface DeliveryInput {
  /** Whether compiled IR is available for this memory (lazy compilation has produced + persisted it). */
  compiledIrAvailable: boolean;
  /** The agent-facing Agent IR delivery text, if compiled. */
  deliveredText?: string;
  /** Number of grounded atoms in the compiled IR (0 => nothing usable). */
  atomCount?: number;
  /** The source memory body (always available; the prose fallback). */
  sourceText: string;
}

export interface DeliveryDecision {
  mode: "ir" | "prose";
  reason: string;
  /** The completeness gate result, when it was consulted. */
  gate?: IrCompletenessResult;
}

export function decideDelivery(input: DeliveryInput): DeliveryDecision {
  // 1. No compiled IR yet: fall back to prose. The caller may also enqueue a lazy compile (see
  //    `compileCacheKey`), but THIS delivery still goes to prose because the IR is not ready yet.
  if (!input.compiledIrAvailable || !input.deliveredText || !(input.atomCount && input.atomCount > 0)) {
    return { mode: "prose", reason: "ir_not_compiled_yet" };
  }
  // 2. Compiled IR exists: the completeness gate judges the delivered projection.
  const gate = irCompletenessGate({ atomCount: input.atomCount, deliveredText: input.deliveredText, sourceText: input.sourceText });
  return gate.decision === "IR"
    ? { mode: "ir", reason: gate.reason, gate }
    : { mode: "prose", reason: `gate:${gate.reason}`, gate };
}

/**
 * Lazy content-hash compilation key. Compiled IR is cached by (source content hash, compiler contract
 * version): reuse when present, (re)compile when missing or stale. The SOURCE narrative is never mutated or
 * deleted, so a model/compiler-contract change re-compiles from the preserved source. `hashHex` is injected
 * (Node crypto in production, a stub in tests) so this stays dependency-free.
 */
export function compileCacheKey(sourceText: string, compilerVersion: string, hashHex: (s: string) => string): string {
  return `${hashHex(sourceText)}:${compilerVersion}`;
}

export type CompileCacheState = "reuse" | "compile";

/** Decide whether a memory's compiled IR can be reused or must be (re)compiled. Pure. */
export function resolveCompileState(input: {
  sourceText: string;
  compilerVersion: string;
  hashHex: (s: string) => string;
  cachedKey: string | null; // the key stored alongside the last compiled result for this memory, if any
}): { state: CompileCacheState; key: string } {
  const key = compileCacheKey(input.sourceText, input.compilerVersion, input.hashHex);
  return { state: input.cachedKey === key ? "reuse" : "compile", key };
}
