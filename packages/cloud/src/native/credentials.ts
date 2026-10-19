// SPDX-License-Identifier: Apache-2.0
// The native Pathrule Cloud session on this machine: one Better Auth session (bearer plugin) for one
// person, kept in its own 0600 file, `<PATHRULE_HOME>/native-session.json`. It never touches
// credentials.json and never imitates what an earlier client kept there.
//
// Lifecycle, all here so every caller shares it:
//   - write (a device-code login, or a refresh that rotated the token): the file, and the person as
//     the recorded `native` owner (core storage/account-owners.ts), which is what the hook trusts. A
//     different person than the one recorded is an account switch: the previous person's private
//     hook entries leave this machine (integrations personal-index-refresh.ts).
//   - read: null when there is no session, it is malformed, or it has expired.
//   - refresh: asks the server for the session; an extended expiry or a rotated token is written,
//     a session the server no longer knows (revoked, expired) is signed out, and an unreachable
//     server changes nothing (an outage is not a sign-out).
//   - sign out: the server is asked to end the session, best effort, and the local state goes
//     whatever it answers.
//
// The token goes to the session's own origin and nowhere else: never into Pathrule knowledge, a hook
// index, a log line, an error message or the owner record. Deployment headers (a private shadow
// gate, for one) come from the composition at call time and are never written down.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { clearAccountOwner, recordAccountOwner } from "@pathrule/core/storage/account-owners.js";
import { serializeByPath } from "@pathrule/core/storage/atomic-write.js";
import { localRuntimePaths, PATHRULE_FILE_MODE } from "@pathrule/core/storage/paths.js";
import { forgetPersonalFieldsOf } from "@pathrule/integrations/index-writers/personal-index-refresh.js";

import { NATIVE_ACCOUNT_PROVIDER } from "./owner.js";

export const NATIVE_SESSION_SCHEMA_VERSION = 1;
/** Better Auth's device-code grant. */
export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** Refresh once less than this is left: the server's own update age (`session.updateAge`, 1 day). */
export const NATIVE_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface NativeSession {
  /** The native Cloud origin the token belongs to; the token is sent nowhere else. */
  base_url: string;
  /** The authenticated person, as the server reported it for this token. */
  user_id: string;
  /** The Better Auth session token, sent as `Authorization: Bearer`. */
  token: string;
  expires_at: string;
  updated_at: string;
}

/** Structurally the transport the Cloud service's native binding takes (`CloudTransport`). */
export interface NativeTransport {
  baseUrl: string;
  headers(): Promise<Record<string, string>>;
  fetch?: typeof fetch;
}

/** Headers a private deployment needs on every request; supplied per call, never stored. */
export type DeploymentHeaders = () => Record<string, string> | Promise<Record<string, string>>;

export interface NativeSessionDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  deploymentHeaders?: DeploymentHeaders;
  now?: () => Date;
}

export type NativeRefreshOutcome = "active" | "signed-out" | "revoked" | "unreachable";

export function nativeSessionFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(localRuntimePaths(env).home, "native-session.json");
}

/**
 * An origin a bearer token may be sent to: https, or plain http only to this machine (a local
 * development server). Anything else would put the session on the wire in clear text.
 */
export function nativeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("the native Cloud URL is not a URL");
  }
  const local =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("the native Cloud URL must be https (plain http only on this machine)");
  }
  return url.origin;
}

function parse(raw: string): NativeSession | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const v = value as Record<string, unknown> | null;
  if (!v || v["schema_version"] !== NATIVE_SESSION_SCHEMA_VERSION) return null;
  const fields = ["base_url", "user_id", "token", "expires_at", "updated_at"] as const;
  if (!fields.every((f) => typeof v[f] === "string" && (v[f] as string) !== "")) return null;
  if (Number.isNaN(Date.parse(v["expires_at"] as string))) return null;
  try {
    nativeOrigin(v["base_url"] as string);
  } catch {
    return null;
  }
  return Object.fromEntries(fields.map((f) => [f, v[f]])) as unknown as NativeSession;
}

async function readRaw(env: NodeJS.ProcessEnv): Promise<NativeSession | null> {
  const raw = await readFile(nativeSessionFile(env), "utf8").catch(() => null);
  return raw === null ? null : parse(raw);
}

/** The session on this machine, or null when there is none, it is malformed or it has expired. */
export async function readNativeSession(
  deps: NativeSessionDeps = {},
): Promise<NativeSession | null> {
  const session = await readRaw(deps.env ?? process.env);
  const now = (deps.now ?? (() => new Date()))();
  return session && Date.parse(session.expires_at) > now.getTime() ? session : null;
}

/**
 * Keep `session` as this machine's native session and its person as the recorded owner. A different
 * person than the one recorded is an account switch: the previous person's private hook entries are
 * removed. Returns the person it replaced, or null.
 */
export async function writeNativeSession(
  session: Omit<NativeSession, "updated_at"> & { updated_at?: string },
  deps: NativeSessionDeps = {},
): Promise<string | null> {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const next: NativeSession = {
    base_url: nativeOrigin(session.base_url),
    user_id: session.user_id.trim(),
    token: session.token,
    expires_at: new Date(session.expires_at).toISOString(),
    updated_at: session.updated_at ?? now.toISOString(),
  };
  if (!next.user_id || !next.token || /\s/.test(next.token))
    throw new Error("a native session needs a person and a token");
  const path = nativeSessionFile(env);
  await serializeByPath(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        tmp,
        `${JSON.stringify({ schema_version: NATIVE_SESSION_SCHEMA_VERSION, ...next }, null, 2)}\n`,
        { mode: PATHRULE_FILE_MODE },
      );
      await chmod(tmp, PATHRULE_FILE_MODE);
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  });
  const replaced = await recordAccountOwner(NATIVE_ACCOUNT_PROVIDER, next.user_id, env);
  if (replaced !== null && replaced !== next.user_id) await forgetPersonalFieldsOf([replaced], env);
  return replaced !== next.user_id ? replaced : null;
}

/**
 * Remove the native session, its recorded owner and that person's private hook entries. Returns the
 * person who was signed in, or null.
 */
export async function clearNativeSession(deps: NativeSessionDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env;
  const session = await readRaw(env);
  await rm(nativeSessionFile(env), { force: true });
  const cleared = await clearAccountOwner(NATIVE_ACCOUNT_PROVIDER, env);
  const gone = [
    ...new Set([session?.user_id, ...cleared].filter((id): id is string => Boolean(id))),
  ];
  await forgetPersonalFieldsOf(gone, env);
  return session?.user_id ?? cleared[0] ?? null;
}

async function headersFor(token: string, deps: NativeSessionDeps): Promise<Record<string, string>> {
  return {
    ...(deps.deploymentHeaders ? await deps.deploymentHeaders() : {}),
    authorization: `Bearer ${token}`,
  };
}

/**
 * The transport for the session on this machine, read on every call: the same object while the
 * session is unchanged, a new one when it changed, and null once there is none (an explicit logout,
 * an expiry or a revocation). That is the snapshot contract the native composition checks before it
 * trusts anything it cached. An expired session is signed out on the way.
 */
export function nativeTransportSource(
  deps: NativeSessionDeps = {},
): () => Promise<NativeTransport | null> {
  let key: string | null = null;
  let snapshot: NativeTransport | null = null;
  return async () => {
    const env = deps.env ?? process.env;
    const stored = await readRaw(env);
    const now = (deps.now ?? (() => new Date()))();
    if (stored && Date.parse(stored.expires_at) <= now.getTime()) {
      await clearNativeSession(deps);
      key = null;
      snapshot = null;
      return null;
    }
    if (!stored) {
      key = null;
      snapshot = null;
      return null;
    }
    const next = `${stored.base_url}\n${stored.user_id}\n${stored.token}`;
    if (next !== key || !snapshot) {
      key = next;
      const token = stored.token;
      snapshot = {
        baseUrl: stored.base_url,
        headers: () => headersFor(token, deps),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      };
    }
    return snapshot;
  };
}

/** Whether the session is close enough to its expiry to ask the server to extend it. */
export function nativeSessionNeedsRefresh(session: NativeSession, now: Date = new Date()): boolean {
  return Date.parse(session.expires_at) - now.getTime() < NATIVE_REFRESH_WINDOW_MS;
}

interface ServerSession {
  session?: { expiresAt?: unknown } | null;
  user?: { id?: unknown } | null;
}

/**
 * Ask the server about the session on this machine. Better Auth extends a session it is asked about
 * once its update age has passed and may hand back a rotated token (`set-auth-token`); both are
 * written. A session the server does not know any more is signed out here, and a server that
 * cannot be reached changes nothing.
 */
export async function refreshNativeSession(
  deps: NativeSessionDeps = {},
): Promise<NativeRefreshOutcome> {
  const env = deps.env ?? process.env;
  const stored = await readRaw(env);
  const now = (deps.now ?? (() => new Date()))();
  if (!stored) return "signed-out";
  if (Date.parse(stored.expires_at) <= now.getTime()) {
    await clearNativeSession(deps);
    return "signed-out";
  }
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(new URL("/api/auth/get-session", stored.base_url), {
      method: "GET",
      headers: await headersFor(stored.token, deps),
    });
  } catch {
    return "unreachable";
  }
  if (response.status === 401 || response.status === 403) {
    await clearNativeSession(deps);
    return "revoked";
  }
  if (!response.ok) return "unreachable";
  let body: ServerSession | null;
  try {
    body = (await response.json()) as ServerSession | null;
  } catch {
    return "unreachable";
  }
  const userId = typeof body?.user?.id === "string" ? body.user.id : "";
  const expiresAt = typeof body?.session?.expiresAt === "string" ? body.session.expiresAt : "";
  if (!userId || Number.isNaN(Date.parse(expiresAt))) {
    // A token the server does not resolve to a session is no longer one.
    await clearNativeSession(deps);
    return "revoked";
  }
  const rotated = response.headers.get("set-auth-token");
  await writeNativeSession(
    {
      base_url: stored.base_url,
      user_id: userId,
      token: rotated && !/\s/.test(rotated) ? rotated : stored.token,
      expires_at: expiresAt,
    },
    deps,
  );
  return "active";
}

/**
 * Sign the native session out: the server is asked to end it (best effort, so an offline machine can
 * still sign out), then the file, the owner record and the person's private hook entries go.
 */
export async function signOutNative(deps: NativeSessionDeps = {}): Promise<string | null> {
  const stored = await readRaw(deps.env ?? process.env);
  if (stored) {
    await (deps.fetch ?? fetch)(new URL("/api/auth/sign-out", stored.base_url), {
      method: "POST",
      headers: { ...(await headersFor(stored.token, deps)), "content-type": "application/json" },
      body: "{}",
    }).catch(() => undefined);
  }
  return clearNativeSession(deps);
}

export interface DeviceCodePrompt {
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
}

/**
 * Sign in with Better Auth's device-code flow: show the person a code, wait while they approve it in
 * the browser, then keep the session. Throws when they deny it or the code expires. Returns the
 * session it wrote (the token stays in the file; callers print only the person).
 */
export async function loginNativeDevice(
  input: {
    baseUrl: string;
    clientId: string;
    scope?: string;
    onCode(prompt: DeviceCodePrompt): void | Promise<void>;
  },
  deps: NativeSessionDeps & { sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ userId: string; expiresAt: string; replaced: string | null }> {
  const origin = nativeOrigin(input.baseUrl);
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  const extra = deps.deploymentHeaders ? await deps.deploymentHeaders() : {};
  const post = (path: string, body: unknown) =>
    doFetch(new URL(path, origin), {
      method: "POST",
      headers: { ...extra, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const codeResponse = await post("/api/auth/device/code", {
    client_id: input.clientId,
    ...(input.scope ? { scope: input.scope } : {}),
  });
  if (!codeResponse.ok)
    throw new Error(`the native Cloud refused the device code request (${codeResponse.status})`);
  const code = (await codeResponse.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
  };
  if (!code.device_code || !code.user_code || !code.verification_uri)
    throw new Error("the native Cloud returned no device code");
  await input.onCode({
    user_code: code.user_code,
    verification_uri: code.verification_uri,
    ...(code.verification_uri_complete
      ? { verification_uri_complete: code.verification_uri_complete }
      : {}),
  });

  let interval = Math.max(1, code.interval ?? 5) * 1000;
  const deadline = now().getTime() + Math.max(1, code.expires_in ?? 600) * 1000;
  for (;;) {
    if (now().getTime() >= deadline)
      throw new Error("the device code expired before it was approved");
    await sleep(interval);
    const tokenResponse = await post("/api/auth/device/token", {
      grant_type: DEVICE_CODE_GRANT,
      device_code: code.device_code,
      client_id: input.clientId,
    });
    const body = (await tokenResponse.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
    };
    if (tokenResponse.ok && body.access_token) {
      const session = (await (
        await doFetch(new URL("/api/auth/get-session", origin), {
          method: "GET",
          headers: { ...extra, authorization: `Bearer ${body.access_token}` },
        })
      )
        .json()
        .catch(() => null)) as ServerSession | null;
      const userId = typeof session?.user?.id === "string" ? session.user.id : "";
      const expiresAt =
        typeof session?.session?.expiresAt === "string" ? session.session.expiresAt : "";
      if (!userId || Number.isNaN(Date.parse(expiresAt)))
        throw new Error("the native Cloud did not confirm the new session");
      const replaced = await writeNativeSession(
        { base_url: origin, user_id: userId, token: body.access_token, expires_at: expiresAt },
        deps,
      );
      return { userId, expiresAt: new Date(expiresAt).toISOString(), replaced };
    }
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      interval += 5000;
      continue;
    }
    if (body.error === "access_denied") throw new Error("the sign-in was denied");
    if (body.error === "expired_token")
      throw new Error("the device code expired before it was approved");
    throw new Error(
      `the native Cloud refused the device token (${tokenResponse.status}${body.error ? `, ${body.error}` : ""})`,
    );
  }
}
