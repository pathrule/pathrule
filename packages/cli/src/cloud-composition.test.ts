// SPDX-License-Identifier: Apache-2.0
// The CLI with Pathrule Cloud composed: what `pathrule setup --cloud` loads, and what the VS Code
// extension's copy (./editor-bin.ts) always runs.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CAPABILITIES } from "./capabilities/catalog.js";
import { loadCliPlugins } from "./plugin.js";
import { runCli as runOpenCli, type CliRuntime } from "./run.js";
import { putUserKnowledge } from "@pathrule/core/user-knowledge/user-knowledge-store.js";
import type { UserKnowledgeAtom } from "@pathrule/core/user-knowledge/user-knowledge.js";
import { describe, expect, it } from "vitest";

const cloudPlugins = () => loadCliPlugins(CAPABILITIES.map((capability) => capability.load));

const runCli = async (argv: string[], runtime: CliRuntime) =>
  runOpenCli(argv, runtime, { plugins: await cloudPlugins() });

class MemoryWriter {
  chunks: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
  toString() {
    return this.chunks.join("");
  }
}

/**
 * A home that has already seen the daily update notice, as the product leaves it, so tests about
 * command output do not depend on first-run state or reach the network.
 */
async function seedQuietHome(root: string): Promise<void> {
  await writeFile(join(root, ".cli-update-check"), new Date().toISOString(), "utf8");
}

describe("the CLI with Pathrule Cloud", () => {
  it("lists workspace and attach commands in json help", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const code = await runCli(["help", "--json"], {
      cwd: "/repo",
      env: {},
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.toString()).data.commands).toEqual(
      expect.arrayContaining([
        "workspace",
        "attach",
        "preflight",
        "install",
        "uninstall",
        "sync",
        "config",
        "update",
        "invite",
      ]),
    );
  });

  it("prints surface-specific help topics", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const code = await runCli(["help", "surfaces"], {
      cwd: "/repo",
      env: { PATHRULE_UPDATE_POLICY: "manual" },
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(stdout.toString()).toContain("Pathrule Web");
    expect(stdout.toString()).toContain("Pathrule for VS Code");
    expect(stdout.toString()).not.toContain("Pathrule Studio");
    expect(stdout.toString()).toContain("Pathrule CLI");
    expect(stdout.toString()).toContain(
      "Local runtime state is scoped to this user and this machine.",
    );
  });

  it("returns a stable json envelope for help topics", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const code = await runCli(["help", "web", "--json"], {
      cwd: "/repo",
      env: {},
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(JSON.parse(stdout.toString())).toMatchObject({
      ok: true,
      command: "help",
      data: {
        topic: "web",
        topics: ["surfaces", "web", "cli"],
        text: expect.stringContaining("pathrule open agent-setup"),
      },
    });
  });

  it("me forget takes the belief out of every workspace's hook index, not only the next one to sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-cli-me-"));
    try {
      await seedQuietHome(root);
      const env = { PATHRULE_HOME: root, PATHRULE_DAEMON_AUTOSTART: "0" };
      const now = new Date().toISOString();
      const quote = "Keep explanations short unless I ask for detail.";
      // A belief as the open store keeps it: what a teaching leaves behind.
      const belief: UserKnowledgeAtom = {
        id: "11111111-2222-4333-8444-555555555555",
        kind: "user_knowledge",
        primitive: "context",
        scope: "user",
        claim: "Prefers concise explanations by default.",
        claim_evidence: ["Keep explanations short"],
        trigger_evidence: [],
        source_type: "EXPLICIT",
        evidence: [
          {
            kind: "teaching",
            quote,
            observed_at: now,
            surface: "cli",
            workspace_id: null,
            thread_id: null,
            message_id: "m1",
            taught: true,
          },
        ],
        confidence: "high",
        status: "active",
        applies_to_workspace_id: null,
        applies_everywhere: true,
        applies_to_path: null,
        created_at: now,
        updated_at: now,
        last_observed_at: now,
        superseded_by: null,
        fingerprint: "context:prefers-concise-explanations",
      };
      await putUserKnowledge("local", belief, { now, env });
      const entry = {
        id: belief.id,
        line: "- Prefers concise explanations by default.",
        terms: [],
        always: true,
      };
      for (const ws of ["ws-one", "ws-two"]) {
        await mkdir(join(root, "cache", ws), { recursive: true });
        await writeFile(
          join(root, "cache", ws, "hook-index.json"),
          JSON.stringify({
            workspace_id: ws,
            workspace_root: `/repos/${ws}`,
            user_preferences: [entry],
          }),
          "utf8",
        );
      }

      const code = await runCli(["me", "forget", belief.id.slice(0, 8), "--json"], {
        cwd: "/repo",
        env,
        stdout: new MemoryWriter(),
        stderr: new MemoryWriter(),
      });

      expect(code).toBe(0);
      for (const ws of ["ws-one", "ws-two"]) {
        const index = JSON.parse(
          await readFile(join(root, "cache", ws, "hook-index.json"), "utf8"),
        );
        expect(index.user_preferences).toBeUndefined();
        expect(index.workspace_root).toBe(`/repos/${ws}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints help for the bare pathrule command", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-cli-home-"));
    try {
      await seedQuietHome(root);
      const stdout = new MemoryWriter();
      const stderr = new MemoryWriter();
      const code = await runCli(["--no-color"], {
        cwd: "/repo",
        env: { PATHRULE_HOME: root, PATHRULE_DAEMON_AUTOSTART: "0" },
        stdout,
        stderr,
      });

      expect(code).toBe(0);
      expect(stderr.toString()).toBe("");
      expect(stdout.toString()).toContain("Usage:\n  pathrule <command> [options]");
      expect(stdout.toString()).toContain("Quick Start:");
      // The legacy daemon left the client on 2026-10-17.
      expect(stdout.toString()).not.toContain("daemon        Start");
      expect(stdout.toString()).not.toMatch(/bridge|pathrule start/i);
      expect(stdout.toString()).toContain('pathrule memory read "Exact title" --print');
      expect(stdout.toString()).toContain("Use rule or skill in place of memory.");
      expect(stdout.toString()).toContain("Add --local for a local workspace");
      expect(stdout.toString()).not.toContain("Local Web bridge is running");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists every command and topic of the CLI with Pathrule Cloud, in the order it always has", async () => {
    const stdout = new MemoryWriter();
    const code = await runCli(["help", "--json"], {
      cwd: "/repo",
      env: {},
      stdout,
      stderr: new MemoryWriter(),
    });
    expect(code).toBe(0);
    const data = JSON.parse(stdout.toString()).data;
    expect(data.commands).toEqual([
      "help",
      "version",
      "login",
      "status",
      "doctor",
      "whoami",
      "logout",
      "org",
      "workspace",
      "init",
      "setup",
      "attach",
      "detach",
      "preflight",
      "install",
      "integrations",
      "uninstall",
      "eject",
      "sync",
      "config",
      "update",
      "telemetry",
      "host",
      "ui",
      "open",
      "activity",
      "search",
      "memory",
      "rule",
      "skill",
      "instrument",
      "index",
      "learning",
      "billing",
      "team",
      "invite",
      "upgrade",
      "reactivate",
      "home",
    ]);
    expect(data.topics).toEqual(["surfaces", "web", "cli"]);
    expect(data.text).not.toContain("intelligence");
    expect(data.text).toContain(
      "me            Inspect and correct what Pathrule knows about how you work",
    );
  });

  it("serves `mcp run` with the account edition, and nothing else", async () => {
    const plugins = await cloudPlugins();
    const mcp = (await Promise.all(plugins.map((p) => p.mcpPlugins?.() ?? []))).flat();
    expect(mcp.map((p) => p.name)).toEqual(["cloud"]);
    expect(plugins.map((p) => p.name)).toEqual(["cloud"]);
    expect(plugins.filter((p) => p.account).map((p) => p.name)).toEqual(["cloud"]);
  });
});
