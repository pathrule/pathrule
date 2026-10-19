// SPDX-License-Identifier: Apache-2.0
//
// The text views an agent reads. Every view has a hard cap (plan "Token and access
// budget") and truncates at a line boundary with a pointer to the rest; nothing here is
// sent unless an agent asks for it.

import type { KnowledgeGapSummary } from "../backend/knowledge-map-input.js";
import type { KnowledgeMap, KnowledgeRegion, MapFinding, MapItem } from "./types.js";
import { pathDepth } from "./anchors.js";
import { ANCHOR_MIN_DEPTH } from "@pathrule/protocol/knowledge-gap.js";
import { findingsFor } from "./findings.js";

export const ATLAS_MAX_CHARS = 4_000;
export const REGION_PAGE_MAX_CHARS = 18_000;
export const RELATED_MAX_CHARS = 4_000;
export const PAGE_MAX_MEMBERS = 40;

export const AUDIT_CHECKLIST =
  "Audit checklist: 1) statements that contradict each other; 2) a rule its companion skill or memory contradicts; 3) memories that say the same thing; 4) references to code that no longer exists; 5) knowledge older than the code it describes. Compare boundary items with neighbour regions only. File drift with pathrule_request_refresh; edit knowledge only when asked.";

const KIND_LETTER = { memory: "M", rule: "R", skill: "S" } as const;

function short(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

const percent = (x: number): string => `${Math.round(x * 100)}%`;
const thousands = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Join lines and stop at the cap on a line boundary, saying what was left out. */
export function capLines(lines: readonly string[], max: number, more: (left: number) => string): string {
  const out: string[] = [];
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const tail = more(lines.length - i);
    if (size + line.length + 1 + tail.length + 1 > max) {
      out.push(tail);
      return out.join("\n");
    }
    out.push(line);
    size += line.length + 1;
  }
  return out.join("\n");
}

function kindCounts(map: KnowledgeMap, ids: readonly string[]): string {
  const counts = { memory: 0, rule: 0, skill: 0 };
  for (const id of ids) counts[map.items[id]!.kind]++;
  return `${counts.memory}/${counts.rule}/${counts.skill}`;
}

function regionIssueCounts(map: KnowledgeMap, region: KnowledgeRegion) {
  const members = new Set(region.memberIds);
  const related = findingsFor(map.findings, members);
  return {
    consolidate: related.filter((f) => f.kind === "consolidate").reduce((sum, f) => sum + ("itemIds" in f ? f.itemIds.filter((id) => members.has(id)).length : 0), 0),
    companions: related.filter((f) => f.kind === "companion_unlinked").length,
    unused: related.filter((f) => f.kind === "unused").length,
  };
}

export interface AtlasExtras {
  /** Knowledge-gap findings; absent or empty adds nothing to the atlas. */
  gaps?: KnowledgeGapSummary | null;
}

// A node path counts from depth 2 ("packages/cli"): a gap one level under a package's node is
// that package's knowledge sitting next to unrecorded change.
const NODE_MIN_DEPTH = 2;

function touchesScope(path: string, scope: string, minAncestorDepth: number): boolean {
  if (!path) return false;
  return path === scope || path.startsWith(`${scope}/`) || (scope.startsWith(`${path}/`) && pathDepth(path) >= minAncestorDepth);
}

/**
 * Open gaps a region's knowledge touches: a path one of its items references lies inside the
 * gap (or is an ancestor deep enough to anchor it), or one of its nodes sits on or above it.
 */
export function regionOpenGaps(map: KnowledgeMap, region: KnowledgeRegion, openScopes: readonly string[]): number {
  let count = 0;
  for (const scope of openScopes) {
    const touched = region.memberIds.some((id) => {
      const item = map.items[id]!;
      return (
        item.anchors.some((path) => touchesScope(path, scope, ANCHOR_MIN_DEPTH)) ||
        item.nodePaths.some((node) => touchesScope(node.replace(/^\/+|\/+$/g, ""), scope, NODE_MIN_DEPTH))
      );
    });
    if (touched) count++;
  }
  return count;
}

function gapsLine(gaps: KnowledgeGapSummary): string {
  return `Knowledge gaps: ${gaps.openScopes.length} open, ${gaps.closedLast30Days} closed in 30 days. A gap closes when recorded knowledge anchors its files, or when a person dismisses it in Knowledge Maintenance.`;
}

export function renderAtlas(map: KnowledgeMap, extras: AtlasExtras = {}): string {
  const items = Object.values(map.items);
  const all = items.map((item) => item.id);
  const number = new Map(map.regions.map((region, i) => [region.id, i + 1]));
  const gaps = extras.gaps && (extras.gaps.openScopes.length > 0 || extras.gaps.closedLast30Days > 0) ? extras.gaps : null;
  // The column exists only while a gap is open, so an atlas without gaps is byte-identical.
  const gapColumn = (gaps?.openScopes.length ?? 0) > 0;
  const lines = [
    `Knowledge atlas: ${items.length} items (M/R/S ${kindCounts(map, all)}) in ${map.regions.length} regions, grouped by links and meaning, not folders. Semantic source: ${map.semantic}.`,
    ...(gaps ? [gapsLine(gaps)] : []),
    "Open a region with view=region region_id=<id>; issues are counts, the region page lists them.",
    `| # | id | anchor item | terms | M/R/S | ~tokens | home (fit) | cohesion | neighbours | consolidate | unlinked companions | unused |${gapColumn ? " open gaps |" : ""}`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|${gapColumn ? "---|" : ""}`,
  ];
  const rows = map.regions.map((region, i) => {
    const issues = regionIssueCounts(map, region);
    const neighbours = region.neighbours.map((n) => `#${number.get(n.regionId)}`).join(", ") || "-";
    const gapCell = gapColumn ? ` ${regionOpenGaps(map, region, gaps!.openScopes)} |` : "";
    return `| ${i + 1} | ${region.id} | ${short(map.items[region.anchorId]!.title, 48)} | ${region.terms.join(", ") || "-"} | ${kindCounts(map, region.memberIds)} | ${thousands(region.tokens)} | ${region.homePath} (${percent(region.pathFit)}) | ${percent(region.cohesion)} | ${neighbours} | ${issues.consolidate} | ${issues.companions} | ${issues.unused} |${gapCell}`;
  });
  const loose = items.filter((item) => item.loose).length;
  const footer = `Loosely attached by path only: ${loose}. Workspace conventions (no topical edge): ${map.conventions.length}. Map ${map.algorithm}, fingerprint ${map.fingerprint.slice(0, 12)}.`;
  return capLines([...lines, ...rows, footer], ATLAS_MAX_CHARS, (left) => `(+${left} more lines; the region pages carry the rest)`);
}

export interface RegionPage {
  number: number;
  title: string;
  memberIds: string[];
  subRegionId: string | null;
}

/** Audit pages of a region: one per sub-region (chunked to 40 members), loose items last. */
export function regionPages(map: KnowledgeMap, region: KnowledgeRegion): RegionPage[] {
  const pages: RegionPage[] = [];
  const groups = region.subRegions.length > 0
    ? region.subRegions.map((sub) => ({ id: sub.id as string | null, anchorId: sub.anchorId, memberIds: sub.memberIds }))
    : [{ id: null, anchorId: region.anchorId, memberIds: region.memberIds.filter((id) => !map.items[id]!.loose) }];
  for (const group of groups) {
    for (let start = 0; start < group.memberIds.length; start += PAGE_MAX_MEMBERS) {
      pages.push({
        number: pages.length + 1,
        title: map.items[group.anchorId]!.title,
        memberIds: group.memberIds.slice(start, start + PAGE_MAX_MEMBERS),
        subRegionId: group.id,
      });
    }
  }
  const loose = region.memberIds.filter((id) => map.items[id]!.loose);
  for (let start = 0; start < loose.length; start += PAGE_MAX_MEMBERS) {
    pages.push({ number: pages.length + 1, title: "Loosely attached by path", memberIds: loose.slice(start, start + PAGE_MAX_MEMBERS), subRegionId: null });
  }
  return pages;
}

function memberLine(item: MapItem): string {
  const path = item.nodePaths[0] ?? "/";
  return `- [${KIND_LETTER[item.kind]}] ${short(item.title, 90)} (${path}) ${item.id}${item.oneLiner ? `: ${item.oneLiner}` : ""}`;
}

function issueLine(map: KnowledgeMap, finding: MapFinding): string | null {
  const title = (id: string): string => short(map.items[id]?.title ?? id, 60);
  switch (finding.kind) {
    case "consolidate":
      return `- consolidate ${finding.itemIds.length} memories (similarity up to ${finding.maxSimilarity}): ${finding.itemIds.map(title).join(" | ")}`;
    case "companion_unlinked":
      return `- companions that do not link each other (${finding.similarity}): [${KIND_LETTER[map.items[finding.itemIds[0]]!.kind]}] ${title(finding.itemIds[0])} <-> [${KIND_LETTER[map.items[finding.itemIds[1]]!.kind]}] ${title(finding.itemIds[1])}`;
    case "dangling_link":
      return `- dangling [[${short(finding.target, 60)}]] in ${title(finding.itemId)}`;
    case "scope_down_candidate":
      return `- candidate only: ${title(finding.itemId)} sits at / while ${percent(finding.share)} of its ties are in this region (home ${finding.homePath})`;
    case "junction":
      return `- junction: ${title(finding.itemId)} ties ${finding.regionIds.length} regions (${finding.regionIds.join(", ")})`;
    case "unused":
      return null;
  }
}

export interface RegionViewOptions {
  page?: number;
  purpose?: "audit" | "browse";
}

export function renderRegion(map: KnowledgeMap, region: KnowledgeRegion, options: RegionViewOptions = {}): string {
  const pages = regionPages(map, region);
  const page = pages[Math.min(Math.max(1, options.page ?? 1), Math.max(1, pages.length)) - 1];
  const members = page?.memberIds ?? [];
  const memberSet = new Set(members);
  const byId = new Map(map.regions.map((r) => [r.id, r]));
  const areas = new Map<string, number>();
  for (const id of region.memberIds) {
    const path = map.items[id]!.nodePaths[0] ?? "/";
    areas.set(path, (areas.get(path) ?? 0) + 1);
  }
  const head = [
    `Region ${region.id}: ${short(map.items[region.anchorId]!.title, 90)} (page ${page?.number ?? 1} of ${Math.max(1, pages.length)})`,
    `Terms: ${region.terms.join(", ") || "-"}. ${region.memberIds.length} items (M/R/S ${kindCounts(map, region.memberIds)}), ~${region.tokens} tokens of bodies, cohesion ${percent(region.cohesion)}, home ${region.homePath} (${percent(region.pathFit)}).`,
    `Paths: ${[...areas.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 5).map(([p, n]) => `${p} ${n}`).join(", ")}`,
    `Neighbour regions: ${region.neighbours.map((n) => `${n.regionId} (${short(map.items[byId.get(n.regionId)!.anchorId]!.title, 40)})`).join(", ") || "-"}`,
    "",
    `## ${page?.subRegionId ? `Sub-region ${page.subRegionId}: ` : ""}${short(page?.title ?? "", 80)} (${members.length} items). Read bodies with pathrule_read by id.`,
    ...members.map((id) => memberLine(map.items[id]!)),
  ];
  const boundary: string[] = [];
  const adjacency = new Map<string, Map<string, number>>();
  for (const edge of map.edges) {
    if (memberSet.has(edge.a)) adjacency.set(edge.a, (adjacency.get(edge.a) ?? new Map()).set(edge.b, edge.weight));
    if (memberSet.has(edge.b)) adjacency.set(edge.b, (adjacency.get(edge.b) ?? new Map()).set(edge.a, edge.weight));
  }
  const outside = members
    .map((id) => {
      const ties = new Map<string, number>();
      for (const [other] of adjacency.get(id) ?? []) {
        const r = map.items[other]?.regionId;
        if (r && r !== region.id) ties.set(r, (ties.get(r) ?? 0) + 1);
      }
      return { id, ties };
    })
    .filter((entry) => entry.ties.size > 0)
    .sort((x, y) => [...y.ties.values()].reduce((s, v) => s + v, 0) - [...x.ties.values()].reduce((s, v) => s + v, 0) || (x.id < y.id ? -1 : 1))
    .slice(0, 8);
  if (outside.length > 0) {
    boundary.push("", "## Boundary (ties outside this region; check these against their neighbours)");
    for (const entry of outside) {
      boundary.push(`- ${short(map.items[entry.id]!.title, 80)} -> ${[...entry.ties.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 3).map(([r, n]) => `${r} x${n}`).join(", ")}`);
    }
  }
  const issues = findingsFor(map.findings, memberSet).map((finding) => issueLine(map, finding)).filter((line): line is string => line !== null);
  const unused = members.filter((id) => map.items[id]!.sessions === 0).length;
  const tail = [
    ...(issues.length > 0 || unused > 0 ? ["", "## Issues", ...issues, ...(unused > 0 ? [`- ${unused} items here received no session in the usage window (rarely needed procedures are not necessarily dead)`] : [])] : []),
    ...(options.purpose === "audit" ? ["", AUDIT_CHECKLIST] : []),
    ...(page && page.number < pages.length ? ["", `Next: view=region region_id=${region.id} page=${page.number + 1}`] : []),
  ];
  return capLines([...head, ...boundary, ...tail], REGION_PAGE_MAX_CHARS, (left) => `(+${left} more lines; narrow with view=related)`);
}
