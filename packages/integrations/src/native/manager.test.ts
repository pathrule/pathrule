// SPDX-License-Identifier: Apache-2.0
// The integration engine against a temporary home and a recording provider CLI: plan, apply,
// idempotency, legacy hook migration with backups, rollback after a failure, and removal of exactly
// what was recorded. The provider CLI is a recorder here; the real `claude` and `codex` runs are in
// the native verification script.

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyIntegration, diagnoseIntegrations, planIntegration, removeIntegration, type IntegrationHost, type IntegrationRequest } from "./manager.js";
import { readIntegrationRegistry } from "./registry-io.js";
import { readRuntimeManifest, writeRuntimeManifest } from "./runtime-manifest-io.js";
import { readFile as readText } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "assets");
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

const LEGACY_SETTINGS = {
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/my-own-guard" }] },
      { matcher: "Read|Edit", hooks: [{ type: "command", command: "/Users/x/.pathrule/bin/pathrule-hook.js" }] },
    ],
    SessionStart: [{ hooks: [{ type: "command", command: "/Users/x/.pathrule/bin/pathrule-hook.js" }] }],
  },
};

async function fixture(
  opts: {
    failPluginInstall?: boolean;
    noBinary?: boolean;
    writeManifest?: boolean;
    /** The edition each folder resolves to (core's resolveFolderMode); Local when not named. */
    editions?: Record<string, "local" | "cloud" | null>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pathrule-manager-"));
  homes.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(project, ".claude"), { recursive: true });
  const calls: string[][] = [];
  const mcpEntries: string[] = [];
  const env = { PATHRULE_HOME: join(home, ".pathrule") } as NodeJS.ProcessEnv;
  const launcher = await readText(join(ASSETS, "pathrule-launch.cjs"), "utf8");
  const setup = await readText(join(ASSETS, "pathrule-setup.cjs"), "utf8");
  let runtimeWrites = 0;
  const host: IntegrationHost = {
    env,
    home,
    now: () => new Date("2026-10-10T10:00:00.000Z"),
    runtimeVersion: "0.7.0",
    bundleInput: () => ({
      pluginVersion: "0.7.0",
      minRuntime: "0.7.0",
      runtime: { package: "@pathrule/cli", version: "0.7.0", integrity: null },
      assets: { launcher, setup, license: "Apache License 2.0\n", notice: "NOTICE\n" },
      remoteMcpUrl: "https://cloud.pathrule.io/mcp",
    }),
    providerBinary: async () => (opts.noBinary ? null : "/usr/bin/claude"),
    runProvider: async (provider, args) => {
      calls.push([provider, ...args]);
      if (opts.failPluginInstall && (args[1] === "install" || args[1] === "add") && args[0] === "plugin" && args[2] !== "add") {
        return { status: 1, stdout: "", stderr: "marketplace refused the plugin" };
      }
      return { status: 0, stdout: "{}", stderr: "" };
    },
    ensureRuntime: async ({ mode }) => {
      runtimeWrites += 1;
      const manifestPath = join(home, ".pathrule", "bin", "runtime.json");
      if (opts.writeManifest) {
        await mkdir(dirname(manifestPath), { recursive: true });
        await writeFile(manifestPath, JSON.stringify({ prepared: mode, writes: runtimeWrites }));
      }
      return { manifestPath, hookPath: join(home, ".pathrule", "bin", "pathrule-hook.js") };
    },
    folderEdition: async (root) => {
      const mode = opts.editions && root in opts.editions ? opts.editions[root]! : "local";
      return { mode, conflict: mode === null ? `${root} has both a Pathrule Local workspace and a Pathrule Cloud workspace.` : null };
    },
    ensureLocalWorkspace: async () => ({ workspaceId: "ws-1", created: false }),
    cloudStatus: async () => ({ ready: true, signedIn: false, detail: "", loginCommand: "pathrule login" }),
    writeSettingsHooks: async () => ({ changed: true }),
    installMcpEntry: async (provider) => {
      mcpEntries.push(provider);
      return { path: join(home, ".claude.json"), server: "pathrule" };
    },
    removeMcpEntry: async () => {},
  };
  const request = (over: Partial<IntegrationRequest> = {}): IntegrationRequest => ({
    provider: "claude-code",
    scope: "user",
    projectRoot: project,
    mode: "local",
    channel: "native-plugin",
    maintenance: true,
    mcp: true,
    pluginSource: "install",
    pluginVersion: "0.7.0",
    ...over,
  });
  return { root, home, project, host, calls, mcpEntries, request, runtimeWrites: () => runtimeWrites };
}

describe("the integration engine", () => {
  it("plans every change before applying it", async () => {
    const f = await fixture();
    await writeFile(join(f.home, ".claude", "settings.json"), JSON.stringify(LEGACY_SETTINGS));
    const plan = await planIntegration(f.request(), f.host);
    expect(plan.blocked).toBeNull();
    expect(plan.operations.map((o) => o.kind)).toEqual([
      "runtime",
      "materialize-marketplace",
      "provider-marketplace",
      "provider-plugin",
      "registry",
      "local-workspace",
      "remove-legacy-hooks",
    ]);
    expect(plan.operations.find((o) => o.kind === "provider-plugin")?.commands[0]).toBe(
      "claude plugin install pathrule@pathrule --scope user --json",
    );
    expect(f.calls).toEqual([]);
  });

  it("applies, keeps the person's own settings, backs up what it edits, and is idempotent", async () => {
    const f = await fixture();
    const settings = join(f.home, ".claude", "settings.json");
    await writeFile(settings, JSON.stringify(LEGACY_SETTINGS));
    const first = await applyIntegration(await planIntegration(f.request(), f.host), f.host);
    expect(first.ok).toBe(true);
    const after = JSON.parse(await readFile(settings, "utf8"));
    expect(after.permissions).toEqual(LEGACY_SETTINGS.permissions);
    expect(JSON.stringify(after)).toContain("my-own-guard");
    expect(JSON.stringify(after)).not.toContain("pathrule-hook.js");
    const backups = await readdir(join(f.home, ".pathrule", "integrations", "backups"));
    expect(backups.length).toBe(1);
    const marketplace = join(f.home, ".pathrule", "integrations", "marketplace");
    expect(JSON.parse(await readFile(join(marketplace, ".claude-plugin", "marketplace.json"), "utf8")).plugins[0].name).toBe("pathrule");

    const second = await applyIntegration(await planIntegration(f.request(), f.host), f.host);
    expect(second.ok).toBe(true);
    const registry = await readIntegrationRegistry(f.host.env);
    expect(registry.integrations).toHaveLength(1);
    expect(registry.integrations[0]).toMatchObject({ id: "claude-code:user", channel: "native-plugin", mode: "local", status: "installed" });
    expect(registry.integrations[0]!.installed_at).toBe("2026-10-10T10:00:00.000Z");
  });

  it("rolls every earlier step back when a step fails", async () => {
    const f = await fixture({ failPluginInstall: true });
    const settings = join(f.home, ".claude", "settings.json");
    await writeFile(settings, JSON.stringify(LEGACY_SETTINGS));
    const result = await applyIntegration(await planIntegration(f.request(), f.host), f.host);
    expect(result.ok).toBe(false);
    expect(result.error?.operation).toBe("provider-plugin");
    expect(result.rolledBack).toBe(true);
    expect(f.calls.map((c) => c.slice(1, 4).join(" "))).toContain("plugin marketplace remove");
    // The legacy entries were never touched: removal comes after the plugin is in place.
    expect(await readFile(settings, "utf8")).toContain("pathrule-hook.js");
    expect((await readIntegrationRegistry(f.host.env)).integrations).toEqual([]);
  });

  it("names the manual steps when the provider CLI is not on PATH", async () => {
    const f = await fixture({ noBinary: true });
    const plan = await planIntegration(f.request(), f.host);
    expect(plan.blocked?.code).toBe("provider_cli_missing");
    expect(plan.blocked?.manual?.join("\n")).toContain("/plugin install pathrule@pathrule");
    const result = await applyIntegration(plan, f.host);
    expect(result.ok).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("a project install leaves the user-level legacy entry for the other projects", async () => {
    const f = await fixture();
    await writeFile(join(f.home, ".claude", "settings.json"), JSON.stringify(LEGACY_SETTINGS));
    await writeFile(join(f.project, ".claude", "settings.local.json"), JSON.stringify(LEGACY_SETTINGS));
    const result = await applyIntegration(await planIntegration(f.request({ scope: "project" }), f.host), f.host);
    expect(result.ok).toBe(true);
    expect(await readFile(join(f.home, ".claude", "settings.json"), "utf8")).toContain("pathrule-hook.js");
    expect(await readFile(join(f.project, ".claude", "settings.local.json"), "utf8")).not.toContain("pathrule-hook.js");
    expect(f.calls.find((c) => c[2] === "install")).toContain("local");
  });

  it("gives Codex a trusted hooks layer beside its plugin, and keeps those entries", async () => {
    const f = await fixture();
    const codexHome = join(f.home, ".codex");
    await mkdir(codexHome, { recursive: true });
    const plan = await planIntegration(f.request({ provider: "codex", pluginSource: "attach" }), f.host);
    const hooksOp = plan.operations.find((o) => o.kind === "settings-hooks");
    expect(hooksOp?.paths).toEqual([join(codexHome, "hooks.json")]);
    expect(hooksOp?.summary).toContain("/hooks");
    const written: string[] = [];
    const host = { ...f.host, writeSettingsHooks: async (_p: string, path: string) => (written.push(path), { changed: true }) };
    const result = await applyIntegration(plan, host as typeof f.host);
    expect(result.ok).toBe(true);
    expect(written).toEqual([join(codexHome, "hooks.json")]);
    const record = (await readIntegrationRegistry(f.host.env)).integrations[0]!;
    expect(record.resources).toEqual([{ kind: "hook-entries", path: join(codexHome, "hooks.json") }]);
  });

  it("a settings-hook integration writes the one MCP entry, whatever it prepares", async () => {
    const f = await fixture();
    const local = await applyIntegration(await planIntegration(f.request({ channel: "settings-hook", mode: "local" }), f.host), f.host);
    expect(local.ok).toBe(true);
    const cloud = await applyIntegration(await planIntegration(f.request({ channel: "settings-hook", mode: "cloud" }), f.host), f.host);
    expect(cloud.ok).toBe(true);
    expect(f.mcpEntries).toEqual(["claude-code", "claude-code"]);
  });

  it("records an attach without installing anything through the provider", async () => {
    const f = await fixture();
    const result = await applyIntegration(await planIntegration(f.request({ pluginSource: "attach" }), f.host), f.host);
    expect(result.ok).toBe(true);
    expect(f.calls).toEqual([]);
    expect((await readIntegrationRegistry(f.host.env)).integrations[0]?.resources).toEqual([]);
  });

  it("removes exactly what it recorded, and keeps a resource another integration still uses", async () => {
    const f = await fixture();
    await applyIntegration(await planIntegration(f.request(), f.host), f.host);
    await applyIntegration(await planIntegration(f.request({ provider: "codex" }), f.host), f.host);
    f.calls.length = 0;
    const removed = await removeIntegration({ provider: "claude-code", scope: "user", projectRoot: null }, f.host);
    expect(removed.ok).toBe(true);
    expect(removed.removed.join("\n")).toContain("Claude Code plugin pathrule@pathrule");
    // Codex still uses the materialized marketplace directory.
    expect(removed.kept.join("\n")).toContain("owned-path");
    // The plugin goes before the marketplace that lists it.
    expect(f.calls.map((c) => c.join(" "))).toEqual([
      "claude-code plugin uninstall pathrule@pathrule --scope user --json",
      "claude-code plugin marketplace remove pathrule",
    ]);
    const left = await readIntegrationRegistry(f.host.env);
    expect(left.integrations.map((r) => r.id)).toEqual(["codex:user"]);
  });

  it("diagnoses a legacy hook left beside the plugin", async () => {
    const f = await fixture();
    await applyIntegration(await planIntegration(f.request({ pluginSource: "attach" }), f.host), f.host);
    await writeFile(join(f.home, ".claude", "settings.json"), JSON.stringify(LEGACY_SETTINGS));
    const report = await diagnoseIntegrations(f.host, f.project);
    expect(report.findings.some((x) => x.level === "warn" && x.message.includes("beside the Claude Code plugin"))).toBe(true);
  });
});

describe("every project keeps its own edition", () => {
  const records = async (env: NodeJS.ProcessEnv) =>
    (await readIntegrationRegistry(env)).integrations.map((r) => [r.id, r.mode]);

  it("sets up two projects with different editions, and refuses neither", async () => {
    const opts: NonNullable<Parameters<typeof fixture>[0]> = {};
    const f = await fixture(opts);
    const cloudProject = join(f.root, "cloud-project");
    opts.editions = { [f.project]: "local", [cloudProject]: "cloud" };
    const local = await planIntegration(f.request({ scope: "project" }), f.host);
    expect(local.blocked).toBeNull();
    expect((await applyIntegration(local, f.host)).ok).toBe(true);
    const cloud = await planIntegration(
      f.request({ provider: "codex", scope: "project", projectRoot: cloudProject, mode: "cloud" }),
      f.host,
    );
    expect(cloud.blocked).toBeNull();
    expect(cloud.operations.map((o) => o.kind)).toContain("cloud-check");
    expect((await applyIntegration(cloud, f.host)).ok).toBe(true);
    // A user-level agent set up for the other edition switches nothing either.
    const user = await planIntegration(f.request({ provider: "codex", mode: "cloud" }), f.host);
    expect(user.blocked).toBeNull();
    expect((await applyIntegration(user, f.host)).ok).toBe(true);
    expect(await records(f.host.env)).toEqual([
      [`claude-code:project:${f.project}`, "local"],
      [`codex:project:${cloudProject}`, "cloud"],
      ["codex:user", "cloud"],
    ]);
  });

  it("prepares a Local workspace only for a Local folder, and leaves a Cloud or conflicted folder as it is", async () => {
    const opts: NonNullable<Parameters<typeof fixture>[0]> = {};
    const f = await fixture(opts);
    expect((await planIntegration(f.request(), f.host)).operations.map((o) => o.kind)).toContain("local-workspace");

    opts.editions = { [f.project]: "cloud" };
    const onCloud = await planIntegration(f.request(), f.host);
    expect(onCloud.blocked).toBeNull();
    expect(onCloud.operations.map((o) => o.kind)).not.toContain("local-workspace");
    expect(onCloud.warnings.join("\n")).toContain("is a Pathrule Cloud folder");

    opts.editions = { [f.project]: null };
    const inConflict = await planIntegration(f.request(), f.host);
    expect(inConflict.operations.map((o) => o.kind)).not.toContain("local-workspace");
    expect(inConflict.warnings.join("\n")).toContain("has both a Pathrule Local workspace and a Pathrule Cloud workspace");
  });

  it("a failed apply puts the previous runtime manifest back", async () => {
    const opts = { writeManifest: true, failPluginInstall: false };
    const f = await fixture(opts);
    expect((await applyIntegration(await planIntegration(f.request(), f.host), f.host)).ok).toBe(true);
    const manifestPath = join(f.home, ".pathrule", "bin", "runtime.json");
    const before = await readFile(manifestPath, "utf8");
    opts.failPluginInstall = true;
    const failed = await applyIntegration(await planIntegration(f.request({ provider: "codex", mode: "cloud" }), f.host), f.host);
    expect(failed.ok).toBe(false);
    expect(failed.rolledBack).toBe(true);
    expect(await readFile(manifestPath, "utf8")).toBe(before);
    expect(await records(f.host.env)).toEqual([["claude-code:user", "local"]]);
  });

  it("still reads a manifest an older runtime wrote with one mode, and drops that mode when it writes", async () => {
    const f = await fixture();
    expect((await applyIntegration(await planIntegration(f.request(), f.host), f.host)).ok).toBe(true);
    const manifestPath = join(f.home, ".pathrule", "bin", "runtime.json");
    await mkdir(dirname(manifestPath), { recursive: true });
    const older = {
      schema_version: 1,
      launcher_contract: 1,
      runtime_version: "0.6.9",
      hook_extension_contract: 1,
      hook_index_schemas: [1, 2],
      hook: join(f.home, ".pathrule", "bin", "pathrule-hook.js"),
      cli: { node: "/usr/bin/node", entry: "/runtime/cli.js" },
      mcp: { command: "/usr/bin/node", args: ["/runtime/cli.js", "mcp", "run"], env: { PATHRULE_LOCAL: "1", PATHRULE_HOME: "/h" } },
      mode: "cloud",
      maintenance: { consent: true, recorded_at: "2026-10-01T00:00:00.000Z" },
      written_at: "2026-10-01T00:00:00.000Z",
    };
    await writeFile(manifestPath, JSON.stringify(older));
    expect(await readRuntimeManifest(f.host.env)).toMatchObject({ runtime_version: "0.6.9", mode: "cloud", mcp: older.mcp });
    // The doctor no longer compares a recorded edition with a machine-wide one.
    const { findings } = await diagnoseIntegrations(f.host, f.project);
    expect(findings.filter((x) => x.level === "error")).toEqual([]);

    const rewritten = await writeRuntimeManifest(
      {
        runtimeVersion: "0.7.0",
        hookExtensionContract: 1,
        hookIndexSchemas: [1, 2],
        hookPath: older.hook,
        cli: older.cli,
      },
      f.host.env,
    );
    expect(rewritten).not.toHaveProperty("mode");
    expect(rewritten.mcp).toEqual({ command: "/usr/bin/node", args: ["/runtime/cli.js", "mcp", "run"], env: { PATHRULE_HOME: "/h" } });
    expect(rewritten.maintenance).toEqual(older.maintenance);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).not.toHaveProperty("mode");
  });
});
