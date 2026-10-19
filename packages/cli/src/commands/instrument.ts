// SPDX-License-Identifier: Apache-2.0
// `pathrule instrument`: an application's runtime events from the terminal. `events` is open: it
// reads the groups the application sent to this folder's local workspace (Pathrule Local, no
// account), with the filters the MCP tool takes. An account edition adds its own subcommands
// (`status`, `keys`, `sdk`) and may answer `events` for its workspaces.
//
// What an application sent is untrusted: it is printed as one bounded line per value, after a
// notice, and never as anything else.
import {
  runtimeEventsHandler,
  type RuntimeEventsArgs,
  type RuntimeEventsView,
  type RuntimeGroupView,
} from "@pathrule/core/tools/runtime-events.js";
import { resolveLocalPrincipal } from "@pathrule/core";

import { withCliHostSession } from "../local/host-session.js";
import { jsonEnvelope, statusLabel, type CliOutputMode } from "../output.js";
import {
  cliPlugins,
  type CliCommand,
  type CliCommandContext,
  type CliJsonResult,
} from "../plugin.js";

export const INSTRUMENT_EVENTS_USAGE =
  "Usage: pathrule instrument events [--path <path>] [--kind error|event] [--environment development|preview|production] [--status active|declared|resolved|archived] [--verification unobserved|observing|quiet|verified|recurred] [--group <id>] [--limit <n>] [--cursor <cursor>]";

class UsageError extends Error {}

const FLAGS: Record<string, keyof RuntimeEventsArgs> = {
  "--path": "path",
  "--kind": "kind",
  "--environment": "environment",
  "--status": "status",
  "--verification": "verification",
  "--group": "group_id",
  "--limit": "limit",
  "--cursor": "cursor",
};

/** The flags after `events`, as the handler's arguments (the workspace comes from the folder). */
export function parseEventsArgs(args: readonly string[]): Omit<RuntimeEventsArgs, "workspace_id"> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const [flag, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    const key = FLAGS[flag];
    if (!key) throw new UsageError(INSTRUMENT_EVENTS_USAGE);
    const value = inline ?? args[(i += 1)];
    if (value === undefined || value === "") throw new UsageError(INSTRUMENT_EVENTS_USAGE);
    out[key] = key === "limit" ? Number(value) : value;
  }
  return out as Omit<RuntimeEventsArgs, "workspace_id">;
}

export type EventsOutcome =
  | { ok: true; workspaceId: string; view: RuntimeEventsView }
  | { ok: false; code: string; message: string; exitCode: number };

/** Reads this folder's local workspace through the host. */
export async function readLocalRuntimeEvents(
  ctx: CliCommandContext,
  args: readonly string[],
): Promise<EventsOutcome> {
  let query: Omit<RuntimeEventsArgs, "workspace_id">;
  try {
    query = parseEventsArgs(args);
  } catch (err) {
    return { ok: false, code: "usage", message: (err as Error).message, exitCode: 64 };
  }
  return withCliHostSession(ctx.runtime.env, async (session) => {
    const match = session.resolveLocal(ctx.runtime.cwd);
    if (!match) {
      return {
        ok: false as const,
        code: "workspace_not_found",
        message:
          "No local Pathrule workspace covers this folder. Run `pathrule init --local` here first.",
        exitCode: 1,
      };
    }
    const backend = await session.store(match.workspaceId);
    const result = await runtimeEventsHandler(
      { backend, userId: resolveLocalPrincipal(ctx.runtime.env), workspaceId: match.workspaceId },
      { ...query, workspace_id: match.workspaceId },
    );
    if (!result.ok) {
      return {
        ok: false as const,
        code: result.error.code,
        message: result.error.message,
        exitCode: 1,
      };
    }
    return { ok: true as const, workspaceId: match.workspaceId, view: result.data };
  });
}

function groupLines(group: RuntimeGroupView): string[] {
  const where = [
    group.environment,
    group.path ?? "(no path)",
    group.flow ? `flow ${group.flow}` : null,
  ]
    .filter(Boolean)
    .join("  ");
  const verification =
    group.correction === null
      ? "no fix recorded"
      : `fix ${group.correction.attempt_id}: ${group.verification.state}${
          group.verification.fresh === false ? " (stale: the newer release stopped sending)" : ""
        }${group.verification.blocked_reason ? ` (${group.verification.blocked_reason})` : ""}`;
  return [
    `  ${group.kind} ${group.id}  r${group.revision}  ${group.status}  ${where}`,
    `      ${group.occurrences} occurrence(s), last ${group.last_seen}${group.release ? `, release ${group.release}` : ", no release"}; ${verification}`,
    ...(group.untrusted_observation.message
      ? [`      reported: ${group.untrusted_observation.message}`]
      : []),
  ];
}

export function renderEvents(
  outcome: Extract<EventsOutcome, { ok: true }>,
  mode: CliOutputMode,
): string {
  const { view } = outcome;
  const lines = [
    `${statusLabel("info", mode)} Runtime events (${view.source}, workspace ${outcome.workspaceId})`,
  ];
  if (view.groups.length === 0) {
    lines.push("  None match.");
  } else {
    lines.push(`  ${view.notice}`);
    for (const group of view.groups) lines.push(...groupLines(group));
    if (view.next_cursor) lines.push(`  More: --cursor ${view.next_cursor}`);
  }
  if (view.coverage && view.coverage.length > 0) {
    lines.push("  Releases sending:");
    for (const r of view.coverage) {
      lines.push(
        `    ${r.environment}  ${r.release ?? "(no release identity: fixes cannot be verified)"}  ${r.envelopes} envelope(s), last ${r.last_seen}`,
      );
    }
  }
  if (view.history) {
    lines.push("  History:");
    for (const h of view.history) {
      lines.push(
        `    ${h.at}  ${h.event}  ${h.from ?? "-"} -> ${h.to}  r${h.revision}${h.release ? `  ${h.release}` : ""}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Reads the runtime events `args` ask for: this folder's local workspace, unless a plugin serves it. */
export type ReadRuntimeEvents = (
  ctx: CliCommandContext,
  args: readonly string[],
) => Promise<EventsOutcome>;

export async function renderEventsCommand(
  ctx: CliCommandContext,
  args: readonly string[],
  read: ReadRuntimeEvents = readLocalRuntimeEvents,
): Promise<number> {
  const outcome = await read(ctx, args);
  if (!outcome.ok) {
    ctx.runtime.stderr.write(`${statusLabel("error", ctx.mode)} ${outcome.message}\n`);
    return outcome.exitCode;
  }
  ctx.runtime.stdout.write(renderEvents(outcome, ctx.mode));
  return 0;
}

export async function eventsJson(
  ctx: CliCommandContext,
  args: readonly string[],
  read: ReadRuntimeEvents = readLocalRuntimeEvents,
): Promise<CliJsonResult> {
  const outcome = await read(ctx, args);
  const command = "instrument events";
  if (!outcome.ok) {
    return {
      exitCode: outcome.exitCode,
      envelope: jsonEnvelope({
        command,
        cwd: ctx.runtime.cwd,
        ok: false,
        error: { code: outcome.code, message: outcome.message },
      }),
    };
  }
  return {
    exitCode: 0,
    envelope: jsonEnvelope({
      command,
      cwd: ctx.runtime.cwd,
      ok: true,
      data: { workspace_id: outcome.workspaceId, ...outcome.view },
    }),
  };
}

/** The subcommand this run answers: a plugin's first (it may serve `events` for its workspaces). */
function subcommand(ctx: CliCommandContext) {
  const added = (name: string) =>
    cliPlugins().find((p) => p.subcommands?.instrument?.[name])?.subcommands?.instrument?.[name];
  const first = ctx.args[0];
  if (first && !first.startsWith("--"))
    return { name: first, added: added(first), rest: ctx.args.slice(1) };
  // No subcommand: an account edition's `status`, else the open `events`.
  if (added("status")) return { name: "status", added: added("status"), rest: ctx.args };
  return { name: "events", added: undefined, rest: ctx.args };
}

function unknown(name: string): string {
  const names = [
    "events",
    ...cliPlugins().flatMap((p) => Object.keys(p.subcommands?.instrument ?? {})),
  ];
  return `Unknown instrument subcommand "${name}". Available: ${[...new Set(names)].join(", ")}. ${INSTRUMENT_EVENTS_USAGE}`;
}

export const instrumentCommand: CliCommand = {
  name: "instrument",
  help: {
    section: "workspace-setup",
    rank: 80,
    summary: "Show the runtime events an application reported to this folder's workspace",
    usage: [INSTRUMENT_EVENTS_USAGE.slice("Usage: ".length)],
  },
  jsonRank: 296,
  run: async (ctx) => {
    const sub = subcommand(ctx);
    if (sub.added) return sub.added.run(ctx);
    if (sub.name === "events") return renderEventsCommand(ctx, sub.rest);
    ctx.runtime.stderr.write(`${statusLabel("error", ctx.mode)} ${unknown(sub.name)}\n`);
    return 64;
  },
  json: async (ctx) => {
    const sub = subcommand(ctx);
    if (sub.added?.json) return sub.added.json(ctx);
    if (sub.added) {
      return {
        exitCode: 64,
        envelope: jsonEnvelope({
          command: `instrument ${sub.name}`,
          cwd: ctx.runtime.cwd,
          ok: false,
          error: {
            code: "unsupported_json",
            message: `pathrule instrument ${sub.name} has no --json form.`,
          },
        }),
      };
    }
    if (sub.name === "events") return eventsJson(ctx, sub.rest);
    return {
      exitCode: 64,
      envelope: jsonEnvelope({
        command: "instrument",
        cwd: ctx.runtime.cwd,
        ok: false,
        error: { code: "usage", message: unknown(sub.name) },
      }),
    };
  },
};
