// SPDX-License-Identifier: Apache-2.0
// Regression: a folder served from a local store recorded deliveries that nobody reported, and the
// Cloud console showed none while the doctor said nothing about it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deliveryReportCheck, indexedWorkspaceFor } from "./delivery-doctor.js";
import type { NativeWorkspaceEntry } from "./workspaces.js";

const WS = "ws-local-1";
let home: string;
let root: string;
let env: NodeJS.ProcessEnv;

function index(workspaceId: string, workspaceRoot: string, generatedAt?: string) {
  const dir = join(home, "cache", workspaceId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "hook-index.json"),
    JSON.stringify({
      schema_version: 2,
      workspace_id: workspaceId,
      workspace_root: workspaceRoot,
      ...(generatedAt ? { generated_at: generatedAt } : {}),
    }),
  );
}

function ledger(workspaceId: string, session: string, items: Array<[kind: string, id: string]>) {
  const dir = join(home, "cache", workspaceId, "deliveries");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${session}.jsonl`),
    items
      .map(([kind, id]) =>
        JSON.stringify({
          v: 1,
          type: "receipt",
          at: new Date().toISOString(),
          workspace_id: workspaceId,
          session_id: session,
          epoch: 0,
          channel: "hook",
          provenance: { source: "hook-index" },
          status: "confirmed",
          item: { kind, id, hash: "h", scope: "project" },
        }),
      )
      .join("\n"),
  );
}

function reported(workspaceId: string, sessions: Record<string, string[]>, pending = false) {
  const dir = join(home, "cache", workspaceId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "deliveries-reported.json"),
    JSON.stringify({
      v: 1,
      sessions,
      pending: pending ? { report: "r".repeat(32), deliveries: [], keys: {} } : null,
    }),
  );
}

const attached = (workspaceId: string, workspaceRoot: string): NativeWorkspaceEntry => ({
  workspace_id: workspaceId,
  organization_id: "org-1",
  name: "Repo",
  root: workspaceRoot,
  attached_at: new Date().toISOString(),
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pr-delivery-doctor-"));
  root = join(home, "repo");
  mkdirSync(root);
  env = { PATHRULE_HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("indexedWorkspaceFor", () => {
  it("names the workspace whose hook index roots the folder, the nearest root first", async () => {
    index(WS, root);
    index("ws-parent", home);
    index("ws-other", join(home, "elsewhere"));
    expect(await indexedWorkspaceFor(root, env)).toBe(WS);
    expect(await indexedWorkspaceFor(join(root, "packages", "x"), env)).toBe(WS);
    expect(await indexedWorkspaceFor(join(home, "y"), env)).toBe("ws-parent");
    expect(await indexedWorkspaceFor("/nowhere/at/all", env)).toBeNull();
  });

  it("resolves two indexes at the same root to the newer one, as the hook does", async () => {
    // A folder re-attached under another workspace leaves the old index behind; the hook serves
    // the newer one, so its ledgers are the ones that count.
    index("ws-old", root, "2026-10-10T23:49:59.779Z");
    index("ws-new", root, "2026-10-16T11:56:50.585Z");
    expect(await indexedWorkspaceFor(root, env)).toBe("ws-new");
  });

  it("ignores an index whose directory does not carry its workspace id", async () => {
    const dir = join(home, "cache", "stale-dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "hook-index.json"),
      JSON.stringify({ workspace_id: "ws-moved", workspace_root: root }),
    );
    expect(await indexedWorkspaceFor(root, env)).toBeNull();
  });
});

describe("deliveries_report doctor check", () => {
  it("warns when a folder nobody attached recorded deliveries: the Cloud never hears of them", async () => {
    index(WS, root);
    ledger(WS, "s1", [
      ["memory", "m1"],
      ["memory", "m1"],
      ["rule", "r1"],
      ["protocol", "pathrule-protocol"],
    ]);
    ledger(WS, "s2", [["memory", "m1"]]);
    const check = await deliveryReportCheck({ env, cwd: root, attached: null });
    expect(check).toEqual({
      name: "deliveries_report",
      status: "warn",
      detail: expect.stringContaining(
        "3 recorded here in 30 days, none reported to Pathrule Cloud",
      ),
    });
    expect(check.detail).toContain("not attached");
    expect(check.detail).toContain("pathrule sync");
  });

  it("passes quietly when nothing was recorded, attached or not", async () => {
    index(WS, root);
    expect(await deliveryReportCheck({ env, cwd: root, attached: null })).toMatchObject({
      status: "pass",
      detail: "none recorded here in 30 days",
    });
    expect(
      await deliveryReportCheck({ env, cwd: root, attached: attached(WS, root) }),
    ).toMatchObject({ status: "pass", detail: "none recorded here in 30 days" });
    expect(await deliveryReportCheck({ env, cwd: "/nowhere", attached: null })).toMatchObject({
      status: "pass",
      detail: "no knowledge index serves this folder yet",
    });
  });

  it("warns for an attached folder whose deliveries are not reported yet, and says when they will be", async () => {
    index(WS, root);
    ledger(WS, "s1", [["memory", "m1"]]);
    expect(
      await deliveryReportCheck({ env, cwd: root, attached: attached(WS, root) }),
    ).toMatchObject({
      status: "warn",
      detail:
        "1 recorded here in 30 days, none reported to Pathrule Cloud yet (a report goes after the next MCP tool call)",
    });
    reported(WS, {}, true);
    expect(
      (await deliveryReportCheck({ env, cwd: root, attached: attached(WS, root) })).detail,
    ).toContain("waiting for the Cloud's answer");
  });

  it("passes for an attached folder once the Cloud holds its reports", async () => {
    index(WS, root);
    ledger(WS, "s1", [
      ["memory", "m1"],
      ["rule", "r1"],
    ]);
    ledger(WS, "s2", [["memory", "m1"]]);
    reported(WS, { s1: ["memory:m1", "rule:r1"], s2: ["memory:m1"] });
    expect(await deliveryReportCheck({ env, cwd: root, attached: attached(WS, root) })).toEqual({
      name: "deliveries_report",
      status: "pass",
      detail: "3 recorded here in 30 days, 3 reported to Pathrule Cloud",
    });
  });

  it("counts deliveries older than the window out", async () => {
    index(WS, root);
    ledger(WS, "s1", [["memory", "m1"]]);
    const later = Date.now() + 31 * 86_400_000;
    expect(await deliveryReportCheck({ env, cwd: root, attached: null, now: later })).toMatchObject(
      {
        status: "pass",
        detail: "none recorded here in 30 days",
      },
    );
  });
});
