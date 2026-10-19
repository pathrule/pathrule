// SPDX-License-Identifier: Apache-2.0
// The capability host: what the person chose, how a built-in capability's plugin is loaded and
// checked, what a run does when one cannot be loaded, and the setup flows that choose a mode. The
// plugin loader is injected; the clean-install smoke (scripts/smoke-npm-pack.mjs) loads the real one.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLI_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";
import { readFolderChoices, resolveFolderMode } from "@pathrule/core/workspace/folder-mode.js";
import { isSetAside, readDormantMark } from "@pathrule/core/workspace/local-store-markers.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCliArgs } from "../args.js";
import {
  installCliPlugins,
  type CliCommandContext,
  type CliSetupPlan,
  type CommandPlugin,
} from "../plugin.js";
import { CAPABILITIES, type Capability, type CapabilityId } from "./catalog.js";
import {
  CapabilityHost,
  capabilityDoctorCheck,
  capabilityWarnings,
  installCapabilityHost,
  prepareCapabilities,
} from "./host.js";
import { initLocalWorkspace } from "../local/init-local.js";
import { npmEnvironment } from "./npm.js";
import { folderSetupJson, renderFolderSetup, type OpenEditionCommand } from "./folder-setup.js";
import {
  chooseMode,
  hasCliSession,
  mapExistingInstall,
  readSelection,
  writeSelection,
} from "./selection.js";

const VERSION = "9.9.9";

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

let work: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-capabilities-")));
  env = { PATHRULE_HOME: join(work, "home") };
  installCliPlugins([]);
});

afterEach(() => {
  installCapabilityHost(null);
  installCliPlugins([]);
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A capability's plugin, as its built-in loader returns it. */
function fakePlugin(id: CapabilityId, extra: Partial<CommandPlugin> = {}): CommandPlugin {
  return { name: id, contract: CLI_PLUGIN_CONTRACT, sharedPackages: [], ...extra } as CommandPlugin;
}

/** A plugin loader that records each load, and fails when asked to. */
function fakeLoader(
  options: { fail?: string; plugin?: (id: CapabilityId) => CommandPlugin } = {},
): ((capability: Capability) => Promise<CommandPlugin>) & { calls: CapabilityId[] } {
  const calls: CapabilityId[] = [];
  const load = (async (capability: Capability) => {
    calls.push(capability.id);
    if (options.fail) throw new Error(options.fail);
    return (options.plugin ?? fakePlugin)(capability.id);
  }) as ((capability: Capability) => Promise<CommandPlugin>) & { calls: CapabilityId[] };
  load.calls = calls;
  return load;
}

function host(loader = fakeLoader()): CapabilityHost {
  return new CapabilityHost({ env, version: VERSION, loadPlugin: loader });
}

describe("the catalog", () => {
  it("names the one capability, Pathrule Cloud, built into this CLI", () => {
    expect(CAPABILITIES.map((c) => [c.id, c.title])).toEqual([["cloud", "Pathrule Cloud"]]);
    for (const c of CAPABILITIES) expect(typeof c.load).toBe("function");
  });

  it("loads the real Cloud plugin from the CLI itself, with no download", async () => {
    const plugin = await CAPABILITIES[0]!.load();
    expect(plugin.name).toBe("cloud");
    expect(plugin.contract).toBe(CLI_PLUGIN_CONTRACT);
  });
});

describe("the selection", () => {
  it("is none until the person chooses, and is stored atomically", () => {
    expect(readSelection(env)).toBeNull();
    writeSelection(env, { capabilities: ["cloud"], setup: "cloud", source: "flag" });
    expect(readSelection(env)).toMatchObject({ capabilities: ["cloud"], setup: "cloud" });
    const dir = join(env.PATHRULE_HOME!, "capabilities");
    expect(readdirSync(dir)).toEqual(["selection.json"]);
  });

  it("Cloud adds Cloud; Local is the open CLI alone and drops everything", () => {
    const cloud = chooseMode(null, "cloud", { source: "onboarding" });
    expect(cloud).toMatchObject({ capabilities: ["cloud"], setup: "cloud" });
    const stored = writeSelection(env, cloud);
    expect(chooseMode(stored, "local", { source: "flag" })).toMatchObject({
      capabilities: [],
      setup: "local",
    });
  });

  it("maps the CLI's own session to Cloud, and nothing else's", async () => {
    mkdirSync(env.PATHRULE_HOME!, { recursive: true });
    const credentials = join(env.PATHRULE_HOME!, "credentials.json");
    writeFileSync(credentials, JSON.stringify({ "sb-api-auth-token": "{}" }));
    expect(hasCliSession(env)).toBe(false);
    expect(await mapExistingInstall(env)).toBeNull();
    writeFileSync(credentials, JSON.stringify({ "sb-api-auth-token::cli": "{}" }));
    expect(await mapExistingInstall(env)).toMatchObject({
      capabilities: ["cloud"],
      setup: "cloud",
    });
  });
});

describe("the npm environment", () => {
  it("drops the npm settings that would move the install, and keeps the person's registry", () => {
    const out = npmEnvironment({
      npm_config_global: "true",
      npm_config_prefix: "/usr/local",
      NPM_CONFIG_LEGACY_PEER_DEPS: "false",
      npm_config_registry: "https://registry.example",
      PATH: "/bin",
    });
    expect(out.npm_config_global).toBeUndefined();
    expect(out.npm_config_prefix).toBeUndefined();
    expect(out.NPM_CONFIG_LEGACY_PEER_DEPS).toBeUndefined();
    expect(out.npm_config_registry).toBe("https://registry.example");
    expect(out.PATH).toBe("/bin");
  });
});

describe("preparing a run", () => {
  const stderr = () => new MemoryWriter();

  it("is the open CLI until the person chooses: nothing loaded", async () => {
    const loader = fakeLoader();
    const out = await prepareCapabilities({
      argv: ["sync"],
      env,
      stderr: stderr(),
      host: host(loader),
    });
    expect(out).toMatchObject({ ok: true, plugins: [] });
    expect(loader.calls).toEqual([]);
    expect(capabilityDoctorCheck()).toMatchObject({ status: "pass", detail: /no mode chosen/ });
  });

  it("loads a chosen capability's built-in plugin, quietly", async () => {
    writeSelection(env, { capabilities: ["cloud"], setup: "cloud", source: "flag" });
    const err = stderr();
    const out = await prepareCapabilities({ argv: ["sync"], env, stderr: err, host: host() });
    expect(out.ok && out.plugins.map((p) => p.name)).toEqual(["cloud"]);
    expect(err.toString()).toBe("");
    expect(capabilityDoctorCheck()).toMatchObject({
      status: "pass",
      detail: /Pathrule Cloud 9\.9\.9, built into this CLI/,
    });
  });

  it("loads nothing for `--version`", async () => {
    writeSelection(env, { capabilities: ["cloud"], setup: "cloud", source: "flag" });
    const loader = fakeLoader();
    await prepareCapabilities({ argv: ["--version"], env, stderr: stderr(), host: host(loader) });
    expect(loader.calls).toEqual([]);
  });

  it("refuses to run a Cloud install without Cloud, except the commands that repair it", async () => {
    writeSelection(env, { capabilities: ["cloud"], setup: "cloud", source: "flag" });
    const failing = () => host(fakeLoader({ fail: "the built-in plugin did not load" }));
    const refused = await prepareCapabilities({
      argv: ["sync"],
      env,
      stderr: stderr(),
      host: failing(),
      cwd: work,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toMatch(/This folder uses Pathrule Cloud, and Pathrule does not run the local store in its place/);
      expect(refused.message).toMatch(/pathrule setup --local/);
    }
    for (const command of ["setup", "doctor", "status", "config", "help"]) {
      const out = await prepareCapabilities({
        argv: [command],
        env,
        stderr: stderr(),
        host: failing(),
        cwd: work,
      });
      expect(out.ok).toBe(true);
    }
    expect(capabilityDoctorCheck()).toMatchObject({ status: "fail" });
    expect(capabilityWarnings()[0]).toMatchObject({ code: "capability_unavailable" });
  });

  it("reports Cloud's failure as a refusal, never as a degraded run", async () => {
    writeSelection(env, { capabilities: ["cloud"], setup: "cloud", source: "flag" });
    const current = host(fakeLoader({ fail: "broken" }));
    await prepareCapabilities({ argv: ["sync"], env, stderr: stderr(), host: current });
    expect(current.problems.map((p) => [p.id, p.effect])).toEqual([["cloud", "refuse"]]);
  });

  it("refuses a plugin that does not fit the plugins already accepted", async () => {
    const current = host(
      fakeLoader({ plugin: (id) => fakePlugin(id, { contract: -1 } as Partial<CommandPlugin>) }),
    );
    const out = await current.obtain(["cloud"]);
    expect(out.ready).toEqual([]);
    expect(out.failed.map((p) => p.id)).toEqual(["cloud"]);
  });

  it("loads a capability once per process", async () => {
    const loader = fakeLoader();
    const current = host(loader);
    expect((await current.obtain(["cloud"])).ready).toEqual([
      { id: "cloud", version: VERSION, action: "loaded" },
    ]);
    expect((await current.obtain(["cloud"])).ready).toEqual([]);
    expect(loader.calls).toEqual(["cloud"]);
  });

  it("loads nothing on the way into setup, which prepares the chosen mode itself", async () => {
    writeSelection(env, { capabilities: ["cloud"], setup: "cloud", source: "flag" });
    const loader = fakeLoader();
    const out = await prepareCapabilities({
      argv: ["setup", "--local"],
      env,
      stderr: stderr(),
      host: host(loader),
    });
    expect(out.ok).toBe(true);
    expect(capabilityWarnings()).toEqual([]);
  });

  it("maps a signed-in CLI from before onboarding to Cloud, and stores it", async () => {
    mkdirSync(env.PATHRULE_HOME!, { recursive: true });
    writeFileSync(
      join(env.PATHRULE_HOME!, "credentials.json"),
      JSON.stringify({ "sb-api-auth-token::cli": "{}" }),
    );
    const out = await prepareCapabilities({ argv: ["sync"], env, stderr: stderr(), host: host() });
    expect(out.ok && out.plugins.map((p) => p.name)).toEqual(["cloud"]);
    expect(readSelection(env)).toMatchObject({ setup: "cloud", source: "existing-install" });
  });
});

describe("preparing a run, by folder", () => {
  const stderr = () => new MemoryWriter();
  const cloudEnv = () => ({ ...env, PATHRULE_NATIVE_CLOUD_URL: "https://cloud.example", PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-test" });

  it("loads Pathrule Cloud for a new install when the build names one, and nothing when the machine uses none", async () => {
    const loader = fakeLoader();
    const out = await prepareCapabilities({ argv: ["sync"], env: cloudEnv(), stderr: stderr(), host: host(loader), cwd: work });
    expect(out.ok && out.plugins.map((p) => p.name)).toEqual(["cloud"]);
    installCapabilityHost(null);
    writeSelection(env, chooseMode(null, "local", { source: "flag" }));
    const none = fakeLoader();
    await prepareCapabilities({ argv: ["sync"], env: cloudEnv(), stderr: stderr(), host: host(none), cwd: work });
    expect(none.calls).toEqual([]);
  });

  it("runs a Local folder's command when Cloud cannot load, and says Cloud folders stop", async () => {
    writeSelection(env, { capabilities: ["cloud"], setup: "cloud", source: "flag" });
    mkdirSync(join(work, "repo"));
    await initLocalWorkspace({ cwd: join(work, "repo"), env, genWorkspaceId: () => "local_repo" });
    const err = stderr();
    const out = await prepareCapabilities({ argv: ["sync"], env, stderr: err, host: host(fakeLoader({ fail: "broken" })), cwd: join(work, "repo") });
    expect(out.ok).toBe(true);
    expect(err.toString()).toMatch(/Pathrule Local folders work; a Pathrule Cloud folder stops/);
    const mcp = await prepareCapabilities({ argv: ["mcp", "run"], env, stderr: stderr(), host: host(fakeLoader({ fail: "broken" })), cwd: work });
    expect(mcp.ok).toBe(true);
  });
});

describe("setup and init: one edition per folder", () => {
  const cloudEnv = () => {
    env = { ...env, PATHRULE_NATIVE_CLOUD_URL: "https://cloud.example", PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-test" };
    return env;
  };

  function context(command: "setup" | "init", argv: string[], answers: string[] | null = [], cwd = work) {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const parsed = parseCliArgs([command, ...argv], {});
    const interactive = answers !== null && !parsed.flags.json;
    const ctx: CliCommandContext = {
      command,
      args: parsed.positional.slice(1),
      flags: parsed.flags,
      runtime: {
        cwd,
        env,
        stdout,
        stderr,
        ...(interactive
          ? {
              promptLine: async (prompt: string) => {
                stdout.write(prompt);
                return answers!.shift() ?? "";
              },
            }
          : {}),
      },
      mode: { json: parsed.flags.json, color: false, interactive },
    };
    return { ctx, stdout, stderr };
  }

  /** The open command and the account's, recording what ran and the plan the account was given. */
  function editions(options: { accountExit?: number } = {}) {
    const ran: string[] = [];
    const plans: Array<CliSetupPlan | undefined> = [];
    const open: OpenEditionCommand = {
      render: async (runtime) => {
        ran.push(`local:${runtime.cwd}`);
        return 0;
      },
      json: async (runtime) => {
        ran.push(`local:${runtime.cwd}`);
        return { exitCode: 0, envelope: { schema_version: 1, ok: true, command: "setup", cwd: runtime.cwd, data: { local: true } } };
      },
    };
    const accountCommand = (name: "setup" | "init") => ({
      name,
      run: async (ctx: CliCommandContext) => {
        ran.push(`cloud:${ctx.runtime.cwd}`);
        plans.push(ctx.setupPlan);
        return options.accountExit ?? 0;
      },
      json: async (ctx: CliCommandContext) => {
        ran.push(`cloud:${ctx.runtime.cwd}`);
        plans.push(ctx.setupPlan);
        const exitCode = options.accountExit ?? 0;
        return { exitCode, envelope: { schema_version: 1, ok: exitCode === 0, command: name, cwd: ctx.runtime.cwd, data: { account: true } } };
      },
    });
    const hooks = {
      prepareCloud: async () => {
        installCliPlugins([fakePlugin("cloud", { account: { commands: { setup: accountCommand("setup"), init: accountCommand("init") } } } as unknown as Partial<CommandPlugin>)]);
        return true;
      },
      open,
    };
    return { hooks, ran, plans };
  }

  function attachCloud(root: string, workspaceId: string) {
    const dir = join(env.PATHRULE_HOME!, "config", "users", "u1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "native-workspaces.json"),
      JSON.stringify({ schema_version: 1, workspaces: [{ workspace_id: workspaceId, organization_id: "org_1", name: "acme", root, attached_at: "2026-10-19T00:00:00.000Z" }] }),
    );
  }

  const folderMode = () => resolveFolderMode(work, env, { cloudAvailable: true }).mode;

  it("sets a new folder up on Pathrule Cloud with no question, and records its edition", async () => {
    cloudEnv();
    const { hooks, ran } = editions();
    const { ctx, stdout } = context("setup", []);
    expect(await renderFolderSetup(ctx, hooks)).toBe(0);
    expect(ran).toEqual([`cloud:${work}`]);
    expect(stdout.toString()).not.toMatch(/Choose/);
    expect(readFolderChoices(env)).toEqual([expect.objectContaining({ root: work, mode: "cloud", via: "setup" })]);
  });

  it("asks the two scopes when --local differs, and this project only is the default", async () => {
    cloudEnv();
    const { hooks, ran } = editions();
    const { ctx, stdout } = context("setup", ["--local"], [""]);
    expect(await renderFolderSetup(ctx, hooks)).toBe(0);
    const text = stdout.toString();
    expect(text).toMatch(/1\. This project only \(recommended\)[\s\S]*2\. The device default/);
    expect(text).not.toMatch(/3\./);
    expect(ran).toEqual([`local:${work}`]);
    expect(readFolderChoices(env)).toEqual([expect.objectContaining({ root: work, mode: "local" })]);
    expect(readSelection(env)).toBeNull();
  });

  it("the device default changes new folders only: a folder with its own edition keeps it", async () => {
    cloudEnv();
    // A sibling project, outside this one: nothing of its own, so it follows the device default.
    const other = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-other-project-")));
    const { hooks } = editions();
    expect(await renderFolderSetup(context("setup", []).ctx, hooks)).toBe(0);
    const { ctx, stdout } = context("setup", ["--local", "--scope", "device"]);
    const { hooks: second, ran } = editions();
    expect(await renderFolderSetup(ctx, second)).toBe(0);
    expect(ran).toEqual([]);
    expect(stdout.toString()).toMatch(/keeps Pathrule Cloud \(its own edition\)/);
    expect(readSelection(env)).toMatchObject({ setup: "local" });
    expect(folderMode()).toBe("cloud");
    expect(resolveFolderMode(other, env, { cloudAvailable: true }).mode).toBe("local");
    rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("an unconfigured folder follows a device default chosen from it", async () => {
    cloudEnv();
    const { hooks, ran } = editions();
    const { ctx } = context("setup", ["--local"], ["2"]);
    expect(await renderFolderSetup(ctx, hooks)).toBe(0);
    expect(ran).toEqual([`local:${work}`]);
    expect(readSelection(env)).toMatchObject({ setup: "local" });
    expect(readFolderChoices(env)).toEqual([expect.objectContaining({ mode: "local" })]);
  });

  it("never asks in a script: changing a project set up in the other edition with no scope stops, and nothing changes", async () => {
    cloudEnv();
    attachCloud(work, "ws_cloud");
    const { hooks, ran } = editions();
    const out = await folderSetupJson(context("setup", ["--local", "--json"]).ctx, hooks);
    expect(out.exitCode).toBe(64);
    expect(out.envelope.error).toMatchObject({ code: "setup_scope_required" });
    expect(out.envelope.error?.message).toMatch(/--scope project[\s\S]*--scope device/);
    expect(ran).toEqual([]);
    expect(readFolderChoices(env)).toEqual([]);
    const ok = await folderSetupJson(context("setup", ["--local", "--scope", "project", "--json"]).ctx, hooks);
    expect(ok.exitCode).toBe(0);
    expect(ok.envelope.data).toMatchObject({ mode: "local", edition: { scope: "project", switched: true } });
  });

  it("a script setting up a folder not set up yet gets this project only, says so, and leaves the device default", async () => {
    cloudEnv();
    const { hooks, ran } = editions();
    const out = await folderSetupJson(context("setup", ["--local", "--json"]).ctx, hooks);
    expect(out.exitCode).toBe(0);
    expect(ran).toEqual([`local:${work}`]);
    expect(out.envelope.data).toMatchObject({ mode: "local", edition: { scope: "project", from: null } });
    expect(JSON.stringify(out.envelope.data)).toContain("for this project only; the device default stays Pathrule Cloud");
    expect(readFolderChoices(env)).toEqual([expect.objectContaining({ root: work, mode: "local" })]);
    expect(readSelection(env)).toBeNull();
  });

  it("asking for the folder's own edition again asks nothing and changes nothing", async () => {
    cloudEnv();
    const { hooks, ran } = editions();
    await renderFolderSetup(context("setup", []).ctx, hooks);
    const { ctx, stdout } = context("setup", ["--cloud"], []);
    expect(await renderFolderSetup(ctx, hooks)).toBe(0);
    expect(stdout.toString()).not.toMatch(/Choose/);
    expect(ran).toEqual([`cloud:${work}`, `cloud:${work}`]);
  });

  it("refuses two modes, and --transfer with --local", async () => {
    const { hooks } = editions();
    expect((await folderSetupJson(context("setup", ["--cloud", "--local", "--json"]).ctx, hooks)).envelope.error?.code).toBe("conflicting_setup_mode");
    expect((await folderSetupJson(context("setup", ["--local", "--transfer", "--json"]).ctx, hooks)).envelope.error?.code).toBe("transfer_needs_cloud");
  });

  it("Local to Cloud: the Local store stays as it is, unused; the account setup gets the plan; nothing is copied by the scope", async () => {
    cloudEnv();
    await initLocalWorkspace({ cwd: work, env, genWorkspaceId: () => "local_work" });
    mkdirSync(join(env.PATHRULE_HOME!, "cache", "local_work"), { recursive: true });
    writeFileSync(join(env.PATHRULE_HOME!, "cache", "local_work", "hook-index.json"), "{}");
    expect(folderMode()).toBe("local");
    const { hooks, ran, plans } = editions();
    expect(await renderFolderSetup(context("setup", ["--cloud", "--scope", "project"]).ctx, hooks)).toBe(0);
    expect(ran).toEqual([`cloud:${work}`]);
    expect(plans[0]).toEqual({ from: "local", scope: "project", transfer: null, target: null });
    expect(readDormantMark(env, "local_work")).toMatchObject({ since: expect.any(String) });
    expect(existsSync(join(env.PATHRULE_HOME!, "cache", "local_work", "hook-index.json"))).toBe(false);
    expect(existsSync(join(env.PATHRULE_HOME!, "local_work", "pathrule.db"))).toBe(true);
    expect(folderMode()).toBe("cloud");
  });

  it("a Cloud setup that does not finish leaves the folder on its earlier edition", async () => {
    cloudEnv();
    await initLocalWorkspace({ cwd: work, env, genWorkspaceId: () => "local_work" });
    const { hooks } = editions({ accountExit: 1 });
    const { ctx, stdout } = context("setup", ["--cloud", "--scope", "project"]);
    expect(await renderFolderSetup(ctx, hooks)).toBe(1);
    expect(stdout.toString()).toMatch(/stays on Pathrule Local/);
    expect(folderMode()).toBe("local");
    expect(readFolderChoices(env)).toEqual([]);
    expect(readDormantMark(env, "local_work")).toBeNull();
  });

  it("Cloud to Local and back: the Local store this release left dormant serves the folder again, and Cloud's cache goes", async () => {
    cloudEnv();
    await initLocalWorkspace({ cwd: work, env, genWorkspaceId: () => "local_work" });
    await renderFolderSetup(context("setup", ["--cloud", "--scope", "project"]).ctx, editions().hooks);
    attachCloud(work, "ws_cloud");
    const cache = join(env.PATHRULE_HOME!, "cache", "ws_cloud");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "hook-index.json"), "{}");
    writeFileSync(join(cache, "user-words.jsonl"), "{}\n");
    const { hooks, ran } = editions();
    const { ctx, stdout } = context("setup", ["--local", "--scope", "project"]);
    expect(await renderFolderSetup(ctx, hooks)).toBe(0);
    const text = stdout.toString();
    expect(text).toMatch(/stays on Pathrule Cloud\. Nothing from it is copied/);
    expect(text).toMatch(/earlier Local workspace serves it again/);
    expect(ran).toEqual([`local:${work}`]);
    expect(isSetAside(env, "local_work")).toBe(false);
    expect(readDormantMark(env, "local_work")).toBeNull();
    expect(existsSync(join(cache, "hook-index.json"))).toBe(false);
    expect(existsSync(join(cache, "user-words.jsonl"))).toBe(false);
    expect(resolveFolderMode(work, env, { cloudAvailable: true })).toMatchObject({ mode: "local", local: { workspaceId: "local_work" }, dormant: { cloud: { workspaceId: "ws_cloud" } } });
  });

  it("a folder in conflict asks which edition serves it, and a Local store of uncertain origin is set aside", async () => {
    cloudEnv();
    await initLocalWorkspace({ cwd: work, env, genWorkspaceId: () => "local_legacy" });
    attachCloud(work, "ws_cloud");
    expect(resolveFolderMode(work, env, { cloudAvailable: true }).conflict).not.toBeNull();
    const { hooks } = editions();
    const script = await folderSetupJson(context("setup", ["--json"]).ctx, hooks);
    expect(script.exitCode).toBe(64);
    expect(script.envelope.error?.code).toBe("folder_edition_conflict");
    const { ctx, stdout } = context("setup", [], ["2"]);
    expect(await renderFolderSetup(ctx, editions().hooks)).toBe(0);
    expect(stdout.toString()).toMatch(/Which one serves this folder\?/);
    expect(stdout.toString()).toMatch(/set aside, not used and not deleted/);
    expect(isSetAside(env, "local_legacy")).toBe(true);
    expect(existsSync(join(env.PATHRULE_HOME!, "local_legacy", "pathrule.db"))).toBe(true);
    expect(folderMode()).toBe("local");
  });

  it("init never resets a configured folder and follows the same scope rules", async () => {
    cloudEnv();
    await initLocalWorkspace({ cwd: work, env, genWorkspaceId: () => "local_work" });
    const { hooks, ran } = editions();
    expect(await renderFolderSetup(context("init", []).ctx, hooks)).toBe(0);
    expect(ran).toEqual([`local:${work}`]);
    const refused = await folderSetupJson(context("init", ["--cloud", "--json"]).ctx, hooks);
    // The folder has its own Local workspace: changing it in a script needs a scope.
    expect(refused.envelope.error?.code).toBe("setup_scope_required");
    expect(folderMode()).toBe("local");
  });

  it("works from a subfolder on the project the folder belongs to", async () => {
    cloudEnv();
    await initLocalWorkspace({ cwd: work, env, genWorkspaceId: () => "local_work" });
    mkdirSync(join(work, "src", "deep"), { recursive: true });
    const { hooks, ran } = editions();
    expect(await renderFolderSetup(context("setup", ["--cloud", "--scope", "project"], [], join(work, "src", "deep")).ctx, hooks)).toBe(0);
    expect(ran).toEqual([`cloud:${work}`]);
    expect(readFolderChoices(env)).toEqual([expect.objectContaining({ root: work, mode: "cloud" })]);
  });
});
