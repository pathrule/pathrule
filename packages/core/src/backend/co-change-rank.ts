// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic co-change derivation. Coupling is derived on-read from the
 * `activity_logs` feed: the set of directory paths an agent touched together in
 * a single activity forms a co-change clique. Two paths that recur together
 * across activities are coupled; the weight is the co-occurrence count.
 *
 * Shared by the SQLite-backed and in-memory backends. No `better-sqlite3`
 * import here, so it loads cleanly anywhere.
 */

/** Max coupled paths returned. */
export const MAX_COUPLED_NODES = 15;

/** The directory path of a file, workspace-relative with a leading slash ("/" for root). */
export function fileDirPath(file: string): string {
  const parts = file.split("/").filter(Boolean);
  parts.pop(); // drop the filename
  return parts.length > 0 ? "/" + parts.join("/") : "/";
}

/**
 * The set of workspace-relative directory paths an activity touched: the node_path plus
 * the parent directory of every file in `files_touched.by_area`. Deduped.
 */
export function activityTouchedPaths(
  byArea: Record<string, string[]> | null | undefined,
  nodePath: string | null | undefined,
): string[] {
  const set = new Set<string>();
  if (nodePath) set.add(nodePath);
  if (byArea) {
    for (const files of Object.values(byArea)) {
      if (!Array.isArray(files)) continue;
      for (const f of files) {
        if (typeof f === "string" && f.length > 0) set.add(fileDirPath(f));
      }
    }
  }
  return [...set];
}

/** A coupled path with its co-occurrence weight (descending). */
export interface CoupledPath {
  path: string;
  weight: number;
}

/**
 * Rank paths that co-occur with the seed paths across activities. An activity contributes
 * when it touched something at or under a seed; every other path it touched gains weight.
 */
export function rankCoupledPaths(
  activitiesTouched: string[][],
  seedPaths: string[],
  limit: number = MAX_COUPLED_NODES,
): CoupledPath[] {
  if (seedPaths.length === 0) return [];
  const seedSet = new Set(seedPaths);
  const isSeed = (p: string): boolean =>
    seedSet.has(p) || seedPaths.some((s) => p === s || p.startsWith(`${s}/`));

  const weights = new Map<string, number>();
  for (const touched of activitiesTouched) {
    if (!touched.some(isSeed)) continue;
    for (const p of touched) {
      if (isSeed(p)) continue;
      weights.set(p, (weights.get(p) ?? 0) + 1);
    }
  }

  return [...weights.entries()]
    .map(([path, weight]) => ({ path, weight }))
    .sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path))
    .slice(0, limit > 0 ? limit : MAX_COUPLED_NODES);
}
