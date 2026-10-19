// SPDX-License-Identifier: Apache-2.0
// `pathrule index refresh` and `pathrule learning drain`: the maintenance the hook asks for in the
// background (with the person's consent, recorded by setup) so Pathrule Local works without any MCP
// server. Either can be run by hand.
//
//   pathrule index refresh  [--workspace <id>] [--cwd <dir>] [--quiet] [--json]
//   pathrule learning drain [--workspace <id>] [--cwd <dir>] [--quiet] [--json]
import { drainLearningEvidence, refreshLocalIndex, resolveMaintenanceTarget } from "../local/maintenance.js";
import { jsonEnvelope, statusLabel } from "../output.js";
import type { CliCommand, CliCommandContext, CliJsonResult } from "../plugin.js";

interface MaintenanceArgs {
  sub: string | null;
  workspaceId: string | null;
  cwd: string | null;
  quiet: boolean;
}

function parseArgs(args: readonly string[], cwd: string): MaintenanceArgs {
  const out: MaintenanceArgs = { sub: null, workspaceId: null, cwd: null, quiet: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--workspace") out.workspaceId = args[++i] ?? null;
    else if (arg === "--cwd") out.cwd = args[++i] ?? null;
    else if (arg === "--quiet") out.quiet = true;
    else if (!arg.startsWith("--") && out.sub === null) out.sub = arg;
  }
  if (!out.workspaceId && !out.cwd) out.cwd = cwd;
  return out;
}

async function runJob(ctx: CliCommandContext, job: "index" | "learning"): Promise<CliJsonResult> {
  const args = parseArgs(ctx.args, ctx.runtime.cwd);
  const expected = job === "index" ? "refresh" : "drain";
  const command = `${job} ${expected}`;
  if (args.sub !== expected) {
    return {
      exitCode: 64,
      envelope: jsonEnvelope({
        command,
        cwd: ctx.runtime.cwd,
        ok: false,
        error: { code: "usage", message: `Usage: pathrule ${job} ${expected} [--workspace <id>] [--cwd <dir>] [--quiet] [--json]` },
      }),
    };
  }
  const target = await resolveMaintenanceTarget(ctx.runtime.env, { workspaceId: args.workspaceId, cwd: args.cwd });
  if ("error" in target) {
    // Not a local workspace (or a cloud workspace's mirror): nothing to maintain here, and no error.
    return {
      exitCode: 0,
      envelope: jsonEnvelope({ command, cwd: ctx.runtime.cwd, ok: true, data: { skipped: target.error } }),
    };
  }
  const result =
    job === "index"
      ? await refreshLocalIndex(ctx.runtime.env, target)
      : await drainLearningEvidence(ctx.runtime.env, target);
  return {
    exitCode: result.ok ? 0 : 1,
    envelope: jsonEnvelope({
      command,
      cwd: ctx.runtime.cwd,
      ok: result.ok,
      data: { workspace_id: target.workspaceId, ...result },
      ...(result.ok ? {} : { error: { code: `${job}_failed`, message: result.error ?? "failed" } }),
    }),
  };
}

function command(job: "index" | "learning", summary: string, rank: number, jsonRank: number): CliCommand {
  return {
    name: job,
    help: { section: "diagnostics", rank, summary },
    jsonRank,
    quiet: true,
    json: (ctx) => runJob(ctx, job),
    run: async (ctx) => {
      const quiet = ctx.args.includes("--quiet");
      const result = await runJob(ctx, job);
      const env = result.envelope;
      if (!env.ok) {
        ctx.runtime.stderr.write(`${statusLabel("error", ctx.mode)} ${env.error?.message ?? "failed"}\n`);
      } else if (!quiet) {
        const data = env.data as Record<string, unknown>;
        const line = data.skipped
          ? `Nothing to do here (${String(data.skipped)}).`
          : job === "index"
            ? `Hook index refreshed for ${String(data.workspace_id)}.`
            : `Processed ${String(data.observed)} observation(s) for ${String(data.workspace_id)}.`;
        ctx.runtime.stdout.write(`${statusLabel("ok", ctx.mode)} ${line}\n`);
      }
      return result.exitCode;
    },
  };
}

export const indexCommand = command("index", "Refresh this workspace's hook index from the local store", 60, 297);
export const learningCommand = command("learning", "Process the evidence the hook captured into the local store", 70, 298);
