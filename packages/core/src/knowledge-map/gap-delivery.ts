// SPDX-License-Identifier: Apache-2.0
//
// How an open knowledge gap reaches the agent that can close it. One line, once
// per session, only while it writes inside the gap. pathrule-hook.js carries an inline twin of
// selectKnowledgeGap (it may not import anything); a parity test pins the two together.

import type { KnowledgeGapStub } from "@pathrule/protocol/hook-index.js";
import { COVERAGE_WINDOW_DAYS, type KnowledgeGap } from "@pathrule/protocol/knowledge-gap.js";

export const KNOWLEDGE_GAP_HEADER = "Pathrule knowledge gap (advisory; it never overrides a rule or constraint):";
export const KNOWLEDGE_GAP_LINE_MAX = 280;
/** At most this many gaps reach a turn-start context (get_context, the host's turn zero). */
export const KNOWLEDGE_GAP_TURN_MAX = 2;

export function renderGapLine(gap: Pick<KnowledgeGap, "kind" | "scope" | "commits" | "commitsAfterKnowledge">): string {
  const what =
    gap.kind === "uncovered"
      ? `nothing recorded references ${gap.scope} (${gap.commits} commits in ${COVERAGE_WINDOW_DAYS} days)`
      : `${gap.commitsAfterKnowledge} commits landed in ${gap.scope} after the newest knowledge about it`;
  return `${what}. If this task teaches you something durable here, record it with pathrule_record_learning and cite the files you read.`.slice(
    0,
    KNOWLEDGE_GAP_LINE_MAX,
  );
}

export function gapStub(gap: KnowledgeGap): KnowledgeGapStub {
  return { ref: gap.ref, scope: gap.scope, line: renderGapLine(gap) };
}

/** The first undelivered stub whose scope contains the file. TS twin of the hook's selection. */
export function selectKnowledgeGap(
  index: { knowledge_gaps?: KnowledgeGapStub[] },
  relativeFilePath: string,
  delivered: ReadonlySet<string>,
): KnowledgeGapStub | null {
  const path = relativeFilePath.replace(/^\/+/, "");
  for (const stub of index.knowledge_gaps ?? []) {
    if (delivered.has(stub.ref)) continue;
    if (path === stub.scope || path.startsWith(`${stub.scope}/`)) return stub;
  }
  return null;
}

const trimSlashes = (path: string): string => path.replace(/^\/+|\/+$/g, "");

/**
 * Whether a gap and a turn's scope overlap: either contains the other. The root overlaps
 * nothing, because a turn at the root has not said where it will work; the hook still tells
 * it at the first write inside the gap.
 */
export function gapScopeOverlaps(gapScope: string, turnScope: string): boolean {
  const gap = trimSlashes(gapScope);
  const turn = trimSlashes(turnScope);
  if (!gap || !turn) return false;
  return gap === turn || gap.startsWith(`${turn}/`) || turn.startsWith(`${gap}/`);
}

/** The gaps a turn-start context names: overlapping its scope, not yet delivered, at most two. */
export function selectGapsForScope(
  stubs: readonly KnowledgeGapStub[],
  turnScope: string,
  delivered: ReadonlySet<string>,
  max = KNOWLEDGE_GAP_TURN_MAX,
): KnowledgeGapStub[] {
  return stubs.filter((stub) => !delivered.has(stub.ref) && gapScopeOverlaps(stub.scope, turnScope)).slice(0, max);
}

/** The header plus one line per gap, for a rendered (non-JSON) context block. */
export function renderGapBlock(stubs: readonly KnowledgeGapStub[]): string {
  return stubs.length ? [KNOWLEDGE_GAP_HEADER, ...stubs.map((stub) => `- ${stub.line}`)].join("\n") : "";
}
