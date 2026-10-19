// SPDX-License-Identifier: Apache-2.0
/**
 * `atoms` on write_memory / update_memory: the writing agent states what it learned as typed,
 * quoted knowledge, and Pathrule proves the quotes against the stored body
 * (`@pathrule/agent-ir/atoms/grounded-capture.js`). A proven atom is delivered as an advisory to
 * the next agent working under that memory's path, with no approval step and no model call; one
 * that fails comes back with its reason, and the memory itself is saved either way.
 *
 * Local workspaces only for now: atoms live in the local store (see `RemedyAtomStore`). An
 * account workspace answers `local_only` rather than pretending it stored them.
 */
import { z } from "zod";
import {
  captureGroundedAtom,
  MAX_ATOMS_PER_WRITE,
  MAX_SPAN_CHARS,
  type GroundedAtomClaim,
} from "@pathrule/agent-ir/atoms/grounded-capture.js";
import { getLocalBackend, isProjectContext } from "../local-runtime.js";
import type { ToolContext } from "@pathrule/core/tools/types.js";

const spans = z.array(z.string().min(1)).max(8);

export const atomsInputSchema = z
  .array(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("remedy"),
        condition: spans,
        action: spans,
        variant: z.enum(["trouble", "bind"]).optional(),
        evidence: z.enum(["observed_success", "repeated_success", "human_authored"]).optional(),
      }),
      z.object({ kind: z.literal("selection"), prefer: spans, over: spans, context: spans.optional() }),
      z.object({ kind: z.literal("procedure"), operation: spans, steps: spans }),
      z.object({ kind: z.literal("context"), fact: spans }),
      z.object({ kind: z.literal("rationale"), subject: spans, reason: spans }),
    ]),
  )
  .max(MAX_ATOMS_PER_WRITE)
  .optional()
  .describe(
    "Optional typed knowledge, every string copied VERBATIM from content: remedy{condition,action}, selection{prefer,over}, procedure{operation,steps}, context{fact}, rationale{subject,reason}.",
  );

export interface AtomCaptureReport {
  accepted: number;
  refused: Array<{ index: number; code: string; message: string }>;
  skipped?: "local_only";
}

export async function captureAtomsForMemory(
  ctx: ToolContext,
  workspaceId: string,
  memory: { id: string; title: string; content: string },
  claims: readonly GroundedAtomClaim[] | undefined,
  now: string = new Date().toISOString(),
): Promise<AtomCaptureReport | null> {
  if (!claims || claims.length === 0) return null;
  if (isProjectContext(ctx)) return { accepted: 0, refused: [], skipped: "local_only" };
  const store = await getLocalBackend(workspaceId);
  const report: AtomCaptureReport = { accepted: 0, refused: [] };
  for (const [index, claim] of claims.entries()) {
    const captured = captureGroundedAtom(claim, { kind: "memory", id: memory.id, title: memory.title, content: memory.content }, now);
    if (!captured.ok) {
      report.refused.push({ index, code: captured.code, message: captured.message });
      continue;
    }
    const stored = await store.recordGroundedAtom(workspaceId, captured.atom);
    if (stored === "kept_declined") {
      report.refused.push({ index, code: "capture_declined_before", message: "This exact knowledge was declined before (by a person, or retired by its own failed outcomes); it stays off." });
    } else {
      report.accepted += 1;
    }
  }
  return report;
}

/**
 * The memory's first paragraph as one fact, word for word, while it is short enough to be a span: what a
 * write carries when the agent typed nothing that held. The binding files carry only typed
 * knowledge, so an untyped save never reached the next session's instructions. Measured on PathruleBench
 * v2 (2026-10-15): "run the team suite with ACME_TEAM_SUITE=1" saved without atoms, then saved again,
 * in each of six sessions. A longer body stays untyped, as documentation does, for the hook to retrieve.
 */
/**
 * The first paragraph as one fact, or, when it is too long for a span, its first sentences as facts
 * (at most four). A decision stated in one long paragraph ("new types use X; existing ones keep Y;
 * in problem.py ...") was typed as nothing and reached no rules file.
 */
function firstParagraphFact(content: string): GroundedAtomClaim[] | undefined {
  const first = content.trim().split(/\n\s*\n/)[0]?.trim() ?? "";
  if (first.length === 0) return undefined;
  if (first.length <= MAX_SPAN_CHARS) return [{ kind: "context", fact: [first] }];
  const sentences = first.split(/(?<=[.!?])\s+(?=\S)/).map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= MAX_SPAN_CHARS).slice(0, 4);
  return sentences.length > 0 ? sentences.map((s) => ({ kind: "context", fact: [s] }) as GroundedAtomClaim) : undefined;
}

/**
 * Capture what a write or body update carries, and return the report for the agent: its own atoms, or
 * none. The same fact also stands in when every atom it sent was refused: agents quoted the title as a
 * span ("Run the acmetest team suite"), and the knowledge stayed untyped in each session it was saved.
 */
export async function captureForWrite(
  ctx: ToolContext,
  workspaceId: string,
  memory: { id: string; title: string; content: string },
  claims: readonly GroundedAtomClaim[] | undefined,
): Promise<AtomCaptureReport | null> {
  const sent = claims && claims.length > 0 ? await captureAtomsForMemory(ctx, workspaceId, memory, claims) : null;
  const fallback = !sent || (sent.accepted === 0 && !sent.skipped) ? firstParagraphFact(memory.content) : undefined;
  if (fallback) await captureAtomsForMemory(ctx, workspaceId, memory, fallback);
  return sent;
}

/** One sentence for `human_message`, or "" when no atoms were sent. */
export function atomCaptureSentence(report: AtomCaptureReport | null): string {
  if (!report) return "";
  if (report.skipped) return " Typed atoms are kept only in local workspaces for now, so none were stored.";
  const refused = report.refused.length > 0 ? ` ${report.refused.length} not stored (see atoms.refused).` : "";
  return ` ${report.accepted} typed atom${report.accepted === 1 ? "" : "s"} will reach agents working under this path.${refused}`;
}
