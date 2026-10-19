// SPDX-License-Identifier: Apache-2.0
import { ADVISORY_SECTION_HEADER } from "./entry-rendering.js";
export { ADVISORY_SECTION_HEADER, renderAdvisoryLine, renderSelectionLine, renderProcedureLine, renderContextLine, renderRationaleLine, renderEntryLine, entryKnowledgeText, renderAgentKnowledgeIR } from "./entry-rendering.js";
/**
 * Agent IR: the boundary between Pathrule's stored typed knowledge and a single agent execution.
 *
 * The capture half of Pathrule (observe -> understand -> validate -> persist -> review -> approve)
 * produces typed atoms. This module is the start of the delivery half: it takes APPROVED atoms
 * that are eligible for one execution, compiles them into a compact, engine-neutral representation,
 * and renders that representation as advisory text an agent can use. It is deliberately NOT a
 * database dump: the boundary is `Knowledge -> Agent IR -> rendered delivery`, not `SELECT * ->
 * JSON.stringify -> prompt`.
 *
 * Three properties are load-bearing and every function here preserves them:
 *
 *  1. TYPE IS PRESERVED. A remedy is delivered as an advisory, never flattened into "remember this".
 *     The IR is a discriminated union so CONSTRAINT / CHECK / CONTEXT / SELECTION / PROCEDURE /
 *     RATIONALE / PRECEDENCE can be added later as new entry kinds without reshaping the boundary.
 *  2. AUTHORITY IS ENCODED, NOT FLATTENED. A REMEDY is advisory and never outranks a CONSTRAINT.
 *     Entries carry an `authority` band and render into clearly-subordinate sections, so advisory
 *     text is never concatenated with equal weight after a hard rule.
 *  3. NOTHING SEMANTIC HAPPENS AT DELIVERY. The expensive interpretation ran once at write-time.
 *     Compilation and rendering are pure, deterministic, and make zero model calls.
 *
 * This module is engine-neutral: it never branches on Claude / Codex / Cursor. A renderer produces
 * neutral markdown; the per-engine envelope is applied downstream by the existing hook `emit()`.
 */
import {
  type RemedyAtom,
  type RemedyEvidenceState,
  type RemedyVariant,
  isRemedyDeliverable,
} from "../atoms/remedy.js";
import { type SelectionAtom, isSelectionDeliverable } from "../atoms/selection.js";
import { type ProcedureAtom, isProcedureDeliverable } from "../atoms/procedure.js";
import { type ContextAtom, isContextDeliverable } from "../atoms/context.js";
import { type RationaleAtom, isRationaleDeliverable } from "../atoms/rationale.js";
import { type PrecedenceAtom, isPrecedenceActive } from "../atoms/precedence.js";
import { resolveConflicts, type ConflictCandidate, type PrecedenceEdge, type ConflictTrace } from "./conflict.js";
import type { AdvisoryStub } from "@pathrule/protocol/hook-index.js";

/** The one execution a compilation is for. `path` is workspace-relative, null when unknown. */
export interface AgentExecutionContext {
  workspace_id: string;
  /** Workspace-relative path of the file/scope the agent is acting on, or null (e.g. a bare prompt). */
  path: string | null;
  compiled_at: string;
}

/**
 * Authority band. Higher binds harder. A renderer must never present a lower band as able to
 * override a higher one. REMEDY is the first real advisory; the bands above it are named now so the
 * ordering is fixed before other atom types arrive.
 */
export type KnowledgeAuthority = "constraint" | "check" | "advisory" | "context";
export const AUTHORITY_ORDER: readonly KnowledgeAuthority[] = ["constraint", "check", "advisory", "context"];

/**
 * A REMEDY projected for delivery. Carries only what improves execution: the condition, the
 * corrective action, how strongly the source claimed it, its scope, and a provenance ref. It never
 * carries persistence/lifecycle/debug metadata, and never the raw memory body.
 */
export interface RemedyAdvisory {
  type: "remedy";
  authority: "advisory";
  variant: RemedyVariant;
  /** What triggers the advice. Source-grounded evidence when present, else the extractor wording. */
  condition: string;
  /** Whether `condition` is source-verbatim (true) or the extractor's paraphrase (false). */
  condition_grounded: boolean;
  /** The corrective action, source-verbatim. */
  action: string;
  /** How strongly the source claimed success. Only deliverable states reach here. */
  strength: RemedyEvidenceState;
  /** Resolved workspace-relative scope, or null for workspace-global. Never delivered outside it. */
  scope: string | null;
  /** Atom fingerprint id: provenance and the join key for a delivery event. Not shown to the agent. */
  ref: string;
}

/**
 * A SELECTION projected for delivery: a source-backed preference. It is advisory and states a
 * preferred choice; it NEVER denies the alternative (only a CONSTRAINT can), which is why it renders
 * as "the preferred choice is" and not "do not use".
 */
export interface SelectionAdvisory {
  type: "selection";
  authority: "advisory";
  /** The context the preference applies under. Source-grounded when present, else the paraphrase. */
  context: string;
  context_grounded: boolean;
  /** The preferred choice, source-verbatim. */
  preferred: string;
  /** Alternatives the source named, source-verbatim. Empty when the source named none; never invented. */
  alternatives: string[];
  scope: string | null;
  ref: string;
}

/**
 * A PROCEDURE projected for delivery: a source-backed ordered workflow. Advisory operational
 * guidance. It never auto-executes a step, never creates a CHECK; the steps are source-verbatim and
 * in source order.
 */
export interface ProcedureAdvisory {
  type: "procedure";
  authority: "advisory";
  operation: string;
  operation_grounded: boolean;
  /** Ordered, source-verbatim steps. */
  steps: string[];
  scope: string | null;
  ref: string;
}

/**
 * A CONTEXT projected for delivery: a source-backed descriptive fact. Advisory, never enforcement.
 */
export interface ContextAdvisory {
  type: "context";
  authority: "context";
  /** The fact, source-grounded when present else the paraphrase. */
  fact: string;
  fact_grounded: boolean;
  scope: string | null;
  ref: string;
  /** A rationale explaining this fact, attached at compile time. Rendered inline, no extra budget slot. */
  attached_reason?: string;
}

/**
 * A RATIONALE projected for delivery: a source-backed explanation. Delivered attached to the atom it
 * explains when that atom is also delivered (see compile), else standalone at the lowest priority.
 */
export interface RationaleAdvisory {
  type: "rationale";
  authority: "context";
  /** What is being explained. */
  subject: string;
  /** The reason, source-verbatim. */
  reason: string;
  scope: string | null;
  ref: string;
}

/** Optional reason attached to an operational entry at compile time (RATIONALE compaction). */
export interface Attachable { attached_reason?: string }

/** The discriminated union of everything the IR can carry: 7 primitives by V32. */
export type KnowledgeEntry =
  | (RemedyAdvisory & Attachable)
  | (SelectionAdvisory & Attachable)
  | (ProcedureAdvisory & Attachable)
  | ContextAdvisory
  | RationaleAdvisory;

export interface AgentKnowledgeIR {
  execution_context: AgentExecutionContext;
  entries: KnowledgeEntry[];
  provenance: {
    /** How many atoms were eligible (deliverable + in-scope) before the budget. */
    eligible: number;
    /** How many entries the IR actually carries. */
    delivered: number;
    /** The budget applied. */
    budget: number;
    /** True if the budget dropped eligible entries. */
    truncated: boolean;
  };
  /** V33: an explainable trace of every conflict the compiler detected and how it resolved it. */
  conflicts?: ConflictTrace[];
}

/** Default max entries delivered for one execution. Deterministic budget; no model ranking. */
export const DEFAULT_ADVISORY_BUDGET = 8;

// ── scope ────────────────────────────────────────────────────────────────────────────────────

/**
 * Does a remedy scoped at `scope` apply to an execution at `execPath`?
 *
 * The same ancestor semantics rules use: a remedy learned under `/apps/web` applies to
 * `/apps/web/button.tsx` (a descendant) and to `/apps/web` itself, but never to `/apps/api`. A
 * null/empty scope is workspace-global and applies everywhere. When the execution has no path, only
 * global remedies apply (a path-scoped remedy has nothing to attach to).
 */
export function scopeApplies(scope: string | null, execPath: string | null): boolean {
  const s = (scope ?? "").replace(/^\/+|\/+$/g, "");
  if (s === "") return true; // global
  if (execPath == null) return false;
  const p = execPath.replace(/^\/+|\/+$/g, "");
  return p === s || p.startsWith(s + "/");
}

/** How specific a scope is, for ordering. Deeper (more path segments) is more specific. */
function scopeDepth(scope: string | null): number {
  const s = (scope ?? "").replace(/^\/+|\/+$/g, "");
  return s === "" ? 0 : s.split("/").length;
}

const STRENGTH_RANK: Record<RemedyEvidenceState, number> = {
  HUMAN_AUTHORED: 3, REPEATED_SUCCESS: 2, OBSERVED_SUCCESS: 1,
  SPECULATIVE: 0, ATTEMPTED: 0, FAILED: 0, SUPERSEDED: 0,
};

// ── projection ───────────────────────────────────────────────────────────────────────────────

/**
 * Canonicalize a scope to the hook's leading-slash node-path form so `path_advisories` keys match
 * what the hook's ancestor walk produces (path_rules uses the same form). Root ("/") and empty both
 * mean workspace-global, which is `null`.
 */
export function normalizeScope(scope: string | null): string | null {
  const s = (scope ?? "").trim();
  if (s === "" || s === "/") return null;
  return "/" + s.replace(/^\/+|\/+$/g, "");
}

/** Project one deliverable RemedyAtom into an advisory. `scope` is resolved by the caller. */
export function projectRemedyToAdvisory(atom: RemedyAtom, scope: string | null): RemedyAdvisory {
  const grounded = atom.condition_evidence.length > 0;
  const condition = grounded
    ? atom.condition_evidence.join(" ")
    : (atom.condition_normalized ?? "").trim();
  return {
    type: "remedy",
    authority: "advisory",
    variant: atom.variant,
    condition,
    condition_grounded: grounded,
    action: atom.action_evidence.join("; "),
    strength: atom.evidence_state,
    scope: normalizeScope(scope),
    ref: atom.id,
  };
}

/** Project one deliverable SelectionAtom into an advisory. `scope` is resolved by the caller. */
export function projectSelectionToAdvisory(atom: SelectionAtom, scope: string | null): SelectionAdvisory {
  const grounded = atom.context_evidence.length > 0;
  const context = grounded ? atom.context_evidence.join(" ") : (atom.context_normalized ?? "").trim();
  return {
    type: "selection",
    authority: "advisory",
    context,
    context_grounded: grounded,
    preferred: atom.preferred_evidence.join(" "),
    alternatives: atom.alternative_evidence,
    scope: normalizeScope(scope),
    ref: atom.id,
  };
}

/** Project one deliverable ProcedureAtom into an advisory. `scope` is resolved by the caller. */
export function projectProcedureToAdvisory(atom: ProcedureAtom, scope: string | null): ProcedureAdvisory {
  const grounded = atom.operation_evidence.length > 0;
  const operation = grounded ? atom.operation_evidence.join(" ") : (atom.operation_normalized ?? "").trim();
  return {
    type: "procedure",
    authority: "advisory",
    operation,
    operation_grounded: grounded,
    steps: atom.steps,
    scope: normalizeScope(scope),
    ref: atom.id,
  };
}

/** Project one deliverable ContextAtom into an advisory. `scope` is resolved by the caller. */
export function projectContextToAdvisory(atom: ContextAtom, scope: string | null): ContextAdvisory {
  const grounded = atom.fact_evidence.length > 0;
  return {
    type: "context",
    authority: "context",
    fact: grounded ? atom.fact_evidence.join(" ") : (atom.fact_normalized ?? "").trim(),
    fact_grounded: grounded,
    scope: normalizeScope(scope),
    ref: atom.id,
  };
}

/** Project one deliverable RationaleAtom into an advisory. `scope` is resolved by the caller. */
export function projectRationaleToAdvisory(atom: RationaleAtom, scope: string | null): RationaleAdvisory {
  const subject = atom.subject_evidence.length > 0 ? atom.subject_evidence.join(" ") : (atom.subject_normalized ?? "").trim();
  return {
    type: "rationale",
    authority: "context",
    subject,
    reason: atom.reason_evidence.join("; "),
    scope: normalizeScope(scope),
    ref: atom.id,
  };
}

// ── selection + compilation ────────────────────────────────────────────────────────────────────

/** A remedy paired with its resolved scope, so selection stays a pure function over data. */
export interface ScopedRemedy { atom: RemedyAtom; scope: string | null }

/**
 * Compile eligible remedies for ONE execution into Agent IR.
 *
 * Selection: only atoms that pass `isRemedyDeliverable` (a person approved it, it is active, and the
 * source claimed success) AND whose scope applies to the execution path. Lifecycle is NOT
 * re-implemented here; `isRemedyDeliverable` is the single source of truth.
 *
 * Ordering is deterministic and needs no model: most-specific scope first, then strongest evidence,
 * then most recently observed, then fingerprint as a stable final tiebreak. The budget then keeps
 * the top `budget` entries. Duplicate atoms (same fingerprint) are collapsed.
 */
export function compileAgentKnowledgeIR(
  scoped: ScopedRemedy[],
  ctx: AgentExecutionContext,
  opts?: { budget?: number },
): AgentKnowledgeIR {
  const budget = opts?.budget ?? DEFAULT_ADVISORY_BUDGET;
  const seen = new Set<string>();
  const eligible = scoped
    .filter(({ atom, scope }) => isRemedyDeliverable(atom) && scopeApplies(scope, ctx.path))
    .filter(({ atom }) => (seen.has(atom.id) ? false : (seen.add(atom.id), true)))
    .sort((a, b) => {
      const d = scopeDepth(b.scope) - scopeDepth(a.scope);
      if (d !== 0) return d;
      const s = STRENGTH_RANK[b.atom.evidence_state] - STRENGTH_RANK[a.atom.evidence_state];
      if (s !== 0) return s;
      const t = String(b.atom.observed_at).localeCompare(String(a.atom.observed_at));
      if (t !== 0) return t;
      return a.atom.id.localeCompare(b.atom.id);
    });
  const kept = eligible.slice(0, budget);
  return {
    execution_context: ctx,
    entries: kept.map(({ atom, scope }) => projectRemedyToAdvisory(atom, scope)),
    provenance: { eligible: eligible.length, delivered: kept.length, budget, truncated: eligible.length > kept.length },
  };
}

// ── multi-primitive compilation (REMEDY + SELECTION + PROCEDURE) ─────────────────────────────────

export interface ScopedSelection { atom: SelectionAtom; scope: string | null }
export interface ScopedProcedure { atom: ProcedureAtom; scope: string | null }

/** Presentation precedence WITHIN the advisory budget: operational knowledge first, then facts, then reasons. */
const KIND_RANK: Record<KnowledgeEntry["type"], number> = { remedy: 0, selection: 1, procedure: 2, context: 3, rationale: 4 };

export interface ScopedContext { atom: ContextAtom; scope: string | null }
export interface ScopedRationale { atom: RationaleAtom; scope: string | null }
export interface ScopedPrecedence { atom: PrecedenceAtom; scope: string | null }

/** The literal an operational entry is "about", used to attach a rationale that explains it. */
function entrySubjectLiteral(e: KnowledgeEntry): string {
  switch (e.type) {
    case "remedy": return e.action;
    case "selection": return e.preferred;
    case "procedure": return e.operation;
    case "context": return e.fact;
    case "rationale": return e.subject;
  }
}

const normLit = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
/** A forbidden literal and a delivered literal collide when either contains the other (min 4 chars). */
function collidesForbidden(literal: string, forbidden: readonly string[]): boolean {
  const a = normLit(literal);
  if (a.length < 4) return false;
  return forbidden.some((f) => { const b = normLit(f); return b.length >= 4 && (a.includes(b) || b.includes(a)); });
}

/**
 * Compile eligible REMEDY + SELECTION + PROCEDURE atoms for ONE execution into a single bounded IR.
 *
 * Conflict handling is deterministic and CONSERVATIVE, never an LLM at delivery:
 *  - CONSTRAINT dominates. `forbidden` carries the active constraints' forbidden literals for this
 *    scope. A SELECTION whose preferred choice collides with one is DROPPED (never tell the agent to
 *    prefer what a rule forbids), and a PROCEDURE any of whose steps collides is WITHHELD whole (a
 *    workflow with a forbidden step is not delivered as normal guidance). This is basic authority
 *    consistency, not the full PRECEDENCE primitive.
 *  - SELECTION vs SELECTION. Two in-scope deliverable selections that share a context but prefer
 *    DIFFERENT choices are a genuine conflict with no precedence primitive to resolve it, so BOTH are
 *    withheld rather than one being picked by id order.
 *
 * Ordering is deterministic: kind rank (remedy, selection, procedure), then most-specific scope, then
 * recency, then ref. The budget is SHARED across all three kinds, so advisory volume stays bounded and
 * remedies (the closest to enforcement) are never displaced by preferences or procedures.
 */
export function compileKnowledgeIR(
  input: {
    remedies?: ScopedRemedy[]; selections?: ScopedSelection[]; procedures?: ScopedProcedure[];
    contexts?: ScopedContext[]; rationales?: ScopedRationale[]; precedences?: ScopedPrecedence[];
    forbidden?: readonly string[];
  },
  ctx: AgentExecutionContext,
  opts?: { budget?: number },
): AgentKnowledgeIR {
  const budget = opts?.budget ?? DEFAULT_ADVISORY_BUDGET;
  const forbidden = input.forbidden ?? [];

  let remedies = (input.remedies ?? []).filter(({ atom, scope }) => isRemedyDeliverable(atom) && scopeApplies(scope, ctx.path));
  let selections = (input.selections ?? []).filter(({ atom, scope }) => isSelectionDeliverable(atom) && scopeApplies(scope, ctx.path));
  let procedures = (input.procedures ?? []).filter(({ atom, scope }) => isProcedureDeliverable(atom) && scopeApplies(scope, ctx.path));
  const contexts = (input.contexts ?? []).filter(({ atom, scope }) => isContextDeliverable(atom) && scopeApplies(scope, ctx.path));
  const rationales = (input.rationales ?? []).filter(({ atom, scope }) => isRationaleDeliverable(atom) && scopeApplies(scope, ctx.path));

  // CONSTRAINT > SELECTION / PROCEDURE: drop advisory knowledge that collides with a forbidden literal.
  // This runs BEFORE conflict resolution, so a forbidden choice can never be delivered as a precedence
  // "winner": enforcement can never be defeated by an advisory precedence.
  selections = selections.filter(({ atom }) => !atom.preferred_evidence.some((p) => collidesForbidden(p, forbidden)));
  procedures = procedures.filter(({ atom }) => !atom.steps.some((s) => collidesForbidden(s, forbidden)));

  // V33: deterministic cross-primitive conflict resolution. Build conflict candidates for the kinds
  // that can genuinely conflict (same condition/context/operation, different choice), run the pure
  // compiler with the APPROVED precedence edges applicable to this scope, and withhold everything it
  // cannot resolve. This SUPERSEDES the old ad-hoc SELECTION-vs-SELECTION withholding and extends it to
  // REMEDY and PROCEDURE. CONTEXT/RATIONALE are not auto-conflicted (facts and reasons coexist).
  const cand: ConflictCandidate[] = [
    ...remedies.map(({ atom, scope }) => ({ id: atom.id, kind: "remedy" as const, conflictKey: atom.condition_evidence.join(" ") || atom.condition_normalized || "", literal: atom.action_evidence.join(" "), scope })),
    ...selections.map(({ atom, scope }) => ({ id: atom.id, kind: "selection" as const, conflictKey: atom.context_evidence.join(" ") || atom.context_normalized || "", literal: atom.preferred_evidence.join(" "), scope })),
    ...procedures.map(({ atom, scope }) => ({ id: atom.id, kind: "procedure" as const, conflictKey: atom.operation_evidence.join(" ") || atom.operation_normalized || "", literal: atom.steps.join(" > "), scope })),
  ];
  const edges: PrecedenceEdge[] = (input.precedences ?? [])
    .filter(({ atom }) => isPrecedenceActive(atom))
    .map(({ atom, scope }) => ({ ref: atom.id, winner: atom.winner_evidence.join(" ") || atom.winner_normalized || "", loser: atom.loser_evidence.join(" ") || atom.loser_normalized || "", scope: normalizeScope(scope) }));
  const resolution = resolveConflicts(cand, edges, ctx.path);
  remedies = remedies.filter(({ atom }) => !resolution.withhold.has(atom.id));
  selections = selections.filter(({ atom }) => !resolution.withhold.has(atom.id));
  procedures = procedures.filter(({ atom }) => !resolution.withhold.has(atom.id));

  const dedup = <T extends { atom: { id: string } }>(xs: T[]): T[] => {
    const seen = new Set<string>();
    return xs.filter(({ atom }) => (seen.has(atom.id) ? false : (seen.add(atom.id), true)));
  };
  // Operational + context entries first (rationale is attached to these, not counted separately).
  const operational: KnowledgeEntry[] = [
    ...dedup(remedies).map(({ atom, scope }) => projectRemedyToAdvisory(atom, scope)),
    ...dedup(selections).map(({ atom, scope }) => projectSelectionToAdvisory(atom, scope)),
    ...dedup(procedures).map(({ atom, scope }) => projectProcedureToAdvisory(atom, scope)),
    ...dedup(contexts).map(({ atom, scope }) => projectContextToAdvisory(atom, scope)),
  ];

  // RATIONALE attachment (compaction): a rationale whose SUBJECT overlaps a delivered entry's literal
  // is rendered inline on that entry ("Reason: ...") and consumes no separate budget slot. An
  // unmatched rationale is delivered standalone at the lowest priority. Deterministic text overlap,
  // never an LLM, so a reason is only attached where the source's own subject names the entry.
  const rationaleEntries = dedup(rationales).map(({ atom, scope }) => projectRationaleToAdvisory(atom, scope));
  const standaloneRationales: RationaleAdvisory[] = [];
  for (const r of rationaleEntries) {
    const subj = normLit(r.subject);
    const host = subj.length >= 4
      ? operational.find((e) => { const lit = normLit(entrySubjectLiteral(e)); return lit.length >= 4 && (subj.includes(lit) || lit.includes(subj)) && !("attached_reason" in e && (e as Attachable).attached_reason); })
      : undefined;
    if (host) (host as Attachable).attached_reason = r.reason;
    else standaloneRationales.push(r);
  }

  const entries: KnowledgeEntry[] = [...operational, ...standaloneRationales].sort((a, b) => {
    const k = KIND_RANK[a.type] - KIND_RANK[b.type];
    if (k !== 0) return k;
    const d = scopeDepth(b.scope) - scopeDepth(a.scope);
    if (d !== 0) return d;
    return a.ref.localeCompare(b.ref);
  });

  const kept = entries.slice(0, budget);
  return {
    execution_context: ctx,
    entries: kept,
    provenance: { eligible: entries.length, delivered: kept.length, budget, truncated: entries.length > kept.length },
    conflicts: resolution.traces.filter((t) => t.reason_code !== "NO_CONFLICT"),
  };
}

// ── rendering (engine-neutral markdown) ─────────────────────────────────────────────────────────

// ── hook-index selection (the pathrule-hook.js mirror, kept here so the logic is unit-tested) ────

/** Leading-slash ancestor chain of a path, root last. Mirrors pathrule-hook.js `ancestorPaths`. */
export function advisoryAncestorPaths(startPath: string): string[] {
  if (!startPath || startPath === "/") return ["/"];
  const parts = startPath.split("/").filter((p) => p.length > 0);
  const out: string[] = [];
  for (let i = parts.length; i > 0; i--) out.push("/" + parts.slice(0, i).join("/"));
  out.push("/");
  return out;
}

/**
 * Select the advisories that apply to a tool's `relativePath`: every advisory scoped at an ancestor
 * of the path, then the workspace-global ones, deduped by ref, minus `skipRefs` (already delivered this
 * session), capped at `budget`. This is the exact logic pathrule-hook.js runs inline (it cannot import
 * this TS); keeping a tested twin here means the scope-and-budget behaviour is verified even though the
 * hook has its own copy.
 *
 * A stub with a `group` is one line of a memory's compiled form, and the completeness gate cleared that
 * form as a WHOLE. So a group is delivered entirely or not at all: cutting it at the budget would hand
 * the agent a projection nobody judged. A group that does not fit is skipped and the budget goes on to
 * the next stub.
 */
export function selectAdvisoriesForPath(
  index: { path_advisories?: Record<string, AdvisoryStub[]>; project_advisories?: AdvisoryStub[] },
  relativePath: string | null,
  budget: number = DEFAULT_ADVISORY_BUDGET,
  skipRefs?: ReadonlySet<string>,
): AdvisoryStub[] {
  const seen = new Set<string>();
  const applicable: AdvisoryStub[] = [];
  const push = (s: AdvisoryStub): void => {
    if (seen.has(s.ref)) return;
    seen.add(s.ref);
    if (!skipRefs?.has(s.ref)) applicable.push(s);
  };
  for (const anc of advisoryAncestorPaths(relativePath ?? "/")) for (const s of index.path_advisories?.[anc] ?? []) push(s);
  for (const s of index.project_advisories ?? []) push(s);
  const out: AdvisoryStub[] = [];
  const groupsSeen = new Set<string>();
  for (const s of applicable) {
    if (out.length >= budget) break;
    if (!s.group) { out.push(s); continue; }
    if (groupsSeen.has(s.group)) continue;
    groupsSeen.add(s.group);
    const members = applicable.filter((x) => x.group === s.group);
    if (out.length + members.length <= budget) out.push(...members);
  }
  return out;
}

/** Render selected advisory stubs as the neutral advisory section, or "" when none apply. */
export function renderAdvisorySection(stubs: AdvisoryStub[]): string {
  if (stubs.length === 0) return "";
  return [ADVISORY_SECTION_HEADER, ...stubs.map((s) => s.line)].join("\n");
}
