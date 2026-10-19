// SPDX-License-Identifier: Apache-2.0
// The account commands when the build or the run names Pathrule Cloud (native/config.ts). They read
// and change the person's organizations and workspaces on the Worker's `/v1` routes, keep the folders
// they attach on this machine (native/workspaces.ts). A command Pathrule Cloud has no service for
// says so instead (`notOnPathruleCloud`).
//
// login, logout, whoami and status run their own native paths (./native-account.ts); every other
// account command comes here (../plugin.ts `nativeAware`).
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Writable } from "node:stream";

import { updateUserConfig } from "@pathrule/core/storage/config-store.js";
import {
  jsonEnvelope,
  statusLabel,
  type CliNextStep,
  type CliOutputMode,
} from "@pathrule/cli/output.js";
import type { CliCommandContext, CliJsonResult, CliRuntime } from "@pathrule/cli/plugin.js";

import { folderConflictMessage } from "@pathrule/core/workspace/folder-mode.js";

import { folderModeHere } from "../../native/auto-attach.js";
import { CloudHttpError } from "../../native/client/http.js";
import { nativeCloudConfig } from "../../native/config.js";
import { readNativeSession } from "../../native/credentials.js";
import { nativeWorkspaceFor, readNativeWorkspaces } from "../../native/workspaces.js";
import {
  currentOrganization,
  findWorkspace,
  NativeCloudError,
  nativeSession as nativeCloudSession,
  organizations,
  pick,
  workspacesOf,
  type NativeSessionContext,
} from "../../native/tenancy.js";
import { openRuntimeUrl, promptYesNo } from "./interaction.js";
// The folder's own binding (attach, detach, setup, init) lives in ./native-folder.ts.
import {
  attachedHere,
  attachHere,
  create,
  detach,
  folderFreeForCloud,
  setupFolder,
} from "./native-folder.js";

export { NativeCloudError as NativeCommandError };
export { attachedHere };
export { nativeInit } from "./native-folder.js";

export type { NativeSessionContext };

/** The signed-in person for a CLI run. */
export const nativeSession = (cli: CliRuntime): Promise<NativeSessionContext> =>
  nativeCloudSession({ env: cli.env, ...(cli.fetch ? { fetch: cli.fetch } : {}) });

/** What a native command did: its data for `--json`, its lines for a person. */
export interface NativeOutcome {
  data?: unknown;
  lines: string[];
  /** Writes the result for a person instead of `lines` (rows of knowledge). */
  render?: (stdout: Pick<Writable, "write">, mode: CliOutputMode) => void;
  next?: CliNextStep[];
  /** A run that did its work but reports a problem (a sync with errors). */
  exitCode?: number;
}

/** The console the person manages their account in. */
export function consoleUrl(env: NodeJS.ProcessEnv, path = ""): string {
  const base = (env.PATHRULE_WEB_URL ?? "https://app.pathrule.io").replace(/\/$/, "");
  return `${base}/console${path}`;
}

const notOnPathruleCloud = (command: string, why: string): never => {
  throw new NativeCloudError(
    "not_on_pathrule_cloud",
    `pathrule ${command} is not available on Pathrule Cloud: ${why}`,
  );
};

async function org(ctx: CliCommandContext, session: NativeSessionContext): Promise<NativeOutcome> {
  const sub = ctx.args[0] ?? "list";
  const env = ctx.runtime.env;
  if (sub === "list") {
    const all = await organizations(session.request);
    const current = await currentOrganization(session, env, false);
    return {
      data: { organizations: all, current_org_id: current?.id ?? null },
      lines: all.length
        ? all.map(
            (o) =>
              `${o.id === current?.id ? "*" : " "} ${o.name} · ${o.role} · ${o.plan ?? "unknown plan"} (${o.id})`,
          )
        : ["You have no organization yet. Create one: pathrule org create <name>"],
    };
  }
  if (sub === "current" || sub === "show") {
    const current = await currentOrganization(session, env, true);
    return {
      data: current,
      lines: [`${current!.name} · ${current!.role} · ${current!.plan ?? "unknown plan"}`],
    };
  }
  if (sub === "use") {
    const selector = ctx.args[1];
    if (!selector)
      throw new NativeCloudError(
        "organization_required",
        "Name the organization: pathrule org use <name-or-id>",
      );
    const found = pick(await organizations(session.request), selector);
    if (!found)
      throw new NativeCloudError("organization_not_found", `No organization "${selector}".`);
    await updateUserConfig(session.userId, { current_org_id: found.id }, env);
    return { data: found, lines: [`Using organization "${found.name}".`] };
  }
  if (sub === "create") {
    const name = ctx.args.slice(1).join(" ").trim();
    if (!name)
      throw new NativeCloudError(
        "name_required",
        "Name the organization: pathrule org create <name>",
      );
    const created = await session.request<{ id: string; name: string }>(
      "/v1/organizations",
      { name },
      "POST",
      randomUUID(),
    );
    await updateUserConfig(session.userId, { current_org_id: created.id }, env);
    return { data: created, lines: [`Created organization "${created.name}" and chose it.`] };
  }
  throw new NativeCloudError(
    "unknown_subcommand",
    `Unknown org command: ${sub}. Use list, current, use or create.`,
  );
}

async function workspace(
  ctx: CliCommandContext,
  session: NativeSessionContext,
  sub = ctx.args[0] ?? "list",
  args = ctx.args.slice(1),
): Promise<NativeOutcome> {
  const env = ctx.runtime.env;
  if (sub === "list") {
    const current = await currentOrganization(session, env, true);
    const items = await workspacesOf(session.request, current!.id);
    const attached = await readNativeWorkspaces(session.userId, env);
    return {
      data: {
        organization: current,
        workspaces: items.map((w) => ({
          ...w,
          root: attached.find((e) => e.workspace_id === w.id)?.root ?? null,
        })),
      },
      lines: items.length
        ? items.map((w) => {
            const root = attached.find((e) => e.workspace_id === w.id)?.root;
            return `- ${w.name} (${w.id})${root ? ` · attached at ${root}` : ""}`;
          })
        : [`No workspaces in "${current!.name}" yet. Create one for this folder: pathrule init`],
    };
  }
  if (sub === "current") {
    const served = await attachedHere(session, ctx.runtime);
    return {
      data: served,
      lines: [`${served.name} (${served.workspace_id}) · attached at ${served.root}`],
    };
  }
  if (sub === "use" || sub === "attach" || sub === "create") {
    const selector = args[0];
    if (sub !== "create" && !selector)
      throw new NativeCloudError(
        "workspace_required",
        "Name the workspace: pathrule attach <name-or-id>",
      );
    const before = folderFreeForCloud(ctx.runtime);
    const outcome =
      sub === "create"
        ? await create(ctx.runtime, session, args.join(" ").trim() || basename(ctx.runtime.cwd))
        : await attachHere(session, ctx.runtime, await findWorkspace(session, env, selector!));
    return before.mode === "local"
      ? {
          ...outcome,
          lines: [
            ...outcome.lines,
            "This folder now uses Pathrule Cloud; other folders keep this machine's default, Pathrule Local.",
          ],
        }
      : outcome;
  }
  if (sub === "detach") return detach(ctx.runtime, session);
  if (sub === "open") {
    const served = await attachedHere(session, ctx.runtime);
    return opened(ctx, consoleUrl(env, `/w/${encodeURIComponent(served.workspace_id)}/signals`));
  }
  throw new NativeCloudError(
    "unknown_subcommand",
    `Unknown workspace command: ${sub}. Use list, current, use, create, attach, detach or open.`,
  );
}

async function team(ctx: CliCommandContext, session: NativeSessionContext): Promise<NativeOutcome> {
  if (ctx.args.includes("open") || ctx.args.includes("--open"))
    return opened(ctx, consoleUrl(ctx.runtime.env, "/members"));
  const current = await currentOrganization(session, ctx.runtime.env, true);
  const id = encodeURIComponent(current!.id);
  const members = (
    await session.request<{
      items: { user_id: string; role: string; email: string | null; name: string | null }[];
    }>(`/v1/organizations/${id}/members`)
  ).items;
  const admin = current!.role === "owner" || current!.role === "admin";
  const invites = admin
    ? (
        await session.request<{
          items: { id: string; email: string; role: string; expires_at: number }[];
        }>(`/v1/organizations/${id}/invites`)
      ).items
    : [];
  return {
    data: { organization: current, members, invites },
    lines: [
      `${current!.name} · your role: ${current!.role}`,
      ...members.map((m) => `- ${m.email ?? m.name ?? m.user_id} · ${m.role}`),
      ...(invites.length
        ? [
            "Pending invitations:",
            ...invites.map(
              (i) => `- ${i.email} · ${i.role} · expires ${new Date(i.expires_at).toISOString()}`,
            ),
          ]
        : []),
    ],
  };
}

async function invite(
  ctx: CliCommandContext,
  session: NativeSessionContext,
): Promise<NativeOutcome> {
  const args = [...ctx.args];
  const roleFlag = args.indexOf("--role");
  const role = roleFlag >= 0 ? args.splice(roleFlag, 2)[1] : (args[1] ?? "member");
  const email = args[0];
  if (!email)
    throw new NativeCloudError(
      "email_required",
      "Name the person: pathrule invite <email> [--role admin|member|viewer]",
    );
  if (!["admin", "member", "viewer"].includes(role ?? ""))
    throw new NativeCloudError("invalid_role", "The role is admin, member or viewer.");
  const current = await currentOrganization(session, ctx.runtime.env, true);
  const created = await session.request<{
    id: string;
    token: string;
    expiresAt: number;
    emailed?: boolean;
  }>(
    `/v1/organizations/${encodeURIComponent(current!.id)}/invites`,
    { email, role, expectedVersion: current!.revision },
    "POST",
    randomUUID(),
  );
  const link = `${(ctx.runtime.env.PATHRULE_WEB_URL ?? "https://app.pathrule.io").replace(/\/$/, "")}/invite/${created.token}`;
  return {
    data: {
      email,
      role,
      organization: { id: current!.id, name: current!.name },
      invite_url: link,
      expires_at: new Date(created.expiresAt).toISOString(),
      emailed: created.emailed === true,
    },
    lines: [
      `Invited ${email} to "${current!.name}" as ${role}.`,
      created.emailed === true
        ? "Pathrule Cloud e-mailed them the invitation. The link, valid 7 days:"
        : "The invitation e-mail was not sent; send them this link (valid 7 days):",
      link,
    ],
  };
}

async function opened(ctx: CliCommandContext, url: string): Promise<NativeOutcome> {
  if (!ctx.mode.json && ctx.mode.interactive && !ctx.mode.noOpen) {
    const ok = await openRuntimeUrl(ctx.runtime, url).then(
      () => true,
      () => false,
    );
    if (ok) return { data: { url }, lines: [`Opened ${url}`] };
  }
  return { data: { url }, lines: [url] };
}

async function openCommand(
  ctx: CliCommandContext,
  session: NativeSessionContext,
): Promise<NativeOutcome> {
  const target = ctx.args[0] ?? "workspace";
  if (target === "workspace" || target === "signals") return workspace(ctx, session, "open", []);
  const sections: Record<string, string> = {
    org: "",
    app: "",
    billing: "/billing",
    team: "/members",
    members: "/members",
    settings: "/settings",
    workspaces: "/workspaces",
    upgrade: "/billing",
    reactivate: "/billing",
  };
  if (!(target in sections))
    throw new NativeCloudError("unknown_target", `Unknown open target: ${target}.`);
  return opened(ctx, consoleUrl(ctx.runtime.env, sections[target]));
}

async function preflight(
  ctx: CliCommandContext,
  session: NativeSessionContext,
): Promise<NativeOutcome> {
  const served = await attachedHere(session, ctx.runtime);
  const entitlements = await session.request<Record<string, unknown>>(
    `/v1/workspaces/${encodeURIComponent(served.workspace_id)}/entitlements`,
  );
  return {
    data: {
      action: ctx.args[0] ?? null,
      allowed: true,
      workspace_id: served.workspace_id,
      entitlements,
      checked_by: "server",
    },
    lines: [
      `Pathrule Cloud checks every action against "${served.name}"'s plan when it runs; nothing needs checking here first.`,
    ],
  };
}

/** The native command `name`, run for `ctx`. */
async function run(ctx: CliCommandContext): Promise<NativeOutcome> {
  const name = ctx.command;
  // Commands with nothing to do on Pathrule Cloud answer without a session.
  if (name === "daemon")
    return {
      data: { running: false, native: true },
      lines: [
        "Pathrule Cloud runs no daemon on this machine: the agents and the hook reach it directly.",
      ],
    };
  if (name === "queue")
    return {
      data: { queued: 0, native: true },
      lines: ["Nothing is queued here: Pathrule Cloud writes go to the server directly."],
    };
  if (name === "snapshot")
    return notOnPathruleCloud("snapshot", "project snapshots are not part of Pathrule Cloud.");
  if (name === "cache")
    return notOnPathruleCloud("cache", "Pathrule Cloud keeps no account cache to prune here.");
  const session = await nativeSession(ctx.runtime);
  switch (name) {
    case "org":
      return org(ctx, session);
    case "workspace":
      return workspace(ctx, session);
    case "attach":
      return workspace(ctx, session, "attach", ctx.args);
    case "detach":
      return workspace(ctx, session, "detach", ctx.args);
    case "setup":
    case "init":
      return setupFolder(ctx, session, name);
    case "team":
      return team(ctx, session);
    case "invite":
      return invite(ctx, session);
    case "open":
      return openCommand(ctx, session);
    case "billing":
    case "upgrade":
    case "reactivate":
      return opened(ctx, consoleUrl(ctx.runtime.env, "/billing"));
    case "preflight":
      return preflight(ctx, session);
    case "activity": {
      const served = await attachedHere(session, ctx.runtime);
      const { activityCommand } = await import("./activity-import.js");
      return activityCommand(ctx, session, served);
    }
    case "instrument": {
      // `status`, `keys` and `sdk`: a workspace's Signals status and ingest keys are its Signals page
      // in the console (`events` reads through native-knowledge.ts).
      const served = await attachedHere(session, ctx.runtime);
      const page = await opened(
        ctx,
        consoleUrl(ctx.runtime.env, `/w/${encodeURIComponent(served.workspace_id)}/signals`),
      );
      return {
        ...page,
        lines: [
          `Signals status and ingest keys for "${served.name}" are on its Signals page in the Pathrule Cloud console.`,
          ...page.lines,
        ],
      };
    }
    default: {
      const { runNativeKnowledgeCommand } = await import("./native-knowledge.js");
      const outcome = await runNativeKnowledgeCommand(ctx, session);
      return outcome ?? notOnPathruleCloud(name, "it has no Pathrule Cloud service yet.");
    }
  }
}

export function failure(err: unknown): { code: string; message: string; next?: CliNextStep[] } {
  if (err instanceof NativeCloudError)
    return { code: err.code, message: err.message, next: err.next };
  if (err instanceof CloudHttpError) {
    if (err.status === 401)
      return {
        code: "not_authenticated",
        message: "Your Pathrule Cloud session ended.",
        next: [{ label: "Sign in", command: "pathrule login" }],
      };
    if (err.status === 403)
      return { code: "not_authorized", message: `Pathrule Cloud refused this: ${err.message}` };
    return {
      code: "pathrule_cloud_error",
      message: `Pathrule Cloud answered ${err.status}: ${err.message}`,
    };
  }
  return {
    code: "pathrule_cloud_unreachable",
    message: err instanceof Error ? err.message : String(err),
  };
}

export async function renderNative(ctx: CliCommandContext): Promise<number> {
  const mode: CliOutputMode = ctx.mode;
  try {
    // `setup` offers a person at a terminal to sign in first, as it always did; a no ends it. The
    // folder's edition was settled before this runs, so a no leaves a Cloud folder to finish.
    const config = nativeCloudConfig(ctx.runtime.env);
    if (
      ctx.command === "setup" &&
      config &&
      mode.interactive &&
      !(await readNativeSession({ env: ctx.runtime.env }))
    ) {
      if (!(await promptYesNo(ctx.runtime, "Pathrule CLI is not signed in. Sign in now?", true))) {
        ctx.runtime.stderr.write(
          `${statusLabel("error", mode)} Not signed in, so the Pathrule Cloud setup of this folder did not run.\nNext: pathrule login\nNext: pathrule setup --cloud\n`,
        );
        return 1;
      }
      const { renderNativeLogin } = await import("./native-account.js");
      const signedIn = await renderNativeLogin(ctx.runtime, mode, config);
      if (signedIn !== 0) return signedIn;
    }
    const outcome = await run(ctx);
    const failed = (outcome.exitCode ?? 0) !== 0;
    outcome.render?.(ctx.runtime.stdout, mode);
    for (const [i, line] of outcome.lines.entries())
      ctx.runtime.stdout.write(
        i === 0 ? `${statusLabel(failed ? "warn" : "ok", mode)} ${line}\n` : `${line}\n`,
      );
    for (const step of outcome.next ?? [])
      ctx.runtime.stdout.write(`Next: ${step.command ?? step.url ?? step.label}\n`);
    return outcome.exitCode ?? 0;
  } catch (err) {
    const f = failure(err);
    ctx.runtime.stderr.write(`${statusLabel("error", mode)} ${f.message}\n`);
    for (const step of f.next ?? [])
      ctx.runtime.stderr.write(`Next: ${step.command ?? step.url ?? step.label}\n`);
    return 1;
  }
}

export async function jsonNative(ctx: CliCommandContext): Promise<CliJsonResult> {
  const command = [
    ctx.command,
    ...(["org", "workspace"].includes(ctx.command) ? [ctx.args[0] ?? "list"] : []),
  ].join(" ");
  try {
    const outcome = await run(ctx);
    const exitCode = outcome.exitCode ?? 0;
    return {
      exitCode,
      envelope: jsonEnvelope({
        command,
        cwd: ctx.runtime.cwd,
        ok: exitCode === 0,
        data: outcome.data,
        ...(outcome.next ? { next_steps: outcome.next } : {}),
      }),
    };
  } catch (err) {
    const f = failure(err);
    return {
      exitCode: 1,
      envelope: jsonEnvelope({
        command,
        cwd: ctx.runtime.cwd,
        ok: false,
        error: { code: f.code, message: f.message },
        ...(f.next ? { next_steps: f.next } : {}),
      }),
    };
  }
}

type DoctorCheck = { name: string; status: "pass" | "warn" | "fail"; detail: string };

/**
 * The account's part of `pathrule doctor`, following the edition that serves the folder (core's
 * resolveFolderMode): a Pathrule Local folder needs no session and no attachment, and reports
 * nothing to the Cloud; a Pathrule Cloud folder fails signed out and warns unattached; a folder in
 * conflict fails until the person chooses.
 */
export async function nativeDoctorChecks(
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<DoctorCheck[]> {
  const folder = folderModeHere(cwd, env);
  const session = await readNativeSession({ env }).catch(() => null);
  const signedIn = session ? `Pathrule Cloud (${session.base_url})` : null;
  if (folder.mode === "local") {
    const dormant = folder.dormant.cloud;
    return [
      {
        name: "auth",
        status: "pass",
        detail: signedIn ?? "not signed in; this folder uses Pathrule Local",
      },
      {
        name: "cwd_attach",
        status: "pass",
        detail: dormant
          ? `this folder uses Pathrule Local; its Pathrule Cloud attachment ("${dormant.name}") is not used`
          : "this folder uses Pathrule Local",
      },
      {
        name: "deliveries_report",
        status: "pass",
        detail: "this folder uses Pathrule Local: nothing is reported to Pathrule Cloud",
      },
    ];
  }
  if (folder.mode === null) {
    return [
      { name: "auth", status: signedIn ? "pass" : "warn", detail: signedIn ?? "not signed in" },
      { name: "cwd_attach", status: "fail", detail: folderConflictMessage(folder.conflict!) },
    ];
  }
  const served = session
    ? nativeWorkspaceFor(await readNativeWorkspaces(session.user_id, env), cwd)
    : folder.cloud && {
        workspace_id: folder.cloud.workspaceId,
        organization_id: folder.cloud.organizationId,
        name: folder.cloud.name,
        root: folder.cloud.root,
        attached_at: "",
      };
  const { deliveryReportCheck } = await import("../../native/delivery-doctor.js");
  return [
    signedIn
      ? { name: "auth", status: "pass", detail: signedIn }
      : { name: "auth", status: "fail", detail: "not signed in; this folder uses Pathrule Cloud" },
    served
      ? {
          name: "cwd_attach",
          status: "pass",
          detail: `attached to "${served.name}" at ${served.root}`,
        }
      : {
          name: "cwd_attach",
          status: "warn",
          detail: "this folder uses Pathrule Cloud and is not attached to a workspace",
        },
    // An unattached Cloud folder with a Local workspace kept here: its receipts are Local's.
    !served && folder.dormant.local
      ? {
          name: "deliveries_report",
          status: "pass",
          detail: "nothing reported until the folder is attached",
        }
      : await deliveryReportCheck({ env, cwd, attached: served || null }),
  ];
}

/**
 * A support bundle on Pathrule Cloud: the bundle holds no token or secret (the CLI asserts that), and
 * the server must confirm the session is live before one is written.
 */
export async function assertNativeSupportBundle(env: NodeJS.ProcessEnv): Promise<void> {
  const { refreshNativeSession } = await import("../../native/credentials.js");
  if ((await refreshNativeSession({ env })) !== "active")
    throw new Error("token_export_reauth_required");
}
