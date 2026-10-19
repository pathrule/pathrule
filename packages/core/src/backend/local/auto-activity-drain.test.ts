// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "./local-backend.js";
import { AUTO_ACTIVITY_LEDGER, drainAutoActivity, workFolder } from "./auto-activity-drain.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pr-auto-activity-"));
  dirs.push(dir);
  let n = 0;
  const b = new LocalBackend(":memory:", { genId: () => `id-${++n}`, now: () => "2026-10-15T00:00:00.000Z" });
  b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
  return { b, dir };
}
type Row = { node_path: string; action: string; domain: string; task_summary: string };
const activity = (b: LocalBackend): Row[] =>
  (b as unknown as { db: { prepare(s: string): { all(): Row[] } } }).db.prepare("SELECT node_path, action, domain, task_summary FROM activity_logs ORDER BY created_at, rowid").all();
const note = (sid: string, tool: string, path: string) => JSON.stringify({ sid, at: "2026-10-15T00:00:00.000Z", tool, path });

describe("workFolder", () => {
  it("is where the code changed, not where its tests and docs live", () => {
    expect(workFolder(["/src/refunds/receipt.js", "/test/refunds/receipt.test.js", "/docs/refunds.md"])).toBe("/src/refunds");
    expect(workFolder(["/src/refunds/a.js", "/src/reports/b.js", "/test/a.test.js"])).toBe("/src");
    expect(workFolder(["/test/a.test.js", "/test/b.test.js"])).toBe("/test");
    expect(workFolder(["/packages/core/src/x.ts", "/packages/core/src/x.test.ts"])).toBe("/packages/core/src");
  });
});

describe("activity derived from the hook's file-change notes", () => {
  it("writes one derived row per session, at the folder the files share, and consumes the notes", async () => {
    const { b, dir } = setup();
    writeFileSync(join(dir, AUTO_ACTIVITY_LEDGER), [
      note("s1", "write", "/src/refunds/receipt.js"), note("s1", "edit", "/src/refunds/parse.js"), note("s1", "edit", "/src/refunds/parse.js"),
      note("s2", "edit", "/test/refunds.test.js"), "{broken",
    ].join("\n"));
    expect(await drainAutoActivity(b, "ws", dir)).toBe(2);
    expect(existsSync(join(dir, AUTO_ACTIVITY_LEDGER))).toBe(false);
    expect(await drainAutoActivity(b, "ws", dir)).toBe(0);
    const rows = activity(b);
    const s1 = rows.find((r) => r.task_summary.includes("receipt.js"))!;
    expect(s1.node_path).toBe("/src/refunds");
    expect(s1.action).toBe("create");
    expect(s1.task_summary).toBe("Wrote 2 files under /src/refunds: parse.js, receipt.js.");
    const s2 = rows.find((r) => r.task_summary.includes("refunds.test.js"))!;
    expect(s2.domain).toBe("test");
  });

  it("is drained by the observation pass, so no agent call is needed", async () => {
    const { b, dir } = setup();
    writeFileSync(join(dir, AUTO_ACTIVITY_LEDGER), note("s1", "edit", "/src/api/parse.js"));
    await b.ingestObservationsFromDisk("ws", join(dir, "knowledge-observations.jsonl"));
    expect(activity(b).map((r) => r.task_summary)).toEqual(["Edited 1 file under /src/api: parse.js."]);
  });
});
