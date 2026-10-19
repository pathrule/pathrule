// SPDX-License-Identifier: Apache-2.0
// `pathrule login`, `logout` and `whoami` when the build or the run names Pathrule Cloud
// (native/config.ts): Better Auth's device flow against the Worker, the session in its own 0600 file
// (native/credentials.ts), sign-out ending it on the server. Also the account's part of the open
// CLI's `pathrule status` (nativeAccountStatus).
import { jsonEnvelope, statusLabel, type CliOutputMode } from "@pathrule/cli/output.js";
import type { CliRuntime, CliStatusSection } from "@pathrule/cli/plugin.js";
import type { FolderModeResolution } from "@pathrule/core/workspace/folder-mode.js";

import type { AutoAttachOutcome } from "../../native/auto-attach.js";
import type { NativeCloudConfig } from "../../native/config.js";
import {
  loginNativeDevice,
  readNativeSession,
  signOutNative,
  type NativeSession,
} from "../../native/credentials.js";
import { nativeWorkspaceFor, readNativeWorkspaces } from "../../native/workspaces.js";
import { openRuntimeUrl, sleep } from "./interaction.js";

interface NativePerson {
  user_id: string;
  email: string | null;
  expires_at: string;
}

/** The signed-in person as the server knows them now; the stored id when the server is unreachable. */
async function person(runtime: CliRuntime, session: NativeSession): Promise<NativePerson | null> {
  try {
    const response = await (runtime.fetch ?? fetch)(
      new URL("/api/auth/get-session", session.base_url),
      {
        headers: { authorization: `Bearer ${session.token}` },
      },
    );
    if (response.status === 401) return null;
    const body = (await response.json().catch(() => null)) as {
      user?: { id?: string; email?: string };
      session?: { expiresAt?: string };
    } | null;
    if (!body?.user?.id) return null;
    return {
      user_id: body.user.id,
      email: body.user.email ?? null,
      expires_at: body.session?.expiresAt ?? session.expires_at,
    };
  } catch {
    return { user_id: session.user_id, email: null, expires_at: session.expires_at };
  }
}

async function signIn(runtime: CliRuntime, mode: CliOutputMode | null, config: NativeCloudConfig) {
  const result = await loginNativeDevice(
    {
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      onCode: ({ user_code, verification_uri, verification_uri_complete }) => {
        const approve = verification_uri_complete ?? verification_uri;
        if (!mode) return;
        if (mode.interactive && !mode.noOpen) void openRuntimeUrl(runtime, approve).catch(() => {});
        runtime.stdout.write(
          [
            "Pathrule CLI login",
            `${statusLabel("info", mode)} One-time code: ${user_code}`,
            mode.interactive && !mode.noOpen
              ? `A browser window should open. If not, visit ${approve}.`
              : `Visit ${approve} on any browser to approve this terminal.`,
            "Waiting for approval...",
            "",
          ].join("\n"),
        );
      },
    },
    {
      env: runtime.env,
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
      sleep: runtime.sleep ?? sleep,
    },
  );
  const session = await readNativeSession({ env: runtime.env });
  return (
    (session ? await person(runtime, session) : null) ?? {
      user_id: result.userId,
      email: null,
      expires_at: result.expiresAt,
    }
  );
}

/**
 * After a sign-in, a Pathrule Cloud folder this machine served before attaches itself again when
 * its hook index names a workspace the person can read (../../native/auto-attach.ts), and the
 * person is told. A Local folder, one with a Local workspace, or one only its name would match is
 * left alone. Never fails the sign-in: null when nothing was attached or the Cloud did not answer.
 */
async function attachCwdAfterLogin(runtime: CliRuntime): Promise<AutoAttachOutcome | null> {
  try {
    const { nativeSession } = await import("../../native/tenancy.js");
    const { autoAttachFolder } = await import("../../native/auto-attach.js");
    const session = await nativeSession({
      env: runtime.env,
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
    });
    return await autoAttachFolder({
      userId: session.userId,
      request: session.request,
      env: runtime.env,
      cwd: runtime.cwd,
    });
  } catch {
    return null;
  }
}

export async function renderNativeLogin(
  runtime: CliRuntime,
  mode: CliOutputMode,
  config: NativeCloudConfig,
): Promise<number> {
  try {
    const who = await signIn(runtime, mode, config);
    runtime.stdout.write(`${statusLabel("ok", mode)} Signed in as ${who.email ?? who.user_id}\n`);
    const attached = await attachCwdAfterLogin(runtime);
    if (attached) {
      const { autoAttachLine } = await import("../../native/auto-attach.js");
      runtime.stdout.write(
        `${statusLabel("ok", mode)} ${autoAttachLine(attached)} Undo: pathrule detach\n`,
      );
    }
    return 0;
  } catch (err) {
    runtime.stderr.write(
      `${statusLabel("error", mode)} ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

export async function runNativeLoginJson(
  runtime: CliRuntime,
  command: string,
  config: NativeCloudConfig,
) {
  try {
    const who = await signIn(runtime, null, config);
    const attached = await attachCwdAfterLogin(runtime);
    return {
      exitCode: 0,
      envelope: jsonEnvelope({
        command,
        cwd: runtime.cwd,
        ok: true,
        data: {
          ...who,
          attached: attached
            ? {
                workspace_id: attached.entry.workspace_id,
                name: attached.entry.name,
                root: attached.entry.root,
              }
            : null,
        },
      }),
    };
  } catch (err) {
    return {
      exitCode: 1,
      envelope: jsonEnvelope({
        command,
        cwd: runtime.cwd,
        ok: false,
        error: { code: "login_failed", message: err instanceof Error ? err.message : String(err) },
      }),
    };
  }
}

const NOT_SIGNED_IN = {
  code: "not_authenticated",
  message: "Pathrule CLI is not signed in.",
  remediation: [{ label: "Sign in", command: "pathrule login" }],
};

/** The signed-in person, or null: no session here, or one the server no longer accepts. */
export async function nativeWhoami(runtime: CliRuntime): Promise<NativePerson | null> {
  const session = await readNativeSession({ env: runtime.env });
  return session ? person(runtime, session) : null;
}

export async function renderNativeWhoami(
  runtime: CliRuntime,
  mode: CliOutputMode,
): Promise<number> {
  const who = await nativeWhoami(runtime);
  if (!who) {
    runtime.stderr.write(`${statusLabel("error", mode)} Not signed in. Run pathrule login.\n`);
    return 1;
  }
  runtime.stdout.write(
    [
      "Pathrule account",
      `${statusLabel("ok", mode)} Signed in to Pathrule Cloud`,
      `User: ${who.email ?? who.user_id}`,
      `Expires: ${new Date(who.expires_at).toISOString()}`,
      "",
    ].join("\n"),
  );
  return 0;
}

export async function runNativeWhoamiJson(runtime: CliRuntime, command: string) {
  const who = await nativeWhoami(runtime);
  return who
    ? { exitCode: 0, envelope: jsonEnvelope({ command, cwd: runtime.cwd, ok: true, data: who }) }
    : {
        exitCode: 1,
        envelope: jsonEnvelope({ command, cwd: runtime.cwd, ok: false, error: NOT_SIGNED_IN }),
      };
}

/** How long `pathrule status` waits for each Pathrule Cloud answer. */
const STATUS_TIMEOUT_MS = 4_000;

type StatusProblem = NonNullable<CliStatusSection["problem"]>;

/**
 * The account's part of `pathrule status` for `cwd`, whose edition `folder` resolved: who is signed
 * in and until when, and for a Pathrule Cloud folder its workspace and whether Pathrule Cloud
 * answers for it (one authorized call, the workspace's Project capabilities, with a short timeout).
 * A Cloud folder signed out, unattached, refused or unreachable is a problem to act on; a Local
 * folder has none. Never throws.
 */
export async function nativeAccountStatus(input: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  folder: FolderModeResolution;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<CliStatusSection> {
  try {
    return await accountStatus(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      lines: [`Pathrule Cloud: the account status could not be read (${message}).`],
      data: { error: message },
      problem:
        input.folder.mode === "cloud"
          ? {
              code: "cloud_unreachable",
              message: `Pathrule Cloud could not be checked: ${message}`,
            }
          : null,
    };
  }
}

async function accountStatus(input: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  folder: FolderModeResolution;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<CliStatusSection> {
  const { env, cwd, folder } = input;
  const call = (url: URL, init: RequestInit) =>
    (input.fetch ?? fetch)(url, {
      ...init,
      signal: AbortSignal.timeout(input.timeoutMs ?? STATUS_TIMEOUT_MS),
    });
  const cloudFolder = folder.mode === "cloud";
  const session = await readNativeSession({ env }).catch(() => null);
  const signedOut = (ended: boolean): CliStatusSection => ({
    lines: [
      ended
        ? "Pathrule Cloud: signed out (Pathrule Cloud no longer accepts this machine's session)"
        : "Pathrule Cloud: signed out",
    ],
    data: { signed_in: false, user: null, workspace: null, reachable: null },
    problem: cloudFolder
      ? {
          code: "not_signed_in",
          message: ended
            ? "This folder uses Pathrule Cloud, and your Pathrule Cloud session ended."
            : "This folder uses Pathrule Cloud, and Pathrule CLI is not signed in.",
          next: "pathrule login",
        }
      : null,
  });
  if (!session) return signedOut(false);

  let user = { id: session.user_id, email: null as string | null, expires_at: session.expires_at };
  let unreachable: string | null = null;
  try {
    const response = await call(new URL("/api/auth/get-session", session.base_url), {
      headers: { authorization: `Bearer ${session.token}` },
    });
    if (response.status === 401) return signedOut(true);
    const body = (await response.json().catch(() => null)) as {
      user?: { id?: string; email?: string };
      session?: { expiresAt?: string };
    } | null;
    if (response.ok && !body?.user?.id) return signedOut(true);
    if (response.ok)
      user = {
        id: body!.user!.id!,
        email: body!.user!.email ?? null,
        expires_at: body!.session?.expiresAt ?? session.expires_at,
      };
    else unreachable = `Pathrule Cloud answered ${response.status}`;
  } catch (err) {
    unreachable = unreachableReason(err, input.timeoutMs ?? STATUS_TIMEOUT_MS);
  }
  const lines = [
    `Pathrule Cloud: signed in as ${user.email ?? user.id} (session expires ${new Date(user.expires_at).toISOString()})`,
  ];
  const data: Record<string, unknown> = {
    signed_in: true,
    cloud_url: session.base_url,
    user,
    workspace: null,
    reachable: null,
  };
  if (!cloudFolder) return { lines, data, problem: null };

  const entry = nativeWorkspaceFor(await readNativeWorkspaces(session.user_id, env), cwd);
  if (!entry)
    return {
      lines,
      data,
      problem: {
        code: "not_attached",
        message:
          "This folder uses Pathrule Cloud and is not attached to a Pathrule Cloud workspace.",
        next: "pathrule setup --cloud",
      },
    };
  data.workspace = {
    id: entry.workspace_id,
    name: entry.name,
    organization_id: entry.organization_id,
    root: entry.root,
  };
  lines.push(
    `Pathrule Cloud workspace: "${entry.name}" (${entry.workspace_id}), organization ${entry.organization_id}, attached at ${entry.root}`,
  );
  let problem: StatusProblem | null = null;
  if (unreachable) {
    problem = {
      code: "cloud_unreachable",
      message: `Pathrule Cloud did not answer: ${unreachable}.`,
    };
  } else {
    try {
      const response = await call(
        new URL(
          `/v1/workspaces/${encodeURIComponent(entry.workspace_id)}/foundation/project/capabilities`,
          session.base_url,
        ),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.token}`,
            "content-type": "application/json",
            "x-native-owner": session.user_id,
          },
          body: JSON.stringify({ args: [] }),
        },
      );
      if (response.status === 401) {
        problem = {
          code: "not_signed_in",
          message: "This folder uses Pathrule Cloud, and your Pathrule Cloud session ended.",
          next: "pathrule login",
        };
      } else if (response.status === 403 || response.status === 404) {
        problem = {
          code: "no_access",
          message: `You have no access to "${entry.name}" on Pathrule Cloud (archived, deleted, or your access changed).`,
        };
      } else if (response.status === 402) {
        problem = {
          code: "limit_reached",
          message: `"${entry.name}" reached its Pathrule Cloud plan's limit.`,
          next: "pathrule billing",
        };
      } else if (!response.ok) {
        problem = {
          code: "cloud_unreachable",
          message: `Pathrule Cloud did not answer for "${entry.name}": it answered ${response.status}.`,
        };
      }
    } catch (err) {
      problem = {
        code: "cloud_unreachable",
        message: `Pathrule Cloud did not answer: ${unreachableReason(err, input.timeoutMs ?? STATUS_TIMEOUT_MS)}.`,
      };
    }
  }
  data.reachable = problem === null;
  // A problem is printed by the open CLI with its next step; a line here would say it twice.
  if (problem === null) lines.push(`Pathrule Cloud answers for "${entry.name}".`);
  return { lines, data, problem };
}

function unreachableReason(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
    return `no answer within ${timeoutMs / 1000}s`;
  return err instanceof Error ? err.message : String(err);
}

/** Ends the session on the server (best effort) and removes it from this machine. */
export async function nativeLogout(runtime: CliRuntime): Promise<{ removed_sessions: number }> {
  const ended = await signOutNative({
    env: runtime.env,
    ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
  });
  return { removed_sessions: ended ? 1 : 0 };
}

export async function renderNativeLogout(
  runtime: CliRuntime,
  mode: CliOutputMode,
): Promise<number> {
  const { removed_sessions } = await nativeLogout(runtime);
  runtime.stdout.write(
    `${removed_sessions > 0 ? statusLabel("ok", mode) : statusLabel("info", mode)} ${
      removed_sessions > 0 ? "Signed out." : "Already signed out."
    }\n`,
  );
  return 0;
}

export async function runNativeLogoutJson(runtime: CliRuntime, command: string) {
  return {
    exitCode: 0,
    envelope: jsonEnvelope({
      command,
      cwd: runtime.cwd,
      ok: true,
      data: await nativeLogout(runtime),
    }),
  };
}
