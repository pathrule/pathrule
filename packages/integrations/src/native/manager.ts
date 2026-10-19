// SPDX-License-Identifier: Apache-2.0
// The one integration engine. `pathrule integrations` (the CLI and its npx entry) and a plugin's own
// setup (through `pathrule integrations attach`) plan, apply, remove, repair and diagnose through
// here, and record what they own in the integration registry, so every path shares one state.
//
// An apply runs its operations in order and keeps an undo for each. When one fails, the ones before
// it are undone in reverse; only when an undo itself fails is the record kept as `partial`, for
// `repair` to finish. Files the person owns are backed up before Pathrule edits them, and only
// Pathrule's own entries in them are touched.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { atomicWrite } from "@pathrule/core/storage/atomic-write.js";
import { pathruleHome } from "@pathrule/core/storage/paths.js";
import {
  integrationRecordId,
  type IntegrationProviderId,
  type IntegrationRecord,
  type IntegrationResource,
  type IntegrationScope,
} from "@pathrule/protocol/integration-registry.js";

import { writeBundle } from "./bundle-writer.js";
import { integrationsDir, runtimeManifestPath } from "./home.js";
import { codexHome, findLegacyHooks, withoutPathruleHooks, type LegacyHookFile } from "./legacy-hooks.js";
import type {
  IntegrationHost,
  IntegrationPlan,
  IntegrationRequest,
  OperationKind,
  PlannedOperation,
  ProviderCommandResult,
} from "./manager-contract.js";
import { marketplaceBundle } from "./plugin-bundle.js";
import {
  readIntegrationRegistry,
  removeIntegrationRecord,
  upsertIntegrationRecord,
} from "./registry-io.js";

// The engine's contract lives in ./manager-contract.ts; callers import it from here.
export type {
  IntegrationHost,
  IntegrationPlan,
  IntegrationRequest,
  OperationKind,
  PlannedOperation,
  ProviderCommandResult,
} from "./manager-contract.js";

export const PATHRULE_PLUGIN = "pathrule";
export const PATHRULE_MARKETPLACE = "pathrule";

export function marketplaceDir(host: Pick<IntegrationHost, "env">): string {
  return join(integrationsDir(host.env), "marketplace");
}

function providerLabel(provider: IntegrationProviderId): string {
  return provider === "claude-code" ? "Claude Code" : "Codex";
}

/** The provider plugin scope for a Pathrule scope: a project install of a local marketplace stays personal. */
function providerScope(scope: IntegrationScope): "user" | "local" {
  return scope === "user" ? "user" : "local";
}

function pluginInstallArgs(req: IntegrationRequest): string[] {
  const id = `${PATHRULE_PLUGIN}@${PATHRULE_MARKETPLACE}`;
  return req.provider === "claude-code"
    ? ["plugin", "install", id, "--scope", providerScope(req.scope), "--json"]
    : ["plugin", "add", id, "--json"];
}

function pluginRemoveArgs(provider: IntegrationProviderId, scope: "user" | "project"): string[] {
  const id = `${PATHRULE_PLUGIN}@${PATHRULE_MARKETPLACE}`;
  return provider === "claude-code"
    ? ["plugin", "uninstall", id, "--scope", providerScope(scope), "--json"]
    : ["plugin", "remove", id];
}

function marketplaceAddArgs(provider: IntegrationProviderId, dir: string): string[] {
  return provider === "claude-code"
    ? ["plugin", "marketplace", "add", dir, "--scope", "user", "--json"]
    : ["plugin", "marketplace", "add", dir, "--json"];
}

function marketplaceRemoveArgs(): string[] {
  return ["plugin", "marketplace", "remove", PATHRULE_MARKETPLACE];
}

function binaryName(provider: IntegrationProviderId): string {
  return provider === "claude-code" ? "claude" : "codex";
}

/** What a Local workspace setup writes into the project for each agent, named in the plan. */
const PROJECT_FILES: Record<IntegrationProviderId, string> = {
  "claude-code": "`.pathrule/` and `.claude/rules/pathrule/`",
  codex: "`.pathrule/` and `.codex/config.toml`",
};

function settingsHookPath(req: IntegrationRequest, home: string, env: NodeJS.ProcessEnv): string {
  if (req.provider === "claude-code") {
    return req.scope === "user"
      ? join(home, ".claude", "settings.json")
      : join(req.projectRoot as string, ".claude", "settings.local.json");
  }
  return req.scope === "user" ? join(codexHome(home, env), "hooks.json") : join(req.projectRoot as string, ".codex", "hooks.json");
}

/**
 * Where Pathrule's hook reaches the agent for this integration, when it is a settings file. Codex
 * runs no plugin-bundled hook (codex-cli 0.161 lists `plugin_hooks` as removed), so its native
 * integration is the plugin for MCP and skills plus Pathrule's entries in a Codex hooks layer, which
 * Codex runs only after the person trusts them in /hooks.
 */
function hookSettingsTarget(req: IntegrationRequest, host: IntegrationHost): string | null {
  if (req.channel === "settings-hook") return settingsHookPath(req, host.home, host.env);
  if (req.channel === "native-plugin" && req.provider === "codex") return settingsHookPath(req, host.home, host.env);
  return null;
}

/**
 * The legacy entries this integration replaces. A project install leaves the user-level entry
 * alone: it still serves every other project, and the hook runs each event once regardless.
 */
async function legacyHooksInScope(req: IntegrationRequest, host: IntegrationHost): Promise<LegacyHookFile[]> {
  const found = await findLegacyHooks(req.provider, { home: host.home, projectRoot: req.projectRoot, env: host.env });
  // The layer this integration writes its own entries to is not legacy.
  const target = hookSettingsTarget(req, host);
  const inScope = req.scope === "project" ? found.filter((f) => f.scope === "project") : found;
  return target ? inScope.filter((f) => f.path !== target) : inScope;
}

/**
 * Whether this setup prepares the project's Local workspace, and why not when it does not. Only a
 * Local folder gets one: an integration never changes a folder's edition, so a Cloud folder or a
 * folder in conflict is left as it is.
 */
async function localWorkspaceStep(req: IntegrationRequest, host: IntegrationHost): Promise<{ prepare: boolean; warning: string | null }> {
  if (req.mode !== "local" || !req.projectRoot) return { prepare: false, warning: null };
  const edition = await host.folderEdition(req.projectRoot);
  if (edition.mode === "local") return { prepare: true, warning: null };
  return {
    prepare: false,
    warning:
      edition.mode === "cloud"
        ? `${req.projectRoot} is a Pathrule Cloud folder, so this setup prepares no Local workspace there and leaves its edition as it is. To change it: pathrule setup --local.`
        : `${edition.conflict ?? `${req.projectRoot} has both a Pathrule Local and a Pathrule Cloud workspace.`} This setup prepares no Local workspace there.`,
  };
}

export async function planIntegration(req: IntegrationRequest, host: IntegrationHost): Promise<IntegrationPlan> {
  const warnings: string[] = [];
  const operations: PlannedOperation[] = [];
  let blocked: IntegrationPlan["blocked"] = null;
  if (req.scope === "project" && !req.projectRoot) {
    blocked = { code: "project_root_required", message: "A project install needs the project folder." };
  }
  if (req.channel === "native-plugin" && !req.mcp) {
    blocked = blocked ?? {
      code: "plugin_bundles_mcp",
      message: "A native plugin always ships Pathrule's MCP server. For hooks without MCP use --channel settings-hook --no-mcp.",
    };
  }
  const registry = await readIntegrationRegistry(host.env);
  const existing =
    registry.integrations.find((r) => r.id === integrationRecordId(req.provider, req.scope, req.projectRoot)) ?? null;
  const legacyHooks = await legacyHooksInScope(req, host);
  const local = await localWorkspaceStep(req, host);
  if (local.warning) warnings.push(local.warning);

  operations.push({
    kind: "runtime",
    summary: `Install Pathrule's hook (runtime ${host.runtimeVersion}) and record it in the runtime manifest, with one MCP server that serves each project from its own edition${req.maintenance ? ", and background index refresh and learning-evidence processing allowed" : ""}.`,
    paths: [join(pathruleHome(host.env), "bin")],
    commands: [],
  });
  if (req.mode === "cloud") {
    operations.push({
      kind: "cloud-check",
      summary:
        "Prepare Pathrule Cloud in this runtime (its Cloud and Intelligence capabilities, installed with npm and shown with their terms) and check this machine's sign-in. Setup never signs in for you.",
      paths: [],
      commands: [],
    });
  }

  if (req.channel === "native-plugin" && req.pluginSource === "install") {
    const binary = await host.providerBinary(req.provider);
    const dir = marketplaceDir(host);
    operations.push({
      kind: "materialize-marketplace",
      summary: `Write Pathrule's plugin marketplace (generated by this runtime, open source only) to ${dir}.`,
      paths: [dir],
      commands: [],
    });
    operations.push({
      kind: "provider-marketplace",
      summary: `Register that marketplace with ${providerLabel(req.provider)}.`,
      paths: [],
      commands: [`${binaryName(req.provider)} ${marketplaceAddArgs(req.provider, dir).join(" ")}`],
    });
    operations.push({
      kind: "provider-plugin",
      summary: `Install the Pathrule plugin into ${providerLabel(req.provider)} (${req.scope === "user" ? "for your user" : "for this project, personal"}).`,
      paths: [],
      commands: [`${binaryName(req.provider)} ${pluginInstallArgs(req).join(" ")}`],
    });
    if (!binary) {
      blocked = blocked ?? {
        code: "provider_cli_missing",
        message: `${providerLabel(req.provider)}'s command (\`${binaryName(req.provider)}\`) is not on PATH, so Pathrule cannot install its plugin for you.`,
        manual:
          req.provider === "claude-code"
            ? [`In Claude Code run: /plugin marketplace add ${dir}`, "Then: /plugin install pathrule@pathrule", "Then: /pathrule:setup"]
            : [`Run: codex plugin marketplace add ${dir}`, "Then: codex plugin add pathrule@pathrule", "Then ask Codex to use the pathrule-setup skill."],
      };
    }
    if (req.provider === "codex") {
      warnings.push("Codex runs Pathrule's hooks only after you trust them: it asks you to review new hooks when your next session starts (and /hooks shows them). Until then Pathrule works through its MCP tools and skills.");
    }
  }

  const hookTarget = hookSettingsTarget(req, host);
  if (hookTarget && req.channel === "native-plugin") {
    operations.push({
      kind: "settings-hooks",
      summary: `Write Pathrule's hook entries into ${hookTarget} (other entries are kept). Codex runs them only after you trust them in its own hook review.`,
      paths: [hookTarget],
      commands: [],
    });
  }
  if (req.channel === "settings-hook") {
    const path = hookTarget as string;
    operations.push({
      kind: "settings-hooks",
      summary: `Write Pathrule's hook entries into ${path} (other entries are kept).`,
      paths: [path],
      commands: [],
    });
    if (req.mcp) {
      operations.push({
        kind: "mcp-entry",
        summary: `Add Pathrule's MCP server to ${providerLabel(req.provider)}'s user config (other servers are kept).`,
        paths: [],
        commands: [],
      });
    } else {
      warnings.push("Hook-only: the agent gets Pathrule's context, rules and evidence capture through the hook, and no Pathrule MCP tools.");
    }
  }

  for (const f of legacyHooks.filter((x) => x.unreadable)) {
    warnings.push(`${f.path} is not valid JSON, so Pathrule left it as it is. If it holds a Pathrule hook, remove that entry by hand.`);
  }
  operations.push({
    kind: "registry",
    summary: `Record this integration in ${join(integrationsDir(host.env), "registry.json")}.`,
    paths: [join(integrationsDir(host.env), "registry.json")],
    commands: [],
  });
  // After the record: a sync during the workspace setup then already knows the plugin owns the
  // hook, writes no settings entry for it, and takes the protocol channel from the record.
  if (local.prepare && req.projectRoot) {
    operations.push({
      kind: "local-workspace",
      summary: `Use ${req.projectRoot} as a Pathrule Local workspace (created if it is not one) and build its hook index. In the project Pathrule writes only its own files (${PROJECT_FILES[req.provider]}); your CLAUDE.md and AGENTS.md are not changed.`,
      paths: [req.projectRoot],
      commands: [],
    });
  }
  if (req.channel === "native-plugin") {
    // Always planned: setup itself may write a legacy entry (a sync), so the files are scanned again
    // when this step runs. The preview names what is there now.
    const toRemove = legacyHooks.filter((f) => !f.unreadable);
    operations.push({
      kind: "remove-legacy-hooks",
      summary:
        toRemove.length > 0
          ? `Remove Pathrule's own legacy hook entries (${toRemove.reduce((n, f) => n + f.entries, 0)} now) from ${providerLabel(req.provider)} settings so hooks never run twice. Other entries are kept, and each file is backed up first.`
          : `Make sure no legacy Pathrule hook entry is left in ${providerLabel(req.provider)} settings (none now), so hooks never run twice.`,
      paths: legacyHooks.length > 0 ? toRemove.map((f) => f.path) : [],
      commands: [],
    });
  }
  return { request: req, operations, warnings, blocked, legacyHooks, existing };
}

export interface ApplyResult {
  ok: boolean;
  record: IntegrationRecord | null;
  done: OperationKind[];
  /** Human lines for the summary. */
  summary: string[];
  next: Array<{ label: string; command?: string }>;
  error?: { code: string; message: string; operation: OperationKind };
  rolledBack: boolean;
}

class ApplyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function backupFile(host: IntegrationHost, path: string, body: string): Promise<string> {
  const stamp = host.now().toISOString().replace(/[:.]/g, "-");
  const target = join(integrationsDir(host.env), "backups", stamp, path.replace(/^[A-Za-z]:/, "").replace(/^[\\/]+/, ""));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, body, { encoding: "utf8", mode: 0o600 });
  return target;
}

function providerOk(result: ProviderCommandResult): boolean {
  return result.status === 0;
}

function alreadyPresent(result: ProviderCommandResult): boolean {
  return /already (installed|exists|added|configured)/i.test(`${result.stdout}\n${result.stderr}`);
}

export async function applyIntegration(plan: IntegrationPlan, host: IntegrationHost): Promise<ApplyResult> {
  const req = plan.request;
  if (plan.blocked) {
    return {
      ok: false,
      record: null,
      done: [],
      summary: [],
      next: (plan.blocked.manual ?? []).map((label) => ({ label })),
      error: { code: plan.blocked.code, message: plan.blocked.message, operation: plan.operations[0]?.kind ?? "registry" },
      rolledBack: false,
    };
  }
  const undo: Array<() => Promise<void>> = [];
  const done: OperationKind[] = [];
  const resources: IntegrationResource[] = [];
  const summary: string[] = [];
  const next: ApplyResult["next"] = [];
  const now = host.now().toISOString();

  const run = async (op: PlannedOperation) => {
    switch (op.kind) {
      case "runtime": {
        // Every native plugin's launcher reads the manifest: a failed apply puts the previous one
        // back, so it never leaves a runtime nobody approved.
        const manifestPath = runtimeManifestPath(host.env);
        const before = await readFile(manifestPath, "utf8").catch(() => null);
        const r = await host.ensureRuntime({ mode: req.mode, maintenance: req.maintenance });
        undo.push(async () => {
          if (before === null) await rm(manifestPath, { force: true });
          else await atomicWrite(manifestPath, before, { mode: 0o600 });
        });
        summary.push(`Hook ready at ${r.hookPath}; runtime manifest at ${r.manifestPath}.`);
        return;
      }
      case "local-workspace": {
        const ws = await host.ensureLocalWorkspace(req.projectRoot as string, req.provider);
        summary.push(`${ws.created ? "Created" : "Using"} Pathrule Local workspace ${ws.workspaceId} for ${req.projectRoot}.`);
        return;
      }
      case "cloud-check": {
        const cloud = await host.cloudStatus();
        if (!cloud.ready) throw new ApplyError("cloud_unavailable", cloud.detail);
        if (!cloud.signedIn) {
          summary.push("Pathrule Cloud is ready on this machine; you are not signed in yet.");
          next.push({ label: "Sign in to Pathrule Cloud in a terminal", command: cloud.loginCommand });
        } else {
          summary.push("Signed in to Pathrule Cloud.");
        }
        return;
      }
      case "materialize-marketplace": {
        const dir = marketplaceDir(host);
        await writeBundle(dir, marketplaceBundle(host.bundleInput()));
        resources.push({ kind: "owned-path", path: dir });
        summary.push(`Plugin marketplace written to ${dir}.`);
        return;
      }
      case "provider-marketplace": {
        const dir = marketplaceDir(host);
        const result = await host.runProvider(req.provider, marketplaceAddArgs(req.provider, dir));
        if (!providerOk(result) && !alreadyPresent(result)) {
          throw new ApplyError("provider_marketplace_failed", `${binaryName(req.provider)} could not add the marketplace: ${(result.stderr || result.stdout).trim().slice(0, 600)}`);
        }
        resources.push({ kind: "provider-marketplace", provider: req.provider, name: PATHRULE_MARKETPLACE, source: dir });
        if (providerOk(result)) {
          undo.push(async () => {
            await host.runProvider(req.provider, marketplaceRemoveArgs());
          });
        }
        return;
      }
      case "provider-plugin": {
        const result = await host.runProvider(req.provider, pluginInstallArgs(req));
        if (!providerOk(result) && !alreadyPresent(result)) {
          throw new ApplyError("provider_plugin_failed", `${binaryName(req.provider)} could not install the plugin: ${(result.stderr || result.stdout).trim().slice(0, 600)}`);
        }
        resources.push({
          kind: "provider-plugin",
          provider: req.provider,
          plugin: PATHRULE_PLUGIN,
          marketplace: PATHRULE_MARKETPLACE,
          scope: req.scope,
        });
        if (providerOk(result)) {
          undo.push(async () => {
            await host.runProvider(req.provider, pluginRemoveArgs(req.provider, req.scope));
          });
        }
        summary.push(`Pathrule plugin installed in ${providerLabel(req.provider)}.`);
        if (req.provider === "claude-code") next.push({ label: "Start a new Claude Code session (or run /reload-plugins) so the plugin loads" });
        else next.push({ label: "Start a new Codex session and trust Pathrule's hooks when Codex asks you to review them (or in /hooks)" });
        return;
      }
      case "settings-hooks": {
        const path = op.paths[0] as string;
        let before: string | null = null;
        try {
          before = await readFile(path, "utf8");
        } catch {
          before = null;
        }
        if (before !== null) await backupFile(host, path, before);
        const r = await host.writeSettingsHooks(req.provider, path);
        resources.push({ kind: "hook-entries", path });
        if (r.changed) {
          undo.push(async () => {
            if (before === null) await rm(path, { force: true });
            else await atomicWrite(path, before);
          });
        }
        summary.push(`Hook entries ${r.changed ? "written to" : "already in"} ${path}.`);
        return;
      }
      case "mcp-entry": {
        const entry = await host.installMcpEntry(req.provider);
        resources.push({ kind: "mcp-entry", path: entry.path, server: entry.server });
        undo.push(async () => {
          await host.removeMcpEntry(req.provider);
        });
        summary.push(`MCP server entry written to ${entry.path}.`);
        return;
      }
      case "remove-legacy-hooks": {
        const current = await legacyHooksInScope(req, host);
        for (const path of current.filter((f) => !f.unreadable).map((f) => f.path)) {
          const before = await readFile(path, "utf8");
          const after = withoutPathruleHooks(req.provider, before);
          if (after === null) continue;
          const backup = await backupFile(host, path, before);
          await atomicWrite(path, after);
          undo.push(async () => {
            await atomicWrite(path, before);
          });
          summary.push(`Removed Pathrule's legacy hook entries from ${path} (backup: ${backup}).`);
        }
        return;
      }
      case "registry": {
        const record: IntegrationRecord = {
          id: integrationRecordId(req.provider, req.scope, req.projectRoot),
          provider: req.provider,
          scope: req.scope,
          project_root: req.scope === "project" ? req.projectRoot : null,
          mode: req.mode,
          channel: req.channel,
          edition: "full",
          mcp: req.mcp,
          plugin_version: req.pluginVersion,
          runtime_version: host.runtimeVersion,
          installed_at: plan.existing?.installed_at || now,
          updated_at: now,
          status: "installed",
          resources: mergeResources(plan.existing?.resources ?? [], resources),
        };
        await upsertIntegrationRecord(record, host.env);
        undo.push(async () => {
          if (plan.existing) await upsertIntegrationRecord(plan.existing, host.env);
          else await removeIntegrationRecord(record.id, host.env);
        });
        return;
      }
    }
  };

  for (const op of plan.operations) {
    try {
      await run(op);
      done.push(op.kind);
    } catch (err) {
      const code = err instanceof ApplyError ? err.code : "operation_failed";
      const message = err instanceof Error ? err.message : String(err);
      let rolledBack = true;
      for (const step of undo.reverse()) {
        try {
          await step();
        } catch {
          rolledBack = false;
        }
      }
      if (!rolledBack) {
        await upsertIntegrationRecord(
          {
            id: integrationRecordId(req.provider, req.scope, req.projectRoot),
            provider: req.provider,
            scope: req.scope,
            project_root: req.scope === "project" ? req.projectRoot : null,
            mode: req.mode,
            channel: req.channel,
            edition: "full",
            mcp: req.mcp,
            plugin_version: req.pluginVersion,
            runtime_version: host.runtimeVersion,
            installed_at: plan.existing?.installed_at || now,
            updated_at: now,
            status: "partial",
            resources: mergeResources(plan.existing?.resources ?? [], resources),
          },
          host.env,
        ).catch(() => {});
      }
      return { ok: false, record: null, done, summary, next, error: { code, message, operation: op.kind }, rolledBack };
    }
  }
  const registry = await readIntegrationRegistry(host.env);
  const record = registry.integrations.find((r) => r.id === integrationRecordId(req.provider, req.scope, req.projectRoot)) ?? null;
  return { ok: true, record, done, summary, next, rolledBack: false };
}

function resourceKey(r: IntegrationResource): string {
  switch (r.kind) {
    case "provider-plugin":
      return `${r.kind}:${r.provider}:${r.plugin}@${r.marketplace}:${r.scope}`;
    case "provider-marketplace":
      return `${r.kind}:${r.provider}:${r.name}`;
    case "mcp-entry":
      return `${r.kind}:${r.path}:${r.server}`;
    default:
      return `${r.kind}:${r.path}`;
  }
}

function mergeResources(a: IntegrationResource[], b: IntegrationResource[]): IntegrationResource[] {
  const map = new Map<string, IntegrationResource>();
  for (const r of [...a, ...b]) map.set(resourceKey(r), r);
  return [...map.values()];
}

export interface RemoveResult {
  ok: boolean;
  removed: string[];
  kept: string[];
  errors: string[];
}

/**
 * Remove one integration: exactly the resources its record lists. A provider plugin or marketplace
 * Pathrule did not install (the record does not list it) is left to its provider; the summary says
 * how to remove it there.
 */
export async function removeIntegration(
  target: { provider: IntegrationProviderId; scope: IntegrationScope; projectRoot: string | null },
  host: IntegrationHost,
): Promise<RemoveResult> {
  const registry = await readIntegrationRegistry(host.env);
  const id = integrationRecordId(target.provider, target.scope, target.projectRoot);
  const record = registry.integrations.find((r) => r.id === id);
  const removed: string[] = [];
  const kept: string[] = [];
  const errors: string[] = [];
  if (!record) return { ok: true, removed, kept, errors };
  const stillUsed = (r: IntegrationResource) =>
    registry.integrations.some((other) => other.id !== id && other.resources.some((x) => resourceKey(x) === resourceKey(r)));
  for (const resource of [...record.resources].reverse()) {
    if (stillUsed(resource)) {
      kept.push(`${resourceKey(resource)} (another integration uses it)`);
      continue;
    }
    try {
      switch (resource.kind) {
        case "provider-plugin": {
          const r = await host.runProvider(resource.provider, pluginRemoveArgs(resource.provider, resource.scope));
          if (r.status !== 0 && !/not (installed|found)/i.test(`${r.stdout}${r.stderr}`)) {
            throw new Error((r.stderr || r.stdout).trim().slice(0, 400));
          }
          removed.push(`${providerLabel(resource.provider)} plugin ${resource.plugin}@${resource.marketplace}`);
          break;
        }
        case "provider-marketplace": {
          const r = await host.runProvider(resource.provider, marketplaceRemoveArgs());
          if (r.status !== 0 && !/not (found|configured)/i.test(`${r.stdout}${r.stderr}`)) {
            throw new Error((r.stderr || r.stdout).trim().slice(0, 400));
          }
          removed.push(`${providerLabel(resource.provider)} marketplace ${resource.name}`);
          break;
        }
        case "owned-path":
          await rm(resource.path, { recursive: true, force: true });
          removed.push(resource.path);
          break;
        case "hook-entries": {
          let body: string;
          try {
            body = await readFile(resource.path, "utf8");
          } catch {
            break;
          }
          const after = withoutPathruleHooks(record.provider, body);
          if (after !== null) {
            await backupFile(host, resource.path, body);
            await atomicWrite(resource.path, after);
            removed.push(`Pathrule hook entries in ${resource.path}`);
          }
          break;
        }
        case "mcp-entry":
          await host.removeMcpEntry(record.provider);
          removed.push(`MCP entry ${resource.server} in ${resource.path}`);
          break;
      }
    } catch (err) {
      errors.push(`${resourceKey(resource)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (errors.length === 0) await removeIntegrationRecord(id, host.env);
  return { ok: errors.length === 0, removed, kept, errors };
}

export interface DoctorFinding {
  level: "ok" | "warn" | "error";
  message: string;
  fix?: string;
}

/** What is installed and what is wrong, without changing anything. */
export async function diagnoseIntegrations(
  host: IntegrationHost,
  cwd: string,
): Promise<{ records: IntegrationRecord[]; findings: DoctorFinding[] }> {
  const registry = await readIntegrationRegistry(host.env);
  const findings: DoctorFinding[] = [];
  if (registry.integrations.length === 0) {
    findings.push({ level: "warn", message: "No Pathrule integration is recorded on this machine.", fix: "pathrule integrations" });
  }
  for (const record of registry.integrations) {
    if (record.status === "partial") {
      findings.push({ level: "error", message: `${record.id} was left partially installed.`, fix: "pathrule integrations repair" });
    }
    if (record.channel === "native-plugin") {
      const legacy = await legacyHooksInScope(
        {
          provider: record.provider,
          scope: record.scope,
          projectRoot: record.project_root ?? cwd,
          mode: record.mode,
          channel: record.channel,
          maintenance: false,
          mcp: record.mcp,
          pluginSource: "attach",
          pluginVersion: record.plugin_version,
        },
        host,
      );
      for (const f of legacy) {
        findings.push({
          level: "warn",
          message: `${f.path} still holds Pathrule hook entries beside the ${providerLabel(record.provider)} plugin. Pathrule runs each event once anyway, but the entries are redundant.`,
          fix: "pathrule integrations repair",
        });
      }
    }
    if (record.resources.some((r) => r.kind === "owned-path")) {
      for (const r of record.resources) {
        if (r.kind !== "owned-path") continue;
        try {
          await readFile(join(r.path, ".claude-plugin", "marketplace.json"), "utf8");
        } catch {
          findings.push({ level: "error", message: `The plugin marketplace at ${r.path} is missing.`, fix: "pathrule integrations repair" });
        }
      }
    }
  }
  return { records: registry.integrations, findings };
}
