// SPDX-License-Identifier: Apache-2.0

import { isSafeSourcePath } from "../activity/activity-leads.js";

/** Portable references only. No reviewer identity, raw text, diff or credentials. */
export interface ReviewEvidence {
  repository: string;
  pullRequest: number;
  kind: "review" | "review_comment";
  id: number;
  digest: string;
  commit: string;
  mergedAt: string;
  association: "OWNER" | "MEMBER" | "COLLABORATOR";
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  path?: string;
}

export const validRepository = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/.test(value) &&
  !value.endsWith("/.") &&
  !value.endsWith("/..");
export const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function parseReviewEvidence(raw: unknown): ReviewEvidence | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as ReviewEvidence;
  if (
    !validRepository(r.repository) ||
    !positiveId(r.pullRequest) ||
    !positiveId(r.id) ||
    !["review", "review_comment"].includes(r.kind) ||
    !["OWNER", "MEMBER", "COLLABORATOR"].includes(r.association) ||
    !["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(r.state) ||
    typeof r.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(r.digest) ||
    typeof r.commit !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(r.commit) ||
    typeof r.mergedAt !== "string" ||
    !Number.isFinite(Date.parse(r.mergedAt)) ||
    (r.path !== undefined && (typeof r.path !== "string" || !isSafeSourcePath(r.path)))
  )
    return null;
  return {
    repository: r.repository,
    pullRequest: r.pullRequest,
    kind: r.kind,
    id: r.id,
    digest: r.digest,
    commit: r.commit,
    mergedAt: r.mergedAt,
    association: r.association,
    state: r.state,
    ...(r.path ? { path: r.path } : {}),
  };
}

export function reviewUrl(r: ReviewEvidence): string {
  return `https://github.com/${r.repository}/pull/${r.pullRequest}#${r.kind === "review" ? "pullrequestreview" : "discussion_r"}${r.kind === "review" ? "-" : ""}${r.id}`;
}
