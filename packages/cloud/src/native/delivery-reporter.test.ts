// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nextReport, REPORT_MAX_ENTRIES, reportWorkspaceDeliveries } from "./delivery-reporter.js";

const WS = "ws-cloud-1";
let home: string;
let env: NodeJS.ProcessEnv;

function ledger(session: string, lines: Array<Record<string, unknown>>) {
  const dir = join(home, "cache", WS, "deliveries");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${session}.jsonl`),
    lines
      .map((fields) =>
        JSON.stringify({
          v: 1,
          type: "receipt",
          at: new Date().toISOString(),
          workspace_id: WS,
          session_id: session,
          epoch: 0,
          channel: "hook",
          provenance: { source: "hook-index" },
          status: "confirmed",
          ...fields,
        }),
      )
      .join("\n"),
  );
}
const item = (kind: string, id: string) => ({ item: { kind, id, hash: "h", scope: "project" } });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pr-deliveries-"));
  env = { PATHRULE_HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe("delivery reporter", () => {
  it("sends each session's items once, as daily counts with nothing that names a session or path", async () => {
    ledger("s1", [
      item("memory", "m1"),
      item("memory", "m1"),
      item("rule", "r1"),
      item("protocol", "p"),
    ]);
    ledger("s2", [item("memory", "m1")]);
    const sent: unknown[] = [];
    const request = async <T>(path: string, body?: unknown) => {
      sent.push({ path, body });
      return { applied: true } as T;
    };
    expect(await reportWorkspaceDeliveries(WS, request, env)).toBe(3);
    const today = new Date().toISOString().slice(0, 10);
    expect(sent).toEqual([
      {
        path: `/v1/workspaces/${WS}/deliveries`,
        body: {
          report: expect.stringMatching(/^[a-f0-9]{32}$/),
          deliveries: expect.arrayContaining([
            { day: today, kind: "memory", id: "m1", count: 2 },
            { day: today, kind: "rule", id: "r1", count: 1 },
          ]),
        },
      },
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/s1|s2|scope|hook/);
    // Nothing new: nothing sent.
    expect(await reportWorkspaceDeliveries(WS, request, env)).toBe(0);
    expect(sent).toHaveLength(1);
    // A new delivery in an existing session goes out next time, alone.
    ledger("s2", [item("memory", "m1"), item("skill", "k1")]);
    expect(await reportWorkspaceDeliveries(WS, request, env)).toBe(1);
    expect((sent[1] as { body: { deliveries: unknown[] } }).body.deliveries).toEqual([
      { day: today, kind: "skill", id: "k1", count: 1 },
    ]);
  });

  it("resends a report whose answer was lost with the same id, and waits while another process reports", async () => {
    ledger("s1", [item("memory", "m1")]);
    const reports: string[] = [];
    let fail = true;
    const request = async <T>(_path: string, body?: unknown) => {
      reports.push((body as { report: string }).report);
      if (fail) throw new Error("offline");
      return { applied: true } as T;
    };
    expect(await reportWorkspaceDeliveries(WS, request, env)).toBeNull();
    const state = JSON.parse(
      readFileSync(join(home, "cache", WS, "deliveries-reported.json"), "utf8"),
    );
    expect(state.pending.report).toBe(reports[0]);
    fail = false;
    expect(await reportWorkspaceDeliveries(WS, request, env)).toBe(1);
    expect(reports).toEqual([reports[0], reports[0]]);

    writeFileSync(join(home, "cache", WS, "deliveries-reported.lock"), "");
    ledger("s1", [item("memory", "m1"), item("rule", "r2")]);
    expect(await reportWorkspaceDeliveries(WS, request, env)).toBeNull();
    expect(reports).toHaveLength(2);
  });

  it("caps a report at the entries the Cloud accepts and leaves the rest for the next one", () => {
    const deliveries = Array.from({ length: REPORT_MAX_ENTRIES + 5 }, (_, index) => ({
      kind: "memory" as const,
      id: `m${index}`,
      at: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
    }));
    const report = nextReport([{ session: "s1", deliveries }], {});
    expect(report?.deliveries).toHaveLength(REPORT_MAX_ENTRIES);
    expect(report?.keys.s1).toHaveLength(REPORT_MAX_ENTRIES);
    expect(
      nextReport([{ session: "s1", deliveries }], { s1: report!.keys.s1! })?.deliveries,
    ).toHaveLength(5);
  });
});
