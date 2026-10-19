// SPDX-License-Identifier: Apache-2.0
// Browser-safe rendering of compiled knowledge. Identity and atom projection
// remain in the compiler; renderers import only types from that Node-side module.
import type { RemedyEvidenceState } from "../atoms/remedy.js";
import type { RemedyAdvisory, SelectionAdvisory, ProcedureAdvisory, ContextAdvisory, RationaleAdvisory, KnowledgeEntry, AgentKnowledgeIR } from "./agent-ir.js";

const STRENGTH_LABEL: Record<RemedyEvidenceState, string> = {
  HUMAN_AUTHORED: "standing guidance",
  REPEATED_SUCCESS: "worked repeatedly",
  OBSERVED_SUCCESS: "observed to work",
  SPECULATIVE: "speculative", ATTEMPTED: "attempted", FAILED: "failed", SUPERSEDED: "superseded",
};

/**
 * The advisory section header. Load-bearing text: it states the advisories never override a rule, a
 * constraint, or a security policy, which is how authority ordering (CONSTRAINT > REMEDY) survives
 * into a rendered prompt where an agent could otherwise read advice as an instruction.
 */
export const ADVISORY_SECTION_HEADER =
  "💡 Pathrule advisories (approved corrective knowledge, advisory only; they never override a rule, a constraint, or a security policy):";

/** Render ONE advisory as a neutral markdown line. Shared by the IR renderer and the hook index. */
export function renderAdvisoryLine(a: RemedyAdvisory): string {
  const cond = a.condition_grounded ? a.condition : `${a.condition} (paraphrased)`;
  const strength = STRENGTH_LABEL[a.strength];
  return a.variant === "bind"
    ? `- Instead of ${JSON.stringify(cond)}, the approved choice is: ${a.action}. [${strength}]`
    : `- When ${JSON.stringify(cond)}, this corrective action is approved: ${a.action}. [${strength}]`;
}

/** Render ONE selection as a neutral markdown line. States a preference, never a prohibition. */
export function renderSelectionLine(a: SelectionAdvisory): string {
  const ctx = a.context ? (a.context_grounded ? a.context : `${a.context} (paraphrased)`) : "";
  const where = ctx ? `When ${JSON.stringify(ctx)}, ` : "";
  const over = a.alternatives.length > 0 ? ` over ${a.alternatives.join(" / ")}` : "";
  return `- ${where}the preferred choice is ${a.preferred}${over}. [preference]`;
}

/** Render ONE procedure as a compact numbered list. Steps are source-verbatim and in order. */
export function renderProcedureLine(a: ProcedureAdvisory): string {
  const op = a.operation ? (a.operation_grounded ? a.operation : `${a.operation} (paraphrased)`) : "this operation";
  const steps = a.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
  return `- Procedure for ${JSON.stringify(op)}:\n${steps} [ordered guidance]`;
}

/** Render ONE context fact as a neutral markdown line. Descriptive, never normative. */
export function renderContextLine(a: ContextAdvisory): string {
  const fact = a.fact_grounded ? a.fact.replace(/\.$/, "") : `${a.fact.replace(/\.$/, "")} (paraphrased)`;
  return `- Fact: ${fact}. [context]`;
}

/** Render ONE standalone rationale line: the explanation, tied to what it explains. */
export function renderRationaleLine(a: RationaleAdvisory): string {
  const subj = a.subject ? `${a.subject}: ` : "";
  return `- Why ${subj}${a.reason}. [rationale]`;
}

/** Render ANY entry to its neutral markdown line, appending an attached rationale where present. */
export function renderEntryLine(e: KnowledgeEntry): string {
  let line: string;
  switch (e.type) {
    case "remedy": line = renderAdvisoryLine(e); break;
    case "selection": line = renderSelectionLine(e); break;
    case "procedure": line = renderProcedureLine(e); break;
    case "context": line = renderContextLine(e); break;
    case "rationale": return renderRationaleLine(e);
  }
  const reason = (e as { attached_reason?: string | null }).attached_reason;
  return reason ? `${line} Reason: ${reason}.` : line;
}

/**
 * The knowledge ONE rendered line carries: every source string its renderer inserts, without the fixed
 * wording around them ("this corrective action is approved", "[preference]", "Reason:"). This is what the
 * completeness gate judges. Judging the full line would let template words that happen to appear in the
 * source ("preferred", "choice", "approved") count as coverage the delivery never earned.
 */
export function entryKnowledgeText(e: KnowledgeEntry): string {
  const parts: string[] = [];
  switch (e.type) {
    case "remedy": parts.push(e.condition, e.action); break;
    case "selection": parts.push(e.context, e.preferred, ...e.alternatives); break;
    case "procedure": parts.push(e.operation, ...e.steps); break;
    case "context": parts.push(e.fact); break;
    case "rationale": parts.push(e.subject, e.reason); break;
  }
  const reason = (e as { attached_reason?: string | null }).attached_reason;
  if (reason) parts.push(reason);
  return parts.filter((p) => p.trim().length > 0).join("\n");
}

/**
 * Render the IR as neutral markdown. Every advisory kind goes in one clearly-subordinate section, in
 * the order the compiler already fixed (REMEDY, SELECTION, PROCEDURE), so authority ordering survives
 * rendering. Returns an empty string when there is nothing to deliver, so a caller can inject
 * unconditionally.
 */
export function renderAgentKnowledgeIR(ir: AgentKnowledgeIR): string {
  if (ir.entries.length === 0) return "";
  const lines: string[] = [ADVISORY_SECTION_HEADER, ...ir.entries.map(renderEntryLine)];
  if (ir.provenance.truncated) {
    lines.push(`_(${ir.provenance.delivered} of ${ir.provenance.eligible} approved advisories shown for this scope.)_`);
  }
  return lines.join("\n");
}

