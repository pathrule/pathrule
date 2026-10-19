// SPDX-License-Identifier: Apache-2.0
/**
 * The observation loop with NO engine installed, through the files the hook really writes:
 * `remedy-deliveries.jsonl` (PreToolUse delivery) and `knowledge-observations.jsonl` (PostToolUse
 * capture). Before the open authority and the delivery drain, this produced no evidence at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "./local-backend.js";
import { stampProposedRemedy } from "@pathrule/agent-ir/atoms/remedy-fingerprint.js";
import type { ObservedEvent } from "@pathrule/protocol/outcome-types.js";
import { drainHookDeliveries } from "./delivery-ledger-drain.js";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "pr-engineless-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function make() {
  let n = 0;
  const b = new LocalBackend(":memory:", { genId: () => `id-${++n}`, now: () => "2026-10-15T00:00:00.000Z" });
  b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
  return b;
}

async function activeRemedy(b: LocalBackend, path: string, action: string[], condition: string[] = ["it broke"]) {
  const node = await b.ensureNodeForPath("ws", path, "folder");
  const mem = await b.writeMemory({ workspaceId: "ws", nodeId: node.id, title: "fix", content: `${condition.join(" ")}: ${action.join(" ")} fixed it` });
  const atom = await b.proposeRemedyAtom(
    "ws",
    stampProposedRemedy(
      {
        variant: "trouble", condition_evidence: condition, condition_normalized: null, action_evidence: action,
        evidence_state: "OBSERVED_SUCCESS", source: { kind: "memory", id: mem.id, title: "fix", node_path: null },
        observed_at: "2026-10-01T00:00:00.000Z",
      },
      { now: "2026-10-01T00:00:00.000Z" },
    ),
  );
  await b.decideRemedyAtom("ws", atom.id, "approve", "user-1");
  return atom;
}

function hookFiles(dir: string, deliveries: Array<{ sid: string; atom: string; path: string }>, events: Array<{ sid: string; event: ObservedEvent }>): string {
  writeFileSync(
    join(dir, "remedy-deliveries.jsonl"),
    deliveries.map((d) => JSON.stringify({ workspace_id: "ws", session_id: d.sid, atom_id: d.atom, path: d.path, event: "delivered", created_at: "2026-10-15T00:00:00.000Z" })).join("\n") + "\n",
  );
  const obs = join(dir, "knowledge-observations.jsonl");
  writeFileSync(obs, events.map((e) => JSON.stringify({ sid: e.sid, at: "2026-10-15T00:00:01.000Z", event: e.event })).join("\n") + "\n");
  return obs;
}

describe("observation without an engine", () => {
  it("a delivery the hook recorded and an insertion it captured become ATTRIBUTED evidence", async () => {
    const b = make();
    const atom = await activeRemedy(b, "/apps/web", ["safeFoo()"]);
    const dir = scratch();
    const obs = hookFiles(dir, [{ sid: "s1", atom: atom.id, path: "/apps/web/x.ts" }], [
      { sid: "s1", event: { kind: "edit", path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" } },
    ]);
    expect(await b.ingestObservationsFromDisk("ws", obs)).toEqual({ observed: 1, skipped: 0 });
    const agg = await b.aggregateAtomEvidence("ws", atom.id);
    expect(agg.delivered).toBe(1);
    expect(agg.attributed).toBe(1);
  });

  it("an event in a session the atom never reached is not evidence for it", async () => {
    const b = make();
    const atom = await activeRemedy(b, "/apps/web", ["safeFoo()"]);
    const obs = hookFiles(scratch(), [{ sid: "s1", atom: atom.id, path: "/apps/web/x.ts" }], [
      { sid: "s2", event: { kind: "edit", path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" } },
    ]);
    expect(await b.ingestObservationsFromDisk("ws", obs)).toEqual({ observed: 0, skipped: 1 });
    expect(await b.listKnowledgeEvidence("ws", atom.id)).toHaveLength(0);
  });

  it("a failing command that matches the condition, then the remedy command passing, is a recorded outcome", async () => {
    const b = make();
    const atom = await activeRemedy(b, "/", ["pnpm test:unit"], ["pnpm test:unit"]);
    const obs = hookFiles(scratch(), [{ sid: "s1", atom: atom.id, path: "/" }], [
      { sid: "s1", event: { kind: "command", command: "pnpm test:unit", exit_code: 0, output: "ok" } },
    ]);
    await b.ingestObservationsFromDisk("ws", obs);
    expect((await b.aggregateAtomEvidence("ws", atom.id)).outcome_success).toBe(1);
  });
});

describe("drainHookDeliveries", () => {
  it("moves each delivered line into the table once and leaves no file behind", async () => {
    const b = make();
    const dir = scratch();
    hookFiles(dir, [{ sid: "s1", atom: "a1", path: "/x" }, { sid: "s1", atom: "a2", path: "/x" }], []);
    expect(await drainHookDeliveries(b, "ws", dir)).toBe(2);
    expect(await drainHookDeliveries(b, "ws", dir)).toBe(0);
    expect((await b.listRemedyDeliveries("ws")).map((r) => r.atom_id)).toEqual(["a1", "a2"]);
    expect(readdirSync(dir).filter((f) => f.startsWith("remedy-deliveries"))).toEqual([]);
  });

  it("skips another workspace's lines, malformed lines and non-delivery events", async () => {
    const b = make();
    const dir = scratch();
    writeFileSync(
      join(dir, "remedy-deliveries.jsonl"),
      [
        JSON.stringify({ workspace_id: "other", session_id: "s1", atom_id: "x", event: "delivered" }),
        "{not json",
        JSON.stringify({ workspace_id: "ws", session_id: "s1", atom_id: "y", event: "used" }),
        JSON.stringify({ workspace_id: "ws", session_id: "s1", atom_id: "z", event: "delivered" }),
      ].join("\n"),
    );
    expect(await drainHookDeliveries(b, "ws", dir)).toBe(1);
    expect(existsSync(join(dir, "remedy-deliveries.jsonl"))).toBe(false);
  });
});
