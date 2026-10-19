// SPDX-License-Identifier: Apache-2.0
/**
 * Activity without the agent: the hook notes every file an agent edits or writes in
 * `<cache>/<workspace>/auto-activity.jsonl`, and this turns those notes into activity rows.
 *
 * Measured 2026-10-15 in a ten-turn Claude session: asking the agent to log every file change cost
 * nine extra model steps, each one re-reading the whole context (+49% session cost), for a record the
 * hook can observe for free. A derived row says what changed where (summary and files are
 * `derived` / `observed_tools` provenance); an agent may still log a richer summary when it helps.
 *
 * One row per session per drain, grouped by the deepest folder all files share. Claimed by an atomic
 * rename, so concurrent drains never count a note twice.
 */
import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { LogActivityInput } from "../inputs.js";

export const AUTO_ACTIVITY_LEDGER = "auto-activity.jsonl";
const MAX_FILES_LISTED = 10;

export interface ActivityWriter {
  logActivity(input: LogActivityInput): Promise<unknown>;
}

function commonFolder(paths: readonly string[]): string {
  const dirs = paths.map((p) => p.split("/").filter(Boolean).slice(0, -1));
  const first = dirs[0] ?? [];
  let n = first.length;
  for (const d of dirs) {
    let i = 0;
    while (i < n && i < d.length && d[i] === first[i]) i += 1;
    n = i;
  }
  return "/" + first.slice(0, n).join("/");
}

const TEST_PATH = /(^|\/)(test|tests|__tests__)\/|\.test\.|\.spec\./;

/**
 * Where the work happened: the folder the CODE files share. Tests and docs that came along with a change
 * do not pull the row up to the root (a change to `src/refunds` and its `test/refunds` is work in
 * `src/refunds`, not in `/`); they decide the folder only when nothing else changed.
 */
export function workFolder(paths: readonly string[]): string {
  const code = paths.filter((p) => !TEST_PATH.test(p) && !/\.(md|mdx|txt)$/.test(p));
  return commonFolder(code.length > 0 ? code : paths);
}

function domainOf(paths: readonly string[]): string {
  if (paths.every((p) => TEST_PATH.test(p))) return "test";
  if (paths.every((p) => /\.(md|mdx|txt)$/.test(p))) return "docs";
  return "backend";
}

export async function drainAutoActivity(store: ActivityWriter, workspaceId: string, cacheDir: string): Promise<number> {
  const file = join(cacheDir, AUTO_ACTIVITY_LEDGER);
  if (!existsSync(file)) return 0;
  const claimed = `${file}.${process.pid}.${Date.now()}.draining`;
  try {
    renameSync(file, claimed);
  } catch {
    return 0;
  }
  const bySession = new Map<string, { paths: Set<string>; wrote: boolean }>();
  try {
    for (const line of readFileSync(claimed, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let r: { sid?: unknown; tool?: unknown; path?: unknown };
      try {
        r = JSON.parse(line) as typeof r;
      } catch {
        continue;
      }
      if (typeof r.path !== "string" || !isAbsolute(r.path)) continue;
      const sid = typeof r.sid === "string" ? r.sid : "";
      const s = bySession.get(sid) ?? { paths: new Set<string>(), wrote: false };
      s.paths.add(r.path);
      if (r.tool === "write") s.wrote = true;
      bySession.set(sid, s);
    }
  } finally {
    try {
      unlinkSync(claimed);
    } catch {
      // a leftover claimed file is never read again
    }
  }
  let rows = 0;
  for (const [sid, s] of bySession) {
    const paths = [...s.paths].sort();
    const folder = workFolder(paths);
    const names = paths.map((p) => p.split("/").pop()).slice(0, MAX_FILES_LISTED);
    const byArea: Record<string, string[]> = {};
    for (const p of paths.slice(0, MAX_FILES_LISTED)) (byArea[p.split("/").slice(0, -1).join("/") || "/"] ??= []).push(p);
    await store.logActivity({
      workspaceId,
      nodePath: folder,
      domain: domainOf(paths),
      action: s.wrote ? "create" : "update",
      scope: "project",
      subjects: [...new Set(paths.map((p) => p.split("/").filter(Boolean).slice(-2, -1)[0]).filter((x): x is string => !!x))].slice(0, 5),
      taskSummary: `${s.wrote ? "Wrote" : "Edited"} ${paths.length} file${paths.length === 1 ? "" : "s"} under ${folder}: ${names.join(", ")}${paths.length > MAX_FILES_LISTED ? ", …" : ""}.`,
      filesTouched: { total: paths.length, by_area: byArea },
      ...(sid ? { sessionId: sid } : {}),
      provenance: { version: 1, summarySource: "derived", filesSource: "observed_tools", observedFileCount: paths.length, storedFileCount: Math.min(paths.length, MAX_FILES_LISTED), filesTruncated: paths.length > MAX_FILES_LISTED, outcome: "unknown" },
    });
    rows += 1;
  }
  return rows;
}
