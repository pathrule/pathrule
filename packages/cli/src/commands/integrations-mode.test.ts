// SPDX-License-Identifier: Apache-2.0
// One MCP entry for every project, and no machine-wide mode, with the Cloud capability installed
// beside Local. The real `pathrule integrations` runs in a scratch HOME (provider configs, registry and
// runtime manifest all under it) with recording `claude` and `codex` executables on PATH and a
// stand-in account edition: it holds no credentials, reaches no network, and counts every call, so a
// Local apply that asks the account anything fails here. What is checked is the provider
// configuration as written, not a label. An integration never changes a folder's edition or the
// device default.
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLI_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";
import { afterEach, describe, expect, it } from "vitest";

import type { CommandPlugin } from "../plugin.js";
import { runCli } from "../run.js";

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

const CLOUD_MARK = "https://cloud.stand-in.invalid";

function standInCloud() {
  const calls: string[] = [];
  const plugin: CommandPlugin = {
    name: "stand-in-cloud",
    contract: CLI_PLUGIN_CONTRACT,
    sharedPackages: [],
    account: {
      commands: {},
      mcpEntry: () => {
        calls.push("mcpEntry");
        return {
          type: "stdio",
          command: "/stand-in/node",
          args: ["/stand-in/cloud-cli.js", "mcp", "run"],
          env: { PATHRULE_CLOUD_ENDPOINT: CLOUD_MARK },
        };
      },
      afterInstall: async () => {},
      doctorChecks: async () => [],
      doctorNextStep: () => null,
      authorizeSupportBundle: async () => {},
      configUser: async () => {
        throw new Error("signed out");
      },
      signedInUser: async () => {
        calls.push("signedInUser");
        return null;
      },
    },
  };
  return { plugin, calls };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "pathrule-integrations-mode-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(bin, { recursive: true });
  for (const name of ["claude", "codex"]) {
    await writeFile(
      join(bin, name),
      `#!/bin/sh\necho "${name} $@" >> ${JSON.stringify(join(root, "calls.log"))}\necho '{"outcome":"ok"}'\n`,
    );
    await chmod(join(bin, name), 0o755);
  }
  await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus" }));
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATHRULE_HOME: join(home, ".pathrule"),
    PATH: `${bin}:/usr/bin:/bin`,
    NODE_ENV: "test",
  };
  return { home, env };
}

async function cli(env: NodeJS.ProcessEnv, argv: string[], plugins: CommandPlugin[]) {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const code = await runCli(argv, { cwd: env.HOME as string, env, stdout, stderr }, { plugins });
  const out = stdout.toString();
  return { code, json: out ? JSON.parse(out) : null, stderr: stderr.toString() };
}

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const claudeConfig = (home: string) => readFile(join(home, ".claude.json"), "utf8").catch(() => "");
const claudeEntry = async (home: string) =>
  JSON.parse((await claudeConfig(home)) || "{}").mcpServers?.pathrule;
const manifest = (home: string) => json(join(home, ".pathrule", "bin", "runtime.json"));
/** The entry every project uses: the runtime's own `mcp run`, naming no edition and no account. */
function expectEditionNeutral(entry: { args: string[]; env?: Record<string, string> }) {
  expect(entry.args.slice(-2)).toEqual(["mcp", "run"]);
  expect(entry.env ?? {}).not.toHaveProperty("PATHRULE_LOCAL");
  expect(JSON.stringify(entry)).not.toContain(CLOUD_MARK);
}
/** Neither a folder's edition nor the device default was written. */
function expectNoEditionChoice(home: string) {
  expect(existsSync(join(home, ".pathrule", "capabilities", "folders.json"))).toBe(false);
  expect(existsSync(join(home, ".pathrule", "capabilities", "selection.json"))).toBe(false);
}
const records = async (home: string) =>
  (await json(join(home, ".pathrule", "integrations", "registry.json"))).integrations as Array<{
    id: string;
    mode: string;
  }>;

describe("Local and Cloud isolation", () => {
  it("Local with Cloud installed writes the one MCP entry and runtime, and never asks the account", async () => {
    const s = await scratch();
    const cloud = standInCloud();
    const out = await cli(
      s.env,
      ["integrations", "add", "claude-code", "--local", "--channel", "settings", "--yes", "--json"],
      [cloud.plugin],
    );
    expect(out.code).toBe(0);
    expectEditionNeutral(await claudeEntry(s.home));
    expect(await claudeConfig(s.home)).not.toContain(CLOUD_MARK);
    const runtime = await manifest(s.home);
    expect(runtime).not.toHaveProperty("mode");
    expectEditionNeutral(runtime.mcp);
    // Accountless and offline: the account edition was not consulted at all.
    expect(cloud.calls).toEqual([]);
    expectNoEditionChoice(s.home);
  });

  it("Cloud and Local write the same entry, and a later Local setup keeps the account's data", async () => {
    const s = await scratch();
    const cloud = standInCloud();
    const toCloud = await cli(
      s.env,
      ["integrations", "add", "claude-code", "--cloud", "--channel", "settings", "--yes", "--json"],
      [cloud.plugin],
    );
    expect(toCloud.code).toBe(0);
    const cloudEntry = await claudeEntry(s.home);
    expectEditionNeutral(cloudEntry);
    expect(await manifest(s.home)).not.toHaveProperty("mode");
    // The entry is no longer the account's: nothing asked it for one.
    expect(cloud.calls).not.toContain("mcpEntry");

    // What the account left on this machine, which a switch to Local must not touch.
    const credentials = join(s.home, ".pathrule", "credentials.json");
    await writeFile(
      credentials,
      JSON.stringify({ "sb-stand-in-auth-token": { access_token: "kept" } }),
    );
    const mirror = join(s.home, ".pathrule", "22222222-3333-4444-8555-666666666666");
    await mkdir(mirror, { recursive: true });
    await writeFile(join(mirror, ".mirror"), "");
    const before = await readFile(credentials, "utf8");

    const toLocal = await cli(
      s.env,
      ["integrations", "add", "claude-code", "--local", "--channel", "settings", "--yes", "--json"],
      [cloud.plugin],
    );
    expect(toLocal.code).toBe(0);
    const config = await claudeConfig(s.home);
    expect(config).not.toContain(CLOUD_MARK);
    expect(await claudeEntry(s.home)).toEqual(cloudEntry);
    expect(await manifest(s.home)).not.toHaveProperty("mode");
    expectNoEditionChoice(s.home);
    expect((await records(s.home)).map((r) => [r.id, r.mode])).toEqual([
      ["claude-code:user", "local"],
    ]);
    expect(await readFile(credentials, "utf8")).toBe(before);
    expect(existsSync(join(mirror, ".mirror"))).toBe(true);
    // One Pathrule hook set, not one per mode.
    const settings = await readFile(join(s.home, ".claude", "settings.json"), "utf8");
    expect(settings.match(/"UserPromptSubmit"/g)?.length).toBe(1);

    const removed = await cli(
      s.env,
      ["integrations", "remove", "claude-code", "--yes", "--json"],
      [cloud.plugin],
    );
    expect(removed.code).toBe(0);
    expect(await claudeEntry(s.home)).toBeUndefined();
    expect(await readFile(credentials, "utf8")).toBe(before);
  });

  it("native plugins set up for different editions live side by side: no machine-wide mode to refuse or switch", async () => {
    const s = await scratch();
    const cloud = standInCloud();
    const local = await cli(
      s.env,
      ["integrations", "add", "claude-code", "--local", "--yes", "--json"],
      [cloud.plugin],
    );
    expect(local.code).toBe(0);

    // Codex prepared for Cloud leaves Claude Code's plugin as it is: both start the one MCP server,
    // which serves each project from its own edition.
    const codexCloud = await cli(
      s.env,
      ["integrations", "add", "codex", "--cloud", "--yes", "--json"],
      [cloud.plugin],
    );
    expect(codexCloud.code).toBe(0);
    const runtime = await manifest(s.home);
    expect(runtime).not.toHaveProperty("mode");
    expectEditionNeutral(runtime.mcp);
    expect((await records(s.home)).map((r) => [r.id, r.mode])).toEqual([
      ["claude-code:user", "local"],
      ["codex:user", "cloud"],
    ]);

    cloud.calls.length = 0;
    const bothLocal = await cli(
      s.env,
      ["integrations", "add", "claude-code", "codex", "--local", "--yes", "--json"],
      [cloud.plugin],
    );
    expect(bothLocal.code).toBe(0);
    expect(await manifest(s.home)).toEqual(expect.objectContaining({ mcp: runtime.mcp }));
    expect((await records(s.home)).map((r) => r.mode)).toEqual(["local", "local"]);
    expect(cloud.calls).toEqual([]);
    expectNoEditionChoice(s.home);
  });

  it("a Local setup leaves a Cloud project as it is: no Local workspace, no new choice", async () => {
    const s = await scratch();
    const cloud = standInCloud();
    const project = await realpath(await mkdtemp(join(s.home, "cloud-project-")));
    await mkdir(join(project, ".git"));
    const choices = join(s.home, ".pathrule", "capabilities", "folders.json");
    await mkdir(join(s.home, ".pathrule", "capabilities"), { recursive: true });
    const chosen = JSON.stringify({
      schema: 1,
      folders: [{ root: project, mode: "cloud", set_at: "2026-10-18T00:00:00.000Z", via: "setup" }],
    });
    await writeFile(choices, chosen);

    const out = await cli(
      s.env,
      [
        "integrations",
        "add",
        "claude-code",
        "--local",
        "--scope",
        "project",
        "--project",
        project,
        "--yes",
        "--json",
      ],
      [cloud.plugin],
    );
    expect(out.code).toBe(0);
    const plan = out.json.data.plans[0];
    expect(plan.operations.map((o: { kind: string }) => o.kind)).not.toContain("local-workspace");
    expect(plan.warnings.join("\n")).toContain("is a Pathrule Cloud folder");
    // No Local store was created for it, and its choice is the one it had.
    const stores = (await readdir(join(s.home, ".pathrule"))).filter((d) =>
      existsSync(join(s.home, ".pathrule", d, "pathrule.db")),
    );
    expect(stores).toEqual([]);
    expect(await readFile(choices, "utf8")).toBe(chosen);
  });
});
