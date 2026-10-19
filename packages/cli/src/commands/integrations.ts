// SPDX-License-Identifier: Apache-2.0
// `pathrule integrations`: connect Pathrule to the AI coding agents on this machine, through one
// engine (@pathrule/integrations native/manager.ts) that every distribution path shares: this
// command, its npx entry, and a provider plugin's own setup (`attach`).
//
//   pathrule integrations                 the setup wizard in a terminal, else `list`
//   pathrule integrations list            detected agents, recorded integrations, the runtime
//   pathrule integrations add <agent...>  plan, preview, approve, apply, verify
//   pathrule integrations remove <agent>  remove exactly what Pathrule recorded for it
//   pathrule integrations repair          apply every recorded integration again, idempotently
//   pathrule integrations doctor          what is installed and what is wrong; changes nothing
//   pathrule integrations attach ...      a plugin's setup records itself (the plugin is installed)
//
// Options: --scope user|project, --project <dir>, --local | --cloud, --channel plugin|settings,
// --no-mcp (settings channel only), --no-maintenance, --dry-run, --yes, --json.
// Nothing is changed without approval: interactively a confirmation, otherwise --yes.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  applyIntegration,
  diagnoseIntegrations,
  planIntegration,
  removeIntegration,
  type ApplyResult,
  type IntegrationHost,
  type IntegrationPlan,
  type IntegrationRequest,
} from "@pathrule/integrations/native/manager.js";
import {
  detectProviders,
  isNativeProvider,
  parseProviderId,
  type DetectedProvider,
} from "@pathrule/integrations/native/providers.js";
import { nativeProviderSpec } from "@pathrule/integrations/native/provider-specs.js";
import { readIntegrationRegistry } from "@pathrule/integrations/native/registry-io.js";
import { readRuntimeManifest } from "@pathrule/integrations/native/runtime-manifest-io.js";
import type {
  IntegrationChannel,
  IntegrationMode,
  IntegrationProviderId,
  IntegrationScope,
} from "@pathrule/protocol/integration-registry.js";

import { cliIntegrationHost, integrationFolderEdition } from "../integrations/host.js";
import { confirm, selectMany, selectOne, type Choice } from "../integrations/prompts.js";
import { provisionStableRuntime, runInStableRuntime, runsFromTemporaryCache } from "../integrations/stable-runtime.js";
import { jsonEnvelope, statusLabel, type CliOutputMode } from "../output.js";
import type { CliCommand, CliCommandContext, CliJsonResult, CliRuntime } from "../plugin.js";

const USAGE =
  "Usage: pathrule integrations [list|add <agent...>|remove <agent>|repair|doctor] [--scope user|project] [--project <dir>] [--local|--cloud] [--channel plugin|settings] [--no-mcp] [--no-maintenance] [--dry-run] [--yes] [--json]";

interface ParsedArgs {
  sub: string;
  providers: string[];
  scope: IntegrationScope;
  project: string | null;
  channel: IntegrationChannel;
  mcp: boolean;
  maintenance: boolean;
  dryRun: boolean;
  pluginVersion: string | null;
  explicitProvider: string | null;
}

class UsageError extends Error {}

function parseArgs(args: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    sub: "",
    providers: [],
    scope: "user",
    project: null,
    channel: "native-plugin",
    mcp: true,
    maintenance: true,
    dryRun: false,
    pluginVersion: null,
    explicitProvider: null,
  };
  const value = (i: number, name: string) => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--scope") {
      const v = value(i++, a);
      if (v !== "user" && v !== "project") throw new UsageError("--scope is user or project");
      out.scope = v;
    } else if (a === "--project") out.project = resolve(value(i++, a));
    else if (a === "--channel") {
      const v = value(i++, a);
      if (v === "plugin" || v === "native-plugin") out.channel = "native-plugin";
      else if (v === "settings" || v === "settings-hook") out.channel = "settings-hook";
      else throw new UsageError("--channel is plugin or settings");
    } else if (a === "--provider") out.explicitProvider = value(i++, a);
    else if (a === "--plugin-version") out.pluginVersion = value(i++, a);
    else if (a === "--no-mcp") out.mcp = false;
    else if (a === "--no-maintenance") out.maintenance = false;
    else if (a === "--maintenance") out.maintenance = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--")) throw new UsageError(`unknown option ${a}`);
    else if (!out.sub) out.sub = a;
    else out.providers.push(a);
  }
  if (out.explicitProvider) out.providers.push(out.explicitProvider);
  return out;
}

/**
 * What a setup prepares: `--cloud` or `--local`, else the project's own edition, else this machine's
 * default. Neither is changed here: `pathrule setup` changes a folder's edition or the default.
 */
function chosenMode(ctx: CliCommandContext, parsed: ParsedArgs): IntegrationMode {
  if (ctx.flags.cloud) return "cloud";
  if (ctx.flags.local) return "local";
  const folder = integrationFolderEdition(projectFor(parsed, ctx.runtime.cwd) ?? ctx.runtime.cwd, ctx.runtime.env);
  return folder.mode ?? folder.deviceDefault;
}

/** The project folder a request prepares: given, else the cwd when it is a project. */
function projectFor(parsed: ParsedArgs, cwd: string): string | null {
  if (parsed.project) return parsed.project;
  if (parsed.scope === "project") return cwd;
  return existsSync(resolve(cwd, ".git")) || existsSync(resolve(cwd, ".pathrule")) ? cwd : null;
}

function requestFor(
  provider: IntegrationProviderId,
  parsed: ParsedArgs,
  mode: IntegrationMode,
  cwd: string,
  pluginSource: IntegrationRequest["pluginSource"],
): IntegrationRequest {
  return {
    provider,
    scope: parsed.scope,
    projectRoot: projectFor(parsed, cwd),
    mode,
    channel: parsed.channel,
    maintenance: parsed.maintenance,
    mcp: parsed.channel === "native-plugin" ? true : parsed.mcp,
    pluginSource,
    pluginVersion: parsed.pluginVersion,
  };
}

function nativeProviders(names: readonly string[]): IntegrationProviderId[] {
  const out: IntegrationProviderId[] = [];
  for (const name of names) {
    const id = parseProviderId(name);
    if (!id) throw new UsageError(`unknown agent "${name}"`);
    if (!isNativeProvider(id)) {
      throw new UsageError(
        `${name}: no native integration yet; Pathrule does not support it today.`,
      );
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function label(p: IntegrationProviderId): string {
  return nativeProviderSpec(p).label;
}

function renderPlan(plan: IntegrationPlan, mode: CliOutputMode): string {
  const r = plan.request;
  const lines = [
    `${label(r.provider)} · ${r.scope === "user" ? "all your projects" : `project ${r.projectRoot}`} · ${r.mode === "local" ? "Pathrule Local" : "Pathrule Cloud"} · ${r.channel === "native-plugin" ? "native plugin" : "settings hooks"}${r.mcp ? "" : " (hook-only)"}`,
  ];
  plan.operations.forEach((op, i) => {
    lines.push(`  ${i + 1}. ${op.summary}`);
    for (const c of op.commands) lines.push(`       runs: ${c}`);
  });
  for (const w of plan.warnings) lines.push(`  ${statusLabel("warn", mode)} ${w}`);
  if (plan.blocked) {
    lines.push(`  ${statusLabel("error", mode)} ${plan.blocked.message}`);
    for (const m of plan.blocked.manual ?? []) lines.push(`       ${m}`);
  }
  return lines.join("\n");
}

function renderApply(result: ApplyResult, mode: CliOutputMode): string {
  const lines: string[] = [];
  for (const s of result.summary) lines.push(`  ${statusLabel("ok", mode)} ${s}`);
  if (result.error) {
    lines.push(`  ${statusLabel("error", mode)} ${result.error.message}`);
    lines.push(
      result.rolledBack
        ? "  Every step before it was undone; nothing is half-installed."
        : "  Some steps could not be undone; run pathrule integrations repair.",
    );
  }
  for (const n of result.next) lines.push(`  Next: ${n.label}${n.command ? `: ${n.command}` : ""}`);
  return lines.join("\n");
}

function planJson(plan: IntegrationPlan) {
  return {
    request: plan.request,
    operations: plan.operations,
    warnings: plan.warnings,
    blocked: plan.blocked,
    existing: plan.existing ? { id: plan.existing.id, updated_at: plan.existing.updated_at } : null,
  };
}

// ─── A CLI run from a temporary cache hands its changes to a stable runtime ───

const TEMPORARY_CACHE_NOTE =
  "This Pathrule CLI runs from a temporary package cache. Applying first installs the same runtime version under ~/.pathrule/runtime with npm (no dependency install scripts; one native SQLite module), so the hooks and the MCP server keep working after the cache is cleaned.";

function stableArgs(ctx: CliCommandContext, extra: readonly string[] = []): string[] {
  return [
    "integrations",
    ...ctx.args,
    ...extra,
    ...(ctx.flags.yes ? ["--yes"] : []),
    ...(ctx.flags.local ? ["--local"] : []),
    ...(ctx.flags.cloud ? ["--cloud"] : []),
  ];
}

/** Provision the stable runtime, then run `args` there. Null when this CLI is already stable. */
async function handOver(ctx: CliCommandContext, args: string[], json: boolean): Promise<CliJsonResult | null> {
  if (!runsFromTemporaryCache(ctx.runtime.env)) return null;
  const provisioned = await provisionStableRuntime(ctx.runtime.env, ctx.runtime.stderr);
  if (!provisioned.ok) {
    return {
      exitCode: 1,
      envelope: jsonEnvelope({
        command: "integrations",
        cwd: ctx.runtime.cwd,
        ok: false,
        error: {
          code: "runtime_provision_failed",
          message: provisioned.message,
          ...(provisioned.recovery ? { remediation: [{ label: provisioned.recovery }] } : {}),
        },
      }),
    };
  }
  const result = await runInStableRuntime(provisioned.runtime, json ? [...args, "--json"] : args, ctx.runtime.env, json);
  if (!json) return { exitCode: result.code, envelope: jsonEnvelope({ command: "integrations", cwd: ctx.runtime.cwd, ok: result.code === 0 }) };
  try {
    return { exitCode: result.code, envelope: JSON.parse(result.stdout) };
  } catch {
    return {
      exitCode: 1,
      envelope: jsonEnvelope({ command: "integrations", cwd: ctx.runtime.cwd, ok: false, error: { code: "handover_failed", message: result.stdout.slice(0, 2000) } }),
    };
  }
}

// ─── Subcommands ────────────────────────────────────────────────────────────

async function list(runtime: CliRuntime) {
  const [providers, registry, manifest] = await Promise.all([
    detectProviders({ env: runtime.env, home: runtime.env.HOME || undefined, probeVersions: true }),
    readIntegrationRegistry(runtime.env),
    readRuntimeManifest(runtime.env),
  ]);
  return { providers, integrations: registry.integrations, runtime: manifest };
}

async function plansFor(ctx: CliCommandContext, parsed: ParsedArgs, host: IntegrationHost, providers: IntegrationProviderId[]) {
  const mode = chosenMode(ctx, parsed);
  return Promise.all(providers.map((p) => planIntegration(requestFor(p, parsed, mode, ctx.runtime.cwd, "install"), host)));
}

async function applyAll(plans: IntegrationPlan[], host: IntegrationHost): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  // One at a time: two providers' steps share the runtime manifest and the registry.
  for (const plan of plans) results.push(await applyIntegration(plan, host));
  return results;
}

async function addJson(ctx: CliCommandContext, parsed: ParsedArgs): Promise<CliJsonResult> {
  const cwd = ctx.runtime.cwd;
  const providers = nativeProviders(parsed.providers);
  if (providers.length === 0) throw new UsageError("name at least one agent: claude-code, codex");
  const host = await cliIntegrationHost(ctx.runtime.env, { runtime: ctx.runtime });
  const plans = await plansFor(ctx, parsed, host, providers);
  if (parsed.dryRun || !ctx.flags.yes) {
    return {
      exitCode: parsed.dryRun ? 0 : 2,
      envelope: jsonEnvelope({
        command: "integrations add",
        cwd,
        ok: parsed.dryRun,
        data: {
          approval_required: !parsed.dryRun,
          plans: plans.map(planJson),
          ...(runsFromTemporaryCache(ctx.runtime.env) ? { runtime_provisioning: TEMPORARY_CACHE_NOTE } : {}),
        },
        ...(parsed.dryRun ? {} : { error: { code: "approval_required", message: "Review the plan and run again with --yes." } }),
      }),
    };
  }
  const results = await applyAll(plans, host);
  const ok = results.every((r) => r.ok);
  return {
    exitCode: ok ? 0 : 1,
    envelope: jsonEnvelope({
      command: "integrations add",
      cwd,
      ok,
      data: { plans: plans.map(planJson), results },
      ...(ok ? {} : { error: { code: results.find((r) => !r.ok)?.error?.code ?? "apply_failed", message: results.find((r) => !r.ok)?.error?.message ?? "failed" } }),
    }),
  };
}

/** A provider plugin's setup: the plugin is installed by its provider; record it and finish setup. */
async function attachJson(ctx: CliCommandContext, parsed: ParsedArgs): Promise<CliJsonResult> {
  const cwd = ctx.runtime.cwd;
  const providers = nativeProviders(parsed.providers);
  if (providers.length !== 1) throw new UsageError("attach takes exactly one --provider");
  if (!ctx.flags.yes) throw new UsageError("attach records an approved setup; pass --yes");
  const host = await cliIntegrationHost(ctx.runtime.env, { runtime: ctx.runtime });
  const mode = chosenMode(ctx, parsed);
  const plan = await planIntegration(requestFor(providers[0]!, { ...parsed, channel: "native-plugin" }, mode, cwd, "attach"), host);
  const result = await applyIntegration(plan, host);
  return {
    exitCode: result.ok ? 0 : 1,
    envelope: jsonEnvelope({
      command: "integrations attach",
      cwd,
      ok: result.ok,
      data: { plan: planJson(plan), summary: result.summary, record: result.record },
      ...(result.ok ? {} : { error: { code: result.error?.code ?? "attach_failed", message: result.error?.message ?? "failed" } }),
      next_steps: result.next,
    }),
  };
}

async function removeJson(ctx: CliCommandContext, parsed: ParsedArgs): Promise<CliJsonResult> {
  const cwd = ctx.runtime.cwd;
  const providers = nativeProviders(parsed.providers);
  if (providers.length === 0) throw new UsageError("name the agent to remove");
  const registry = await readIntegrationRegistry(ctx.runtime.env);
  const projectRoot = parsed.scope === "project" ? (parsed.project ?? cwd) : null;
  const targets = providers.map((p) => ({ provider: p, scope: parsed.scope, projectRoot }));
  const records = registry.integrations.filter((r) =>
    targets.some((t) => t.provider === r.provider && t.scope === r.scope && (t.scope === "user" || r.project_root === t.projectRoot)),
  );
  if (parsed.dryRun || !ctx.flags.yes) {
    return {
      exitCode: parsed.dryRun ? 0 : 2,
      envelope: jsonEnvelope({
        command: "integrations remove",
        cwd,
        ok: parsed.dryRun,
        data: { approval_required: !parsed.dryRun, would_remove: records.map((r) => ({ id: r.id, resources: r.resources })) },
        ...(parsed.dryRun ? {} : { error: { code: "approval_required", message: "Review what would be removed and run again with --yes." } }),
      }),
    };
  }
  const host = await cliIntegrationHost(ctx.runtime.env, { runtime: ctx.runtime });
  const results = [];
  for (const t of targets) results.push({ ...t, ...(await removeIntegration(t, host)) });
  const ok = results.every((r) => r.ok);
  return {
    exitCode: ok ? 0 : 1,
    envelope: jsonEnvelope({ command: "integrations remove", cwd, ok, data: { results } }),
  };
}

async function repairJson(ctx: CliCommandContext, parsed: ParsedArgs): Promise<CliJsonResult> {
  const cwd = ctx.runtime.cwd;
  const registry = await readIntegrationRegistry(ctx.runtime.env);
  const host = await cliIntegrationHost(ctx.runtime.env, { runtime: ctx.runtime });
  const plans = await Promise.all(
    registry.integrations.map((r) =>
      planIntegration(
        {
          provider: r.provider,
          scope: r.scope,
          projectRoot: r.project_root ?? projectFor(parsed, cwd),
          mode: r.mode,
          channel: r.channel === "mcp-only" ? "settings-hook" : r.channel,
          maintenance: parsed.maintenance,
          mcp: r.mcp,
          // Repair never installs a provider plugin it did not install before.
          pluginSource: r.resources.some((x) => x.kind === "provider-plugin") ? "install" : "attach",
          pluginVersion: r.plugin_version,
        },
        host,
      ),
    ),
  );
  if (!ctx.flags.yes || parsed.dryRun) {
    return {
      exitCode: parsed.dryRun ? 0 : 2,
      envelope: jsonEnvelope({
        command: "integrations repair",
        cwd,
        ok: parsed.dryRun,
        data: { approval_required: !parsed.dryRun, plans: plans.map(planJson) },
        ...(parsed.dryRun ? {} : { error: { code: "approval_required", message: "Review the plan and run again with --yes." } }),
      }),
    };
  }
  const results = await applyAll(plans, host);
  const ok = results.every((r) => r.ok);
  return { exitCode: ok ? 0 : 1, envelope: jsonEnvelope({ command: "integrations repair", cwd, ok, data: { results } }) };
}

async function doctorJson(ctx: CliCommandContext): Promise<CliJsonResult> {
  const host = await cliIntegrationHost(ctx.runtime.env, { runtime: ctx.runtime });
  const report = await diagnoseIntegrations(host, ctx.runtime.cwd);
  const manifest = await readRuntimeManifest(ctx.runtime.env);
  const findings = [...report.findings];
  if (!manifest) {
    findings.push({ level: "warn", message: "No runtime manifest: provider plugins cannot find this runtime.", fix: "pathrule integrations repair" });
  } else if (!existsSync(manifest.cli.entry) || !existsSync(manifest.hook)) {
    findings.push({ level: "error", message: "The runtime manifest names files that are gone.", fix: "pathrule integrations repair" });
  }
  const ok = !findings.some((f) => f.level === "error");
  return {
    exitCode: ok ? 0 : 1,
    envelope: jsonEnvelope({
      command: "integrations doctor",
      cwd: ctx.runtime.cwd,
      ok,
      data: { runtime: manifest, integrations: report.records, findings },
    }),
  };
}

async function dispatchJson(ctx: CliCommandContext): Promise<CliJsonResult> {
  try {
    const parsed = parseArgs(ctx.args);
    const mutating = ["add", "attach", "repair", "remove"].includes(parsed.sub) && ctx.flags.yes && !parsed.dryRun;
    if (mutating) {
      const handed = await handOver(ctx, stableArgs(ctx), true);
      if (handed) return handed;
    }
    switch (parsed.sub || "list") {
      case "list":
      case "status":
        return {
          exitCode: 0,
          envelope: jsonEnvelope({ command: "integrations list", cwd: ctx.runtime.cwd, ok: true, data: await list(ctx.runtime) }),
        };
      case "add":
      case "plan":
        return await addJson(ctx, parsed.sub === "plan" ? { ...parsed, dryRun: true } : parsed);
      case "attach":
        return await attachJson(ctx, parsed);
      case "remove":
        return await removeJson(ctx, parsed);
      case "repair":
        return await repairJson(ctx, parsed);
      case "doctor":
        return await doctorJson(ctx);
      default:
        throw new UsageError(`unknown subcommand "${parsed.sub}"`);
    }
  } catch (err) {
    const usage = err instanceof UsageError;
    return {
      exitCode: usage ? 64 : 1,
      envelope: jsonEnvelope({
        command: "integrations",
        cwd: ctx.runtime.cwd,
        ok: false,
        error: { code: usage ? "usage" : "integrations_failed", message: `${err instanceof Error ? err.message : String(err)}${usage ? `\n${USAGE}` : ""}` },
      }),
    };
  }
}

// ─── The wizard ─────────────────────────────────────────────────────────────

function canAsk(runtime: CliRuntime, mode: CliOutputMode): boolean {
  if (!mode.interactive || mode.json) return false;
  if (runtime.promptLine) return true;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function wizard(ctx: CliCommandContext, parsed: ParsedArgs): Promise<number> {
  const { runtime, mode } = ctx;
  const out = runtime.stdout;
  out.write("\nPathrule: connect your coding agents\n\nLooking for coding agents on this machine...\n");
  const detected = await detectProviders({ env: runtime.env, home: runtime.env.HOME || undefined, probeVersions: true });
  const manifest = await readRuntimeManifest(runtime.env);

  const choices: Choice<DetectedProvider>[] = detected.map((p) => ({
    value: p,
    label: `${p.displayName}${p.detected ? "" : " (not found)"}`,
    hint: p.support === "native-plugin" ? `${p.version ? `${p.version} · ` : ""}${p.note}` : p.note,
    disabled: p.support !== "native-plugin",
  }));
  const initial = new Set(detected.map((p, i) => (p.support === "native-plugin" && p.detected ? i : -1)).filter((i) => i >= 0));
  const picked = await selectMany(runtime, mode, "Which agents should use Pathrule?", choices, initial);
  if (!picked || picked.length === 0) {
    out.write("Nothing selected; nothing changed.\n");
    return 0;
  }
  const scope = await selectOne<IntegrationScope>(runtime, mode, "Where?", [
    { value: "user", label: "All my projects", hint: "(user-wide)" },
    { value: "project", label: `Only this project`, hint: `(${runtime.cwd})` },
  ]);
  if (!scope) return 0;
  const currentMode = chosenMode(ctx, { ...parsed, scope });
  const runMode =
    ctx.flags.cloud || ctx.flags.local
      ? ctx.flags.cloud
        ? "cloud"
        : "local"
      : await selectOne<IntegrationMode>(
          runtime,
          mode,
          "Which edition should this setup prepare? (Each project keeps its own.)",
          [
            { value: "local", label: "Pathrule Local", hint: "(this machine, no account)" },
            { value: "cloud", label: "Pathrule Cloud", hint: "(sign in, shared with your team)" },
          ],
          currentMode === "cloud" ? 1 : 0,
        );
  if (!runMode) return 0;

  const host = await cliIntegrationHost(runtime.env, { runtime });
  const request = { ...parsed, scope };
  const plans = await Promise.all(
    picked.map((p) =>
      planIntegration(requestFor(p.id as IntegrationProviderId, request, runMode, runtime.cwd, "install"), host),
    ),
  );
  out.write(`\nRuntime: Pathrule ${host.runtimeVersion}${manifest ? ` (manifest says ${manifest.runtime_version})` : " (first setup on this machine)"}\n`);
  out.write("\nThis is exactly what will change:\n\n");
  for (const plan of plans) out.write(`${renderPlan(plan, mode)}\n\n`);
  if (plans.every((p) => p.blocked)) return 1;
  if (runsFromTemporaryCache(runtime.env)) out.write(`${TEMPORARY_CACHE_NOTE}\n`);
  if (!(await confirm(runtime, "Apply these changes?"))) {
    out.write("Nothing changed.\n");
    return 0;
  }
  const handed = await handOver(
    ctx,
    [
      "integrations",
      "add",
      ...picked.map((p) => p.id),
      "--scope",
      scope,
      ...(request.project ? ["--project", request.project] : scope === "project" ? ["--project", runtime.cwd] : []),
      runMode === "cloud" ? "--cloud" : "--local",
      ...(request.maintenance ? [] : ["--no-maintenance"]),
      "--yes",
    ],
    false,
  );
  if (handed) return handed.exitCode;
  const results = await applyAll(plans.filter((p) => !p.blocked), host);
  for (const [i, r] of results.entries()) {
    out.write(`\n${label(plans.filter((p) => !p.blocked)[i]!.request.provider)}:\n${renderApply(r, mode)}\n`);
  }
  const doctor = await diagnoseIntegrations(host, runtime.cwd);
  const problems = doctor.findings.filter((f) => f.level !== "ok");
  out.write(problems.length === 0 ? `\n${statusLabel("ok", mode)} Verified: every recorded integration is in place.\n` : "\n");
  for (const f of problems) out.write(`${statusLabel(f.level === "error" ? "error" : "warn", mode)} ${f.message}${f.fix ? ` Fix: ${f.fix}` : ""}\n`);
  return results.every((r) => r.ok) ? 0 : 1;
}

// ─── Command ────────────────────────────────────────────────────────────────

async function run(ctx: CliCommandContext): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(ctx.args);
  } catch (err) {
    ctx.runtime.stderr.write(`${statusLabel("error", ctx.mode)} ${err instanceof Error ? err.message : String(err)}\n${USAGE}\n`);
    return 64;
  }
  const sub = parsed.sub;
  if ((sub === "" || sub === "setup") && canAsk(ctx.runtime, ctx.mode)) return wizard(ctx, parsed);
  if (sub === "add" && parsed.providers.length === 0 && canAsk(ctx.runtime, ctx.mode)) return wizard(ctx, parsed);
  if (sub === "add" && !ctx.flags.yes && !parsed.dryRun && canAsk(ctx.runtime, ctx.mode)) {
    // Interactive add: show the plan, ask, apply.
    const host = await cliIntegrationHost(ctx.runtime.env, { runtime: ctx.runtime });
    const plans = await plansFor(ctx, parsed, host, nativeProviders(parsed.providers));
    for (const plan of plans) ctx.runtime.stdout.write(`${renderPlan(plan, ctx.mode)}\n\n`);
    if (runsFromTemporaryCache(ctx.runtime.env)) ctx.runtime.stdout.write(`${TEMPORARY_CACHE_NOTE}\n`);
    if (!(await confirm(ctx.runtime, "Apply these changes?"))) return 0;
    const handed = await handOver(ctx, stableArgs(ctx, ["--yes"]), false);
    if (handed) return handed.exitCode;
    const results = await applyAll(plans, host);
    results.forEach((r) => ctx.runtime.stdout.write(`${renderApply(r, ctx.mode)}\n`));
    return results.every((r) => r.ok) ? 0 : 1;
  }
  const result = await dispatchJson(ctx);
  const env = result.envelope;
  const data = (env.data ?? {}) as Record<string, unknown>;
  const out = ctx.runtime.stdout;
  if (!env.ok && env.error && env.error.code !== "approval_required") {
    ctx.runtime.stderr.write(`${statusLabel("error", ctx.mode)} ${env.error.message}\n`);
  }
  switch (sub || "list") {
    case "list":
    case "status": {
      const d = data as Awaited<ReturnType<typeof list>>;
      out.write("Coding agents on this machine:\n");
      for (const p of d.providers) {
        out.write(`  ${p.detected ? statusLabel("ok", ctx.mode) : "    "} ${p.displayName}${p.version ? ` (${p.version})` : ""}: ${p.note}\n`);
      }
      out.write(`\nPathrule runtime: ${d.runtime ? `${d.runtime.runtime_version} (${d.runtime.mode ?? "mode not chosen"})` : "not described yet"}\n`);
      out.write(d.integrations.length === 0 ? "No integrations yet. Run: pathrule integrations\n" : "Integrations:\n");
      for (const r of d.integrations) out.write(`  ${r.id}: ${r.channel}, ${r.mode}, ${r.status}\n`);
      break;
    }
    case "add":
    case "plan":
    case "repair": {
      for (const plan of (data.plans as Array<ReturnType<typeof planJson>>) ?? []) {
        out.write(`${renderPlan(plan as unknown as IntegrationPlan, ctx.mode)}\n\n`);
      }
      if (data.runtime_provisioning) out.write(`${String(data.runtime_provisioning)}\n`);
      if (data.approval_required) out.write("Nothing changed. Run again with --yes to apply this plan.\n");
      for (const r of (data.results as ApplyResult[] | undefined) ?? []) out.write(`${renderApply(r, ctx.mode)}\n`);
      break;
    }
    case "remove": {
      if (data.approval_required) {
        out.write(`Would remove: ${JSON.stringify(data.would_remove, null, 2)}\nRun again with --yes.\n`);
      }
      for (const r of (data.results as Array<{ provider: string; removed: string[]; kept: string[]; errors: string[] }> | undefined) ?? []) {
        for (const x of r.removed) out.write(`  ${statusLabel("ok", ctx.mode)} removed ${x}\n`);
        for (const x of r.kept) out.write(`  ${statusLabel("info", ctx.mode)} kept ${x}\n`);
        for (const x of r.errors) out.write(`  ${statusLabel("error", ctx.mode)} ${x}\n`);
      }
      break;
    }
    case "doctor": {
      const findings = (data.findings as Array<{ level: string; message: string; fix?: string }>) ?? [];
      if (findings.length === 0) out.write(`${statusLabel("ok", ctx.mode)} No problems found.\n`);
      for (const f of findings) {
        const kind = f.level === "error" ? "error" : f.level === "warn" ? "warn" : "ok";
        out.write(`${statusLabel(kind, ctx.mode)} ${f.message}${f.fix ? ` Fix: ${f.fix}` : ""}\n`);
      }
      break;
    }
    case "attach":
      for (const s of (data.summary as string[] | undefined) ?? []) out.write(`  ${statusLabel("ok", ctx.mode)} ${s}\n`);
      break;
  }
  return result.exitCode;
}

export const integrationsCommand: CliCommand = {
  name: "integrations",
  help: { section: "workspace-setup", rank: 25, summary: "Connect Pathrule to your coding agents (Claude Code, Codex)", usage: [USAGE.slice("Usage: ".length)] },
  jsonRank: 155,
  run,
  json: dispatchJson,
};
