// SPDX-License-Identifier: Apache-2.0
/**
 * The deterministic cross-primitive conflict compiler (V33).
 *
 * Given the delivery candidates for one execution and the APPROVED precedence edges that apply, it
 * decides which conflicting candidates to keep and which to withhold, and emits an explainable trace
 * for every decision. It makes ZERO model calls: the model may propose precedence at write time, but
 * once approved, resolution is pure and deterministic.
 *
 * Design commitments (all conservative):
 *  - A conflict exists only when candidates share the same conflict key (same condition / context /
 *    operation) but name DIFFERENT choices. Different keys never conflict (web-React vs api-Fastify is
 *    not a conflict). Same choice never conflicts (agreement).
 *  - Precedence is NON-TRANSITIVE in V1: only a DIRECT edge winner>loser resolves a pair. A>B and B>C
 *    does not grant A>C. This is the safest contract and makes cycles trivial to keep safe.
 *  - A conflict is resolved ONLY when exactly one candidate choice directly beats every other choice in
 *    the group (a clear champion) with no contradicting edge. Otherwise every side is WITHHELD:
 *    UNRESOLVED_CONFLICT, AMBIGUOUS_PRECEDENCE (both directions), or PRECEDENCE_CYCLE. Never guess.
 *  - Precedence edges are scope-aware: an edge only applies when its scope applies to the execution
 *    path, reusing the same ancestor semantics as knowledge selection.
 *  - Enforcement is NOT in this graph: CONSTRAINT/CHECK are compiled separately and a forbidden choice
 *    is already dropped before conflict resolution, so precedence can never let advisory defeat
 *    enforcement.
 */
import { scopeApplies } from "./agent-ir.js";

export type ConflictReasonCode =
  | "NO_CONFLICT"
  | "EXPLICIT_PRECEDENCE"
  | "UNRESOLVED_CONFLICT"
  | "AMBIGUOUS_PRECEDENCE"
  | "PRECEDENCE_CYCLE";

/** The kinds that can auto-conflict. CONTEXT/RATIONALE coexist (never auto-detected as a conflict). */
export type ConflictKind = "remedy" | "selection" | "procedure";

export interface ConflictCandidate {
  id: string;
  kind: ConflictKind;
  /** Normalized condition/context/operation. Candidates that share it are about the same thing. */
  conflictKey: string;
  /** The identity choice (remedy action / selection preferred / procedure operation+steps) for matching. */
  literal: string;
  scope: string | null;
}

/** An approved precedence edge, reduced to the literals it relates and the scope it holds in. */
export interface PrecedenceEdge {
  ref: string;
  winner: string;
  loser: string;
  scope: string | null;
}

export interface ConflictTrace {
  conflict_id: string;
  kind: ConflictKind;
  scope_key: string;
  candidate_ids: string[];
  applicable_precedence_ids: string[];
  winner_id: string | null;
  withheld_ids: string[];
  reason_code: ConflictReasonCode;
}

export interface ConflictResolution {
  keep: Set<string>;
  withhold: Set<string>;
  traces: ConflictTrace[];
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Two literals relate when they are equal, or one contains the other as a WHOLE WORD/phrase. Word
 * boundaries are load-bearing: a bare substring match confuses "npm" with "pnpm" and would let a
 * precedence edge resolve the wrong pair. A precedence edge names the actual competing choice, so a
 * clean edge like "pnpm takes precedence over npm" matches the "pnpm" and "npm" selections exactly.
 */
function overlaps(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (x === y) return true;
  if (y.length >= 2 && new RegExp(`\\b${escapeRe(y)}\\b`).test(x)) return true;
  if (x.length >= 2 && new RegExp(`\\b${escapeRe(x)}\\b`).test(y)) return true;
  return false;
}

/**
 * Word tokens of a literal. Any two literals that overlap() (equal, or one contains the other as a
 * whole word/phrase) necessarily SHARE at least one token, so a shared-token index is a sound
 * pre-filter for overlap with zero false negatives. This keeps per-group edge lookup near the size of
 * the genuinely related edges instead of scanning every approved edge for every conflict group.
 */
const tokensOf = (s: string): string[] => norm(s).split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Resolve conflicts among candidates using approved precedence edges applicable to `execPath`.
 * Pure and deterministic. Candidates not in any conflict are kept untouched.
 */
export function resolveConflicts(
  candidates: readonly ConflictCandidate[],
  edges: readonly PrecedenceEdge[],
  execPath: string | null,
): ConflictResolution {
  const keep = new Set<string>();
  const withhold = new Set<string>();
  const traces: ConflictTrace[] = [];
  const applicableEdges = edges.filter((e) => scopeApplies(e.scope, execPath) && !overlaps(e.winner, e.loser));
  // Inverted index: token -> edges whose winner or loser contains that token. Overlap implies a shared
  // token, so gathering edges by a group's choice tokens yields every possibly-matching edge and no
  // more. Edges with no tokens at all (purely symbolic) can only match by equality; index them under a
  // sentinel so they are still considered.
  const edgesByToken = new Map<string, PrecedenceEdge[]>();
  const NO_TOKEN = "\u0000";
  for (const e of applicableEdges) {
    const toks = [...new Set([...tokensOf(e.winner), ...tokensOf(e.loser)])];
    for (const tok of toks.length ? toks : [NO_TOKEN]) (edgesByToken.get(tok) ?? edgesByToken.set(tok, []).get(tok)!).push(e);
  }

  // Group by kind + conflict key.
  const groups = new Map<string, ConflictCandidate[]>();
  for (const c of candidates) {
    const k = `${c.kind}\u0000${norm(c.conflictKey)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
  }

  for (const [gk, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const kind = group[0]!.kind;
    const scopeKey = gk.split("\u0000")[1] ?? "";
    // Distinct choices in this group. One choice (even across duplicate atoms) is agreement, not conflict.
    const distinct = [...new Set(group.map((c) => norm(c.literal)))];
    if (distinct.length <= 1) { for (const c of group) keep.add(c.id); continue; }

    const conflictId = `conflict:${kind}:${scopeKey}`;
    // Only edges that share a token with some choice in THIS group can match it. Gather that small
    // subset once, then do the exact word-boundary matching over it (instead of scanning every edge).
    const relevant = new Set<PrecedenceEdge>();
    for (const c of distinct) {
      const toks = tokensOf(c);
      for (const tok of toks.length ? toks : [NO_TOKEN]) for (const e of edgesByToken.get(tok) ?? []) relevant.add(e);
      for (const e of edgesByToken.get(NO_TOKEN) ?? []) relevant.add(e);
    }
    const groupEdges = [...relevant];
    // Edges among THIS group's choices only (direct, non-transitive).
    const beats = new Map<string, Set<string>>(); // winnerLiteral -> set of loserLiterals it directly beats
    const usedEdgeIds = new Set<string>();
    for (const w of distinct) for (const l of distinct) {
      if (w === l) continue;
      const edge = groupEdges.find((e) => overlaps(e.winner, w) && overlaps(e.loser, l));
      if (edge) { (beats.get(w) ?? beats.set(w, new Set()).get(w)!).add(l); usedEdgeIds.add(edge.ref); }
    }

    // Ambiguous: any pair with edges in BOTH directions.
    let ambiguous = false;
    for (const a of distinct) for (const b of distinct) {
      if (a < b && beats.get(a)?.has(b) && beats.get(b)?.has(a)) ambiguous = true;
    }
    // Directed cycle among choices (transitive traversal only to DETECT a cycle, never to resolve).
    const hasCycle = detectCycle(distinct, beats);

    let reason: ConflictReasonCode;
    let winnerLiteral: string | null = null;
    if (ambiguous) reason = "AMBIGUOUS_PRECEDENCE";
    else if (hasCycle) reason = "PRECEDENCE_CYCLE";
    else {
      // A champion directly beats EVERY other choice, and is beaten by none.
      const champions = distinct.filter((c) =>
        distinct.every((o) => o === c || (beats.get(c)?.has(o) && !beats.get(o)?.has(c))));
      if (champions.length === 1) { reason = "EXPLICIT_PRECEDENCE"; winnerLiteral = champions[0]!; }
      else reason = "UNRESOLVED_CONFLICT";
    }

    const winnerIds: string[] = [];
    const withheldIds: string[] = [];
    for (const c of group) {
      if (reason === "EXPLICIT_PRECEDENCE" && norm(c.literal) === winnerLiteral) { keep.add(c.id); winnerIds.push(c.id); }
      else { withhold.add(c.id); withheldIds.push(c.id); }
    }
    traces.push({
      conflict_id: conflictId, kind, scope_key: scopeKey,
      candidate_ids: group.map((c) => c.id),
      applicable_precedence_ids: [...usedEdgeIds].sort(),
      winner_id: winnerIds[0] ?? null,
      withheld_ids: withheldIds,
      reason_code: reason,
    });
  }
  return { keep, withhold, traces };
}

/** Detect a directed cycle in the choice graph (used only to report PRECEDENCE_CYCLE, never to resolve). */
function detectCycle(nodes: readonly string[], beats: ReadonlyMap<string, Set<string>>): boolean {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(nodes.map((n) => [n, WHITE]));
  const visit = (n: string): boolean => {
    color.set(n, GRAY);
    for (const m of beats.get(n) ?? []) {
      const c = color.get(m);
      if (c === GRAY) return true;
      if (c === WHITE && visit(m)) return true;
    }
    color.set(n, BLACK);
    return false;
  };
  for (const n of nodes) if (color.get(n) === WHITE && visit(n)) return true;
  return false;
}
