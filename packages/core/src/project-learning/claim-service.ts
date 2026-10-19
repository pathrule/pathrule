// SPDX-License-Identifier: Apache-2.0

import {
  existingLearningHints,
  type ExistingLearningHint,
  type ExistingLearningHintStore,
} from "./local-hints.js";
import { verifyReviewEvidence, checkoutRepository } from "./review-history.js";
import { parseReviewEvidence, reviewUrl } from "./review-evidence.js";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { allowedProjectPath, MAX_PROJECT_SOURCE_BYTES, readProjectSource } from "./capture.js";
import {
  LEARNING_CLAIM_INSTRUCTION,
  learningScopesOverlap,
  parseLearningClaim,
  requireWritableLearningClaim,
  validLearningScope,
  type LearningClaim,
  type LearningClaimStore,
} from "./claims.js";

export type ClaimCurrency = "current" | "stale" | "unknown";
type Source = LearningClaim["sources"][number];

/** Always hash working bytes, including assume-unchanged files. Nothing reads an LLM. */
async function checkSource(root: string, source: Source): Promise<ClaimCurrency> {
  if (!allowedProjectPath(source.path)) return "unknown";
  const bytes = await readProjectSource(root, source.path, MAX_PROJECT_SOURCE_BYTES);
  if (!bytes || bytes.includes(0)) return "unknown";
  const expected = source.digest;
  const hash = expected.startsWith("git:")
    ? createHash(expected.length === 44 ? "sha1" : "sha256")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex")
    : createHash("sha256").update(bytes).digest("hex");
  return expected.slice(expected.indexOf(":") + 1) === hash ? "current" : "stale";
}

export async function verifyLearningSources(
  rootPath: string,
  sources: Source[],
): Promise<ClaimCurrency> {
  if (!sources.length || sources.length > 6) return "unknown";
  try {
    const root = await realpath(rootPath);
    const states = await Promise.all(sources.map((source) => checkSource(root, source)));
    return states.includes("stale") ? "stale" : states.includes("unknown") ? "unknown" : "current";
  } catch {
    return "unknown";
  }
}

/** Stable identity makes retries and offline replay idempotent across processes. */
export function createLearningClaim(
  input: Omit<LearningClaim, "id" | "version" | "origin">,
): LearningClaim {
  const body = {
    version: 1 as const,
    workspaceId: input.workspaceId,
    nodePath: input.nodePath,
    topic: input.topic.trim(),
    statement: input.statement.trim(),
    category: input.category,
    sources: input.sources
      .map((s) => ({ path: s.path, digest: s.digest }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    origin: "agent_synthesis" as const,
    ...(input.reviewSources
      ? {
          reviewSources: input.reviewSources
            .map((raw) => {
              const source = parseReviewEvidence(raw);
              if (!source) throw new Error("Invalid review evidence");
              return source;
            })
            .sort((a, b) => {
              const first = `${a.repository}:${a.pullRequest}:${a.kind}:${a.id}`;
              const second = `${b.repository}:${b.pullRequest}:${b.kind}:${b.id}`;
              return first < second ? -1 : first > second ? 1 : 0;
            }),
        }
      : {}),
  };
  return requireWritableLearningClaim({
    ...body,
    id: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  });
}

export interface LearningContext {
  status: "available" | "unavailable";
  scope: string;
  /** Current against this checkout and not in conflict. Agent-authored, never instructions. */
  claims: LearningClaim[];
  withheld: Array<{
    id: string;
    reason: ClaimCurrency | "conflict";
    paths: string[];
    reviewUrls?: string[];
  }>;
  localHints?: ExistingLearningHint[];
  bounded: true;
  instruction: string;
}

/** Bounded lazy validation; no worker, raw-code retention, or global stale mutation. */
export async function loadLearningContext(options: {
  backend: LearningClaimStore;
  workspaceId: string;
  localRootPath: string;
  scope?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<LearningContext> {
  const scope = validLearningScope(options.scope) ? options.scope : "/";
  const result: LearningContext = {
    status: "unavailable",
    scope,
    claims: [],
    withheld: [],
    bounded: true,
    instruction: LEARNING_CLAIM_INSTRUCTION,
  };
  const hints = await existingLearningHints(
    options.backend as ExistingLearningHintStore,
    options.workspaceId,
    scope,
  );
  if (hints.length) result.localHints = hints;
  if (!options.backend.listLearningClaims) return result;
  try {
    const rows = await options.backend.listLearningClaims(options.workspaceId, 100);
    const candidates = rows
      .map(parseLearningClaim)
      .filter(
        (c): c is LearningClaim =>
          c !== null &&
          c.workspaceId === options.workspaceId &&
          learningScopesOverlap(scope, c.nodePath),
      )
      .slice(0, 8);
    const root = await realpath(options.localRootPath);
    const repository = candidates.some((c) => c.reviewSources?.length)
      ? await checkoutRepository(root)
      : null;
    // Shared references are read once. At most 16 files / 4 MiB per context request.
    const checks = new Map<string, Promise<ClaimCurrency>>();
    for (const claim of candidates) {
      const states: ClaimCurrency[] = [];
      for (const source of claim.sources) {
        const key = `${source.path}:${source.digest}`;
        if (!checks.has(key) && checks.size < 16) checks.set(key, checkSource(root, source));
        states.push(await (checks.get(key) ?? Promise.resolve("unknown" as const)));
      }
      if (claim.reviewSources?.length)
        states.push(await verifyReviewEvidence(options, claim.reviewSources, { repository }));
      const currency = states.includes("stale")
        ? "stale"
        : states.includes("unknown")
          ? "unknown"
          : "current";
      if (currency === "current") result.claims.push(claim);
      else
        result.withheld.push({
          id: claim.id,
          reason: currency,
          paths: claim.sources.map((s) => s.path),
          ...(claim.reviewSources ? { reviewUrls: claim.reviewSources.map(reviewUrl) } : {}),
        });
    }
    // Same explicit topic + scope with incompatible syntheses requires review, not recency voting.
    const conflicts = new Set(
      result.claims
        .filter((a) =>
          result.claims.some(
            (b) =>
              a.id !== b.id &&
              a.nodePath === b.nodePath &&
              a.topic.toLowerCase() === b.topic.toLowerCase() &&
              a.statement !== b.statement,
          ),
        )
        .map((c) => c.id),
    );
    result.claims = result.claims.filter((c) => {
      if (!conflicts.has(c.id)) return true;
      result.withheld.push({ id: c.id, reason: "conflict", paths: c.sources.map((s) => s.path) });
      return false;
    });
    result.status = "available";
    while (
      JSON.stringify(result).length > 6000 &&
      (result.claims.length || result.withheld.length || result.localHints?.length)
    ) {
      if (result.localHints?.length) result.localHints.pop();
      else if (result.claims.length) result.claims.pop();
      else result.withheld.pop();
    }
    return result;
  } catch {
    return { ...result, status: "unavailable", claims: [], withheld: [] };
  }
}
