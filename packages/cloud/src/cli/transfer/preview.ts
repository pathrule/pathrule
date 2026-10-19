// SPDX-License-Identifier: Apache-2.0
// What a copy of Local knowledge to Pathrule Cloud would do, said before anything leaves the
// machine: the items and their size, what is kept and what is lost or changed, and whether it fits
// the workspace's plan (`GET /v1/workspaces/:ws/usage`). An item over a limit is listed as one that
// cannot be copied; nothing is ever shortened to fit.
import { createHash } from "node:crypto";

import { formatBytes, formatCount } from "@pathrule/cli/terminal/text.js";

import { freeOf, type CloudWorkspaceUsage } from "../../native/client/usage.js";
import type { LocalTransferItem, LocalTransferSource, TransferKind } from "./source.js";

/**
 * The id the copy of a Local item gets on Pathrule Cloud: the same for the same item, source and
 * target on every run, so a second run finds the first run's copy (`ifAbsent`) instead of making
 * another. Bound to the Cloud workspace, so one Local item copied to two workspaces is two items.
 */
export function transferItemId(
  localWorkspaceId: string,
  kind: TransferKind,
  localItemId: string,
  cloudWorkspaceId: string,
): string {
  const digest = createHash("sha256")
    .update(`${localWorkspaceId}\0${kind}\0${localItemId}\0${cloudWorkspaceId}`)
    .digest("base64url");
  return `lt_${digest}`.slice(0, 40);
}

/** What the Cloud write of an item carries besides its ids, node, origin and `ifAbsent`. */
export function writeBodyOf(item: LocalTransferItem): Record<string, unknown> {
  if (item.kind === "memory")
    return {
      title: item.title,
      content: item.content,
      source: item.source,
      relatedPaths: item.relatedPaths,
    };
  if (item.kind === "rule")
    return {
      name: item.title,
      content: item.content,
      scopeType: item.scopeType,
      priority: item.priority,
      ...(item.constraints.length > 0 ? { constraints: item.constraints } : {}),
    };
  return {
    name: item.title,
    content: item.content,
    description: item.description,
    source: item.source,
    githubUrl: item.githubUrl,
    tags: item.tags,
  };
}

/** The paths an item's Cloud copy is placed at: its owner (the root when none) and its links. */
export function placementsOf(item: LocalTransferItem): string[] {
  const own = item.path ?? "/";
  return item.kind === "memory" ? [...new Set([own, ...item.relatedPaths])] : [own];
}

/** `path` and every folder above it, up to the root. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = parts.length; i > 0; i -= 1) out.push(`/${parts.slice(0, i).join("/")}`);
  out.push("/");
  return out;
}

/**
 * The index vectors Pathrule Cloud keeps for an item placed at `paths`: one for each path and one
 * for each folder above any of them (its own path counts in both sets). The Cloud's rule, mirrored
 * (the Cloud service's `projectionTokens`).
 */
export function vectorCount(paths: readonly string[]): number {
  const exact = new Set(paths);
  const above = new Set<string>();
  for (const path of exact) for (const a of ancestorsOf(path)) above.add(a);
  return above.size + exact.size;
}

export type BlockedReason = "item_too_large" | "title_too_long" | "too_many_vectors";

export interface PlannedItem {
  item: LocalTransferItem;
  /** Its id on Pathrule Cloud (`transferItemId`). */
  id: string;
  bytes: number;
  vectors: number;
  /** Why it cannot be copied; null when it can. */
  blocked: { reason: BlockedReason; detail: string } | null;
}

const bytesOf = (item: LocalTransferItem): number =>
  Buffer.byteLength(JSON.stringify(writeBodyOf(item)), "utf8");

export function planItems(
  items: readonly LocalTransferItem[],
  ids: { local: string; cloud: string },
  usage: CloudWorkspaceUsage | null,
): PlannedItem[] {
  return items.map((item) => {
    const bytes = bytesOf(item);
    const vectors = vectorCount(placementsOf(item));
    let blocked: PlannedItem["blocked"] = null;
    if (usage && bytes > usage.itemMaxBytes)
      blocked = {
        reason: "item_too_large",
        detail: `${formatBytes(bytes)}, the limit is ${formatBytes(usage.itemMaxBytes)}`,
      };
    else if (usage && item.title.length > usage.titleMaxChars)
      blocked = {
        reason: "title_too_long",
        detail: `its title is ${formatCount(item.title.length)} characters, the limit is ${formatCount(usage.titleMaxChars)}`,
      };
    else if (usage && vectors > usage.maxVectorsPerItem)
      blocked = {
        reason: "too_many_vectors",
        detail: `it would take ${formatCount(vectors)} index vectors, the limit is ${formatCount(usage.maxVectorsPerItem)}`,
      };
    return {
      item,
      id: transferItemId(ids.local, item.kind, item.localId, ids.cloud),
      bytes,
      vectors,
      blocked,
    };
  });
}

interface LimitCheck {
  needed: number;
  /** What the plan leaves free; null when it sets no limit. */
  free: number | null;
  fits: boolean;
}

export interface TransferPreview {
  source: { local_workspace_id: string; name: string | null; root: string };
  target: {
    workspace_id: string;
    workspace_name: string;
    organization_id: string;
    organization_name: string | null;
  };
  /** The items this run would copy (not those an earlier run copied). */
  counts: { memories: number; rules: number; skills: number; total: number };
  bytes: number;
  /** Items an earlier run copied; they are not sent again. */
  already_copied: number;
  kept: string[];
  lost_or_changed: string[];
  /** Null when Pathrule Cloud did not report the workspace's limits. */
  limits: {
    storage: LimitCheck;
    vectors: LimitCheck & { estimate: string };
    nodes: LimitCheck & { upper_bound: boolean };
  } | null;
  limits_unavailable: string | null;
  cannot_copy: Array<{
    kind: TransferKind;
    local_id: string;
    title: string;
    reason: BlockedReason;
    detail: string;
  }>;
  /** What does not fit the plan, said before the person is asked. Empty when it all fits. */
  does_not_fit: string[];
}

const KEPT = [
  "Paths and related paths; rule priority, scope and constraint atoms; skill content, description, tags, source and GitHub URL.",
];

const LOST_OR_CHANGED = [
  "Original author and dates: Pathrule Cloud records you as the author and now as the time; each item's origin note keeps its Local dates.",
  "Skill versions restart at 1.0.0; each skill's origin note keeps its Local version.",
  "Remedy evidence and private session content are not copied.",
  "Local search vectors are not copied: Pathrule Cloud indexes the copies itself.",
  "Activity is copied separately: pathrule activity import --from-local",
];

const VECTOR_RULE =
  "one per path an item is placed at and one per folder above it, as Pathrule Cloud indexes";

const plural = (n: number, one: string, many: string) =>
  `${formatCount(n)} ${n === 1 ? one : many}`;

export function buildPreview(input: {
  planned: readonly PlannedItem[];
  source: Pick<LocalTransferSource, "workspaceId" | "name" | "root">;
  target: TransferPreview["target"];
  usage: CloudWorkspaceUsage | null;
  usageError: string | null;
  /** The node paths the Cloud workspace has; null when they could not be read. */
  cloudPaths: ReadonlySet<string> | null;
  alreadyCopied: number;
}): TransferPreview {
  const { planned, usage } = input;
  const copyable = planned.filter((p) => !p.blocked);
  const count = (kind: TransferKind) => planned.filter((p) => p.item.kind === kind).length;
  const lost = [...LOST_OR_CHANGED];
  for (const p of planned) {
    if (p.item.extraPaths.length === 0) continue;
    lost.push(
      `${p.item.kind} "${p.item.title}" is attached at ${p.item.extraPaths.length + 1} Local paths; Pathrule Cloud keeps ${p.item.path ?? "/"} only (not ${p.item.extraPaths.join(", ")}).`,
    );
  }
  const rootless = planned.filter((p) => p.item.kind === "memory" && p.item.path === null).length;
  if (rootless > 0)
    lost.push(
      rootless === 1
        ? "1 memory has no Local path and goes to the workspace root (/)."
        : `${formatCount(rootless)} memories have no Local path and go to the workspace root (/).`,
    );

  let limits: TransferPreview["limits"] = null;
  const doesNotFit: string[] = [];
  if (usage) {
    const bytes = copyable.reduce((n, p) => n + p.bytes, 0);
    const vectors = copyable.reduce((n, p) => n + p.vectors, 0);
    const paths = new Set<string>();
    for (const p of copyable)
      for (const placement of placementsOf(p.item))
        for (const a of ancestorsOf(placement)) paths.add(a);
    const nodes = [...paths].filter((p) => !input.cloudPaths?.has(p)).length;
    const check = (needed: number, used: number, limit: number | null): LimitCheck => {
      const free = freeOf(used, limit);
      return { needed, free, fits: free === null || needed <= free };
    };
    limits = {
      storage: check(bytes, usage.storage.usedBytes, usage.storage.limitBytes),
      vectors: {
        ...check(vectors, usage.vectors.used, usage.vectors.limit),
        estimate: VECTOR_RULE,
      },
      nodes: {
        ...check(nodes, usage.nodes.used, usage.nodes.limit),
        upper_bound: input.cloudPaths === null,
      },
    };
    if (!limits.storage.fits)
      doesNotFit.push(
        `Storage: ${formatBytes(bytes)} needed, ${formatBytes(limits.storage.free!)} free.`,
      );
    if (!limits.vectors.fits)
      doesNotFit.push(
        `Index: about ${formatCount(vectors)} vectors needed, ${formatCount(limits.vectors.free!)} free.`,
      );
    if (!limits.nodes.fits)
      doesNotFit.push(
        `Nodes: ${limits.nodes.upper_bound ? "up to " : ""}${formatCount(nodes)} new nodes needed, ${formatCount(limits.nodes.free!)} free.`,
      );
  }
  return {
    source: {
      local_workspace_id: input.source.workspaceId,
      name: input.source.name,
      root: input.source.root,
    },
    target: input.target,
    counts: {
      memories: count("memory"),
      rules: count("rule"),
      skills: count("skill"),
      total: planned.length,
    },
    bytes: planned.reduce((n, p) => n + p.bytes, 0),
    already_copied: input.alreadyCopied,
    kept: KEPT,
    lost_or_changed: lost,
    limits,
    limits_unavailable: usage ? null : (input.usageError ?? "not reported"),
    cannot_copy: planned
      .filter((p) => p.blocked)
      .map((p) => ({
        kind: p.item.kind,
        local_id: p.item.localId,
        title: p.item.title,
        reason: p.blocked!.reason,
        detail: p.blocked!.detail,
      })),
    does_not_fit: doesNotFit,
  };
}

const free = (n: number | null, format: (n: number) => string) =>
  n === null ? "no limit on this plan" : `${format(n)} free`;

/** The preview as a person reads it. */
export function previewLines(preview: TransferPreview): string[] {
  const { counts, target, limits } = preview;
  const where = preview.source.name
    ? `"${preview.source.name}" (${preview.source.root})`
    : preview.source.root;
  const lines = [
    `This folder's Local knowledge can be copied to Pathrule Cloud. Your Local workspace is never changed.`,
    `  From: Local workspace ${where}`,
    `  To: "${target.workspace_name}"${target.organization_name ? ` in "${target.organization_name}"` : ""}`,
    `  ${plural(counts.memories, "memory", "memories")}, ${plural(counts.rules, "rule", "rules")}, ${plural(counts.skills, "skill", "skills")} (${plural(counts.total, "item", "items")}, ${formatBytes(preview.bytes)})${preview.already_copied > 0 ? `; ${plural(preview.already_copied, "item was", "items were")} copied earlier` : ""}`,
    `  Kept: ${preview.kept.join(" ")}`,
    "  Lost or changed:",
    ...preview.lost_or_changed.map((l) => `  - ${l}`),
  ];
  if (limits) {
    lines.push(
      `  Limits of the plan:`,
      `  - Storage: ${formatBytes(limits.storage.needed)} needed, ${free(limits.storage.free, formatBytes)}.`,
      `  - Index: about ${formatCount(limits.vectors.needed)} vectors needed (${limits.vectors.estimate}), ${free(limits.vectors.free, formatCount)}.`,
      `  - Nodes: ${limits.nodes.upper_bound ? "up to " : ""}${formatCount(limits.nodes.needed)} new needed, ${free(limits.nodes.free, formatCount)}.`,
    );
  } else {
    lines.push(
      `  Limits of the plan: not known (${preview.limits_unavailable}); Pathrule Cloud checks each item as it is written.`,
    );
  }
  if (preview.cannot_copy.length > 0)
    lines.push(
      "  Cannot be copied (never shortened to fit):",
      ...preview.cannot_copy.map((c) => `  - ${c.kind} "${c.title}": ${c.detail}`),
    );
  if (preview.does_not_fit.length > 0)
    lines.push(
      "  Does not fit, so the copy would stop when the plan is full:",
      ...preview.does_not_fit.map((l) => `  - ${l}`),
    );
  return lines;
}
