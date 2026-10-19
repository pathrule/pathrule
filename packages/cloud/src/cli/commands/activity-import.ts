// SPDX-License-Identifier: Apache-2.0
// `pathrule activity import --from-local`: copies this folder's Pathrule Local activity into the
// Pathrule Cloud workspace the folder is attached to. Local
// promises that its data stays on the machine, so this runs only when the person asks, says first
// what would leave, sends nothing on --dry-run, and asks before sending unless given --yes. The
// server derives each entry's id, so a retry or a second run copies nothing twice; --undo removes
// the copy.
import type { CliCommandContext } from "@pathrule/cli/plugin.js";
import {
  localActivitySourceFor,
  readLocalActivity,
  type LocalActivityRow,
  type LocalActivitySource,
} from "@pathrule/core/backend/local/activity-export.js";
import { activityFiles } from "@pathrule/core/local-ui/activity-route.js";

import { CloudHttpError } from "../../native/client/http.js";
import type { NativeWorkspaceEntry } from "../../native/workspaces.js";
import { NativeCloudError, type NativeSessionContext } from "../../native/tenancy.js";
import { promptYesNo } from "./interaction.js";
import type { NativeOutcome } from "./native-commands.js";

const DAY_MS = 86_400_000;
/** Pathrule Cloud keeps activity this long; older entries would be deleted on arrival. */
const MAX_DAYS = 180;
/** What one request may carry (the route's ACTIVITY_IMPORT_MAX_ENTRIES), and its size. */
const BATCH_ENTRIES = 50;
const BATCH_BYTES = 200 * 1024;
const RETRIES = 2;
const USAGE =
  "Usage: pathrule activity import --from-local [--days 1-180] [--dry-run] [--undo] [--yes]";
const LEAVES =
  "Leaves this machine: the summary, folder, subjects, workspace-relative file paths, kind of work and AI client of each entry.";
const COPY = { label: "Copy them", command: "pathrule activity import --from-local --yes" };

interface ImportResult {
  imported: number;
  already_present: number;
  skipped: { too_old: number; invalid: number };
  storage_full: boolean;
}

interface Options {
  days: number;
  dryRun: boolean;
  undo: boolean;
}

function options(args: string[]): Options {
  const [sub, ...rest] = args;
  if (sub !== "import" || !rest.includes("--from-local"))
    throw new NativeCloudError("invalid_args", USAGE);
  let days = MAX_DAYS;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--from-local" || arg === "--dry-run" || arg === "--undo") continue;
    const n = Number(rest[i + 1]);
    if (arg !== "--days" || !Number.isInteger(n) || n < 1 || n > MAX_DAYS)
      throw new NativeCloudError("invalid_args", USAGE);
    days = n;
    i += 1;
  }
  return { days, dryRun: rest.includes("--dry-run"), undo: rest.includes("--undo") };
}

/**
 * An entry's files as the route takes them: workspace-relative, never a path outside the Local
 * workspace's root (`activityFiles`), whichever shape the Local store kept.
 */
function filesOf(raw: unknown, root: string): { total: number; by_area: Record<string, string[]> } {
  const byArea = (raw as { by_area?: unknown } | null)?.by_area;
  const areas: Record<string, string[]> = {};
  if (byArea && typeof byArea === "object" && !Array.isArray(byArea)) {
    for (const [area, paths] of Object.entries(byArea)) {
      const kept = activityFiles(paths, root);
      if (kept.length > 0) areas[area] = kept;
    }
  } else {
    const kept = activityFiles(raw, root);
    if (kept.length > 0) areas.files = kept;
  }
  return { total: Object.values(areas).reduce((n, paths) => n + paths.length, 0), by_area: areas };
}

function entryOf(row: LocalActivityRow, root: string): Record<string, unknown> {
  return {
    source_id: row.id,
    created_at: row.createdAt,
    ...(row.nodePath ? { node_path: row.nodePath } : {}),
    domain: row.domain,
    action: row.action,
    scope: row.scope,
    subjects: Array.isArray(row.subjects)
      ? row.subjects.filter((s): s is string => typeof s === "string")
      : [],
    task_summary: row.taskSummary ?? "",
    files_touched: filesOf(row.filesTouched, root),
    ...(row.aiClient ? { ai_client: row.aiClient } : {}),
    ...(row.provenance && typeof row.provenance === "object" ? { provenance: row.provenance } : {}),
  };
}

function batches(entries: Record<string, unknown>[]): Record<string, unknown>[][] {
  const out: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (current.length > 0 && (current.length >= BATCH_ENTRIES || bytes + size > BATCH_BYTES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** One request, retried after a network failure or a server error; a refusal is final. */
async function send<T>(
  ctx: CliCommandContext,
  session: NativeSessionContext,
  path: string,
  body: unknown,
  method: "POST" | "DELETE",
): Promise<T> {
  const sleep = ctx.runtime.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await session.request<T>(path, body, method);
    } catch (err) {
      if (attempt >= RETRIES || (err instanceof CloudHttpError && err.status < 500)) throw err;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

async function confirmed(ctx: CliCommandContext, question: string): Promise<boolean> {
  if (ctx.flags.yes) return true;
  if (!ctx.mode.interactive)
    throw new NativeCloudError(
      "confirmation_required",
      "Nothing can ask here: run it again with --yes.",
    );
  return promptYesNo(ctx.runtime, question, false);
}

const day = (iso: string) => iso.slice(0, 10);
const entries = (n: number) => `${n} Local ${n === 1 ? "entry" : "entries"}`;

/** Whether this folder has Local activity Pathrule Cloud would keep: the hint after attaching. */
export function hasLocalActivity(cwd: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const source = localActivitySourceFor(cwd, env);
    const since = new Date(Date.now() - MAX_DAYS * DAY_MS).toISOString();
    return source !== null && readLocalActivity(source, since, env).length > 0;
  } catch {
    // A store this build cannot read only loses the hint, never the attach.
    return false;
  }
}

export async function activityCommand(
  ctx: CliCommandContext,
  session: NativeSessionContext,
  served: NativeWorkspaceEntry,
): Promise<NativeOutcome> {
  const opts = options(ctx.args);
  const source: LocalActivitySource | null = localActivitySourceFor(
    ctx.runtime.cwd,
    ctx.runtime.env,
  );
  const workspace = { id: served.workspace_id, name: served.name };
  if (!source)
    return {
      data: { workspace, local: null },
      lines: [
        "No Pathrule Local workspace serves this folder: there is no Local activity to copy.",
      ],
    };
  const path = `/v1/workspaces/${encodeURIComponent(served.workspace_id)}/activity/import`;
  const local = { workspace_id: source.workspaceId };
  if (opts.undo) {
    if (!(await confirmed(ctx, `Remove the Local activity you copied to "${served.name}"?`)))
      return { data: { workspace, local, deleted: 0 }, lines: ["Nothing was removed."] };
    const { deleted } = await send<{ deleted: number }>(
      ctx,
      session,
      path,
      { source: { kind: "local", workspace_id: source.workspaceId } },
      "DELETE",
    );
    return {
      data: { workspace, local, deleted },
      lines: [`Removed ${entries(deleted)} copied to "${served.name}".`],
    };
  }
  const since = new Date(Date.now() - opts.days * DAY_MS).toISOString();
  const rows = readLocalActivity(source, since, ctx.runtime.env);
  if (rows.length === 0)
    return {
      data: { workspace, local, entries: 0 },
      lines: [`No Local activity for this folder in the last ${opts.days} days.`],
    };
  const period = { from: rows[0]!.createdAt, to: rows[rows.length - 1]!.createdAt };
  const summary = [
    `${entries(rows.length)} from ${day(period.from)} to ${day(period.to)} can be copied to "${served.name}".`,
    LEAVES,
    "Entries keep their times. Running this again copies nothing twice.",
  ];
  if (opts.dryRun)
    return {
      data: { workspace, local, dry_run: true, entries: rows.length, ...period },
      lines: summary,
      next: [COPY],
    };
  if (!ctx.flags.yes && ctx.mode.interactive)
    for (const line of summary) ctx.runtime.stdout.write(`${line}\n`);
  if (!(await confirmed(ctx, "Copy them?")))
    return {
      data: { workspace, local, entries: rows.length, copied: false },
      lines: ["Nothing was copied."],
    };
  const totals = { imported: 0, already_present: 0, too_old: 0, invalid: 0 };
  let storageFull = false;
  for (const batch of batches(rows.map((row) => entryOf(row, source.root)))) {
    const result = await send<ImportResult>(
      ctx,
      session,
      path,
      { source: { kind: "local", workspace_id: source.workspaceId }, entries: batch },
      "POST",
    );
    totals.imported += result.imported;
    totals.already_present += result.already_present;
    totals.too_old += result.skipped.too_old;
    totals.invalid += result.skipped.invalid;
    if (result.storage_full) {
      storageFull = true;
      break;
    }
  }
  const counts = `${totals.already_present} already there, ${totals.too_old} too old, ${totals.invalid} unreadable`;
  return {
    data: { workspace, local, entries: rows.length, ...totals, storage_full: storageFull },
    lines: storageFull
      ? [
          `Copied ${entries(totals.imported)} to "${served.name}" (${counts}), then stopped.`,
          "Your organization's storage is full: free space or upgrade, then run this again to copy the rest.",
        ]
      : [`Copied ${entries(totals.imported)} to "${served.name}" (${counts}).`],
    ...(storageFull ? { exitCode: 1 } : {}),
  };
}
