// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  assertTelemetryPayloadAllowed,
  type TelemetryEventPayload,
  type TelemetryResult,
} from "@pathrule/cloud/telemetry/contract.js";
import {
  posthogBatch,
  posthogProjectKey,
  posthogTarget,
  type TelemetryTarget,
} from "@pathrule/cloud/telemetry/posthog.js";
import { CLI_VERSION } from "@pathrule/cli/cli-version.js";
import type { ManagedFileOwnershipSummary } from "@pathrule/core/storage/managed-file-ownership.js";
import {
  localRuntimePaths,
  PATHRULE_DIR_MODE,
  PATHRULE_FILE_MODE,
} from "@pathrule/core/storage/paths.js";

export const CLI_TELEMETRY_EVENTS = [
  "surface_viewed",
  "cli_setup_started",
  "cli_setup_completed",
  "cli_doctor_failed",
  "web_admin_route_opened_from_cli",
  "agent_sync_succeeded",
  "cli_preflight_blocked",
  "cli_limit_route_opened",
  "surface_migration_started",
  "surface_migration_completed",
  "managed_file_owner_conflict",
  "dead_end_seen",
  // The install funnel: a workspace initialised, an agent connected, signed in, then the MCP server
  // in use, knowledge written through it and context delivered by it (once per day each, so the
  // same events also measure daily activity and retention).
  "workspace_initialized",
  "agent_connected",
  "cli_login_completed",
  "mcp_used",
  "knowledge_written",
  "context_delivered",
] as const;

export type CliTelemetryEventName = (typeof CLI_TELEMETRY_EVENTS)[number];

export type CliTelemetryConfigKey = "telemetry.enabled" | "telemetry.id";

/**
 * How a person consents to telemetry.
 *
 *   opt-in  nothing is collected until the person turns it on (`pathrule telemetry enable`). The
 *           first-use notice says it is off and how to turn it on.
 *   notice  the documented default (on) applies, but only after the first-use notice has been
 *           shown in an earlier run; until then, and wherever it cannot be shown, nothing is sent.
 *
 * "opt-in" is the conservative default while counsel reviews whether a notice with an opt-out is
 * valid consent where Pathrule is offered (docs/legal/privacy.md, legal review checklist). Moving to
 * "notice" is that decision, made here and nowhere else.
 */
export type TelemetryConsentMode = "opt-in" | "notice";
export const TELEMETRY_CONSENT_MODE: TelemetryConsentMode = "opt-in";

export interface CliTelemetryEnabledState {
  key: "telemetry.enabled";
  value: boolean;
  /**
   * What decided it: CI, an environment opt-out, the person's own choice, the consent mode's default,
   * or (notice mode) a first-use notice not shown yet.
   */
  source: "ci" | "env" | "config" | "default" | "notice_pending";
  configurable: boolean;
}

export interface CliTelemetryIdState {
  key: "telemetry.id";
  value: string;
  source: "config";
  configurable: true;
}

export type CliTelemetryConfigState = CliTelemetryEnabledState | CliTelemetryIdState;

interface CliTelemetryConfigFile {
  schema_version: 1;
  /** Created when telemetry is first used or a choice is saved; a notice alone creates none. */
  pseudonymous_install_id?: string;
  telemetry_enabled?: boolean;
  /** The UTC day each once-a-day event was last recorded on, keyed `event:feature_tag`. */
  daily?: Record<string, string>;
  /** Events dropped, oldest first, because the queue reached its bound while nothing could send. */
  dropped_events?: number;
  /** When the person last turned telemetry on or off: the consent record. */
  telemetry_decided_at?: string;
  /** When the first-use notice was shown. It is shown once per install. */
  notice_shown_at?: string;
}

declare const __BUILD_NATIVE_CLOUD_URL__: string;

const SESSION_LOCAL_ID = randomUUID();
/** A notice shown during this run does not count for it: the person has not had a chance to act. */
const PROCESS_STARTED_AT = Date.now();
const FLUSH_BATCH_SIZE = 20;
const FLUSH_TIMEOUT_MS = 1500;
/** Telemetry is not user content: past this many unsent events the oldest go (and are counted). */
const MAX_QUEUED_EVENTS = 500;

export function isCliTelemetryConfigKey(key: string | undefined): key is CliTelemetryConfigKey {
  return key === "telemetry.enabled" || key === "telemetry.id";
}

export async function getCliTelemetryConfig(
  key: CliTelemetryConfigKey,
  env: NodeJS.ProcessEnv,
): Promise<CliTelemetryConfigState> {
  if (key === "telemetry.enabled") {
    return resolveTelemetryEnabled(env, await readTelemetryConfig(env));
  }
  const config = await ensureTelemetryConfig(env);
  return {
    key,
    value: config.pseudonymous_install_id,
    source: "config",
    configurable: true,
  };
}

export async function setCliTelemetryEnabled(
  value: string,
  env: NodeJS.ProcessEnv,
): Promise<CliTelemetryEnabledState> {
  const normalized = normalizeBoolean(value);
  if (normalized === null) throw new Error("invalid_telemetry_enabled");
  // With an install id, so that every CLI version reads the choice: earlier ones ignore a file
  // without one, and their default was on.
  const config = await ensureTelemetryConfig(env);
  const next: CliTelemetryConfigFile = {
    ...config,
    telemetry_enabled: normalized,
    telemetry_decided_at: new Date().toISOString(),
  };
  await writeTelemetryConfig(next, env);
  // A decision starts a clean queue: nothing recorded under an earlier setting is sent after it.
  await rm(telemetryEventsPath(env), { force: true });
  return resolveTelemetryEnabled(env, next);
}

/** What `pathrule telemetry` shows. */
export interface CliTelemetryStatus {
  enabled: CliTelemetryEnabledState;
  consent_mode: TelemetryConsentMode;
  /** Whether this build sends at all: only Pathrule's managed build, pointed at Pathrule's backend. */
  managed_build: boolean;
  /** Telemetry counts only a person signed in to Pathrule Cloud on this machine. */
  signed_in: boolean;
  /** Whether an event recorded now would be queued and sent. */
  collecting: boolean;
  install_id: string | null;
  queued_events: number;
  decided_at: string | null;
  notice_shown_at: string | null;
}

export async function cliTelemetryStatus(env: NodeJS.ProcessEnv): Promise<CliTelemetryStatus> {
  const config = await readTelemetryConfig(env);
  const enabled = resolveTelemetryEnabled(env, config);
  const managed = managedTelemetryTarget(env) !== null;
  const signedIn = await signedInToCloud(env);
  let queued = 0;
  try {
    queued = (await readFile(telemetryEventsPath(env), "utf8")).split("\n").filter(Boolean).length;
  } catch {
    queued = 0;
  }
  return {
    enabled,
    consent_mode: TELEMETRY_CONSENT_MODE,
    managed_build: managed,
    signed_in: signedIn,
    collecting: enabled.value && managed && signedIn,
    install_id: config?.pseudonymous_install_id ?? null,
    queued_events: queued,
    decided_at: config?.telemetry_decided_at ?? null,
    notice_shown_at: config?.notice_shown_at ?? null,
  };
}

/**
 * The first-use notice, once per install, or null. It is shown only where telemetry could apply: a
 * managed build, a person signed in, no CI or environment opt-out, and no choice made yet. Showing
 * it is recorded, so it never repeats. The caller prints it only to a terminal a person reads.
 */
export async function cliTelemetryFirstUseNotice(
  env: NodeJS.ProcessEnv,
  now: Date = new Date(),
): Promise<string | null> {
  if (isContinuousIntegration(env) || envOptOut(env)) return null;
  const existing = await readTelemetryConfig(env);
  if (typeof existing?.telemetry_enabled === "boolean" || existing?.notice_shown_at) return null;
  if (managedTelemetryTarget(env) === null || !(await signedInToCloud(env))) return null;
  // No install id yet: nothing identifies this install before the person turns telemetry on.
  await writeTelemetryConfig(
    { ...(existing ?? { schema_version: 1 }), notice_shown_at: now.toISOString() },
    env,
  );
  return TELEMETRY_CONSENT_MODE === "opt-in"
    ? "Pathrule can send anonymous usage data (which commands and MCP tools succeed, the CLI version " +
        "and OS; never code, paths, prompts, knowledge or your account). It is off. Turn it on with " +
        "`pathrule telemetry enable`; `pathrule telemetry` shows the details."
    : "Pathrule sends anonymous usage data while you are signed in (which commands and MCP tools " +
        "succeed, the CLI version and OS; never code, paths, prompts, knowledge or your account), " +
        "starting with your next command. Turn it off with `pathrule telemetry disable`.";
}

export async function resetCliTelemetryId(env: NodeJS.ProcessEnv): Promise<CliTelemetryIdState> {
  const config = await ensureTelemetryConfig(env);
  const next = { ...config, pseudonymous_install_id: randomUUID() };
  await writeTelemetryConfig(next, env);
  return {
    key: "telemetry.id",
    value: next.pseudonymous_install_id,
    source: "config",
    configurable: true,
  };
}

export async function recordCliTelemetryEvent(
  env: NodeJS.ProcessEnv,
  args: {
    eventName: CliTelemetryEventName;
    result: TelemetryResult;
    appVersion: string;
    durationMs?: number;
    blockingReason?: string;
    featureTag?: string;
    /** "mcp" for what the MCP server records; the CLI's own commands are "cli". */
    surface?: "cli" | "mcp";
  },
): Promise<{ recorded: boolean; reason?: string }> {
  const enabled = resolveTelemetryEnabled(env, await readTelemetryConfig(env));
  if (!enabled.value) return { recorded: false, reason: enabled.source };
  // Open-core decision 12: install, run, no account, no telemetry. Only a person signed in to
  // Pathrule Cloud on this machine is counted; the local product sends nothing to Pathrule.
  if (!(await signedInToCloud(env))) return { recorded: false, reason: "no_account" };

  const config = await ensureTelemetryConfig(env);
  const payload: TelemetryEventPayload = {
    event_name: args.eventName,
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    surface: args.surface ?? "cli",
    host_kind: "cli-bridge",
    app_version: args.appVersion,
    os_family: process.platform,
    pseudonymous_install_id: config.pseudonymous_install_id,
    session_local_id: SESSION_LOCAL_ID,
    event_id: randomUUID(),
    result: args.result,
    ...(typeof args.durationMs === "number" ? { duration_ms: args.durationMs } : {}),
    ...(args.blockingReason ? { blocking_reason: args.blockingReason } : {}),
    ...(args.featureTag ? { feature_tag: args.featureTag } : {}),
  };

  assertTelemetryPayloadAllowed(payload);
  assertTelemetryPayloadHasNoPii(payload);

  const eventPath = telemetryEventsPath(env);
  await mkdir(dirname(eventPath), { recursive: true, mode: PATHRULE_DIR_MODE });
  await chmod(dirname(eventPath), PATHRULE_DIR_MODE).catch(() => {});
  await appendFile(eventPath, `${JSON.stringify(payload)}\n`, {
    encoding: "utf8",
    mode: PATHRULE_FILE_MODE,
  });
  await chmod(eventPath, PATHRULE_FILE_MODE).catch(() => {});
  await boundQueue(env, eventPath).catch(() => undefined);
  await flushCliTelemetryQueue(env).catch(() => undefined);
  return { recorded: true };
}

/**
 * An install-funnel event at most once per UTC day per `featureTag`: the first MCP use, knowledge
 * write or context delivery of the day. The MCP server calls it on every finished tool, so the
 * day's marker is checked before anything is written.
 */
export async function recordDailyCliTelemetryEvent(
  env: NodeJS.ProcessEnv,
  args: {
    eventName: CliTelemetryEventName;
    featureTag: string;
    appVersion: string;
    surface?: "cli" | "mcp";
  },
  now: Date = new Date(),
): Promise<{ recorded: boolean; reason?: string }> {
  const key = `${args.eventName}:${args.featureTag}`;
  const day = now.toISOString().slice(0, 10);
  if (recordedToday.get(key) === day) return { recorded: false, reason: "today" };
  const enabled = resolveTelemetryEnabled(env, await readTelemetryConfig(env));
  if (!enabled.value) return { recorded: false, reason: enabled.source };
  const config = await ensureTelemetryConfig(env);
  recordedToday.set(key, day);
  if (config.daily?.[key] === day) return { recorded: false, reason: "today" };
  await writeTelemetryConfig({ ...config, daily: { ...config.daily, [key]: day } }, env);
  return recordCliTelemetryEvent(env, { ...args, result: "ok" });
}

const recordedToday = new Map<string, string>();

async function signedInToCloud(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const { readNativeSession } = await import("../native/credentials.js");
    return (await readNativeSession({ env })) !== null;
  } catch {
    return false;
  }
}

async function boundQueue(env: NodeJS.ProcessEnv, eventPath: string): Promise<void> {
  const lines = (await readFile(eventPath, "utf8")).split("\n").filter(Boolean);
  if (lines.length <= MAX_QUEUED_EVENTS) return;
  const dropped = lines.length - MAX_QUEUED_EVENTS;
  await writeFile(eventPath, `${lines.slice(dropped).join("\n")}\n`, {
    encoding: "utf8",
    mode: PATHRULE_FILE_MODE,
  });
  const config = await ensureTelemetryConfig(env);
  await writeTelemetryConfig(
    { ...config, dropped_events: (config.dropped_events ?? 0) + dropped },
    env,
  );
}

export async function recordCliCommandTelemetry(
  env: NodeJS.ProcessEnv,
  args: { command: string; exitCode: number; appVersion: string; durationMs: number },
): Promise<void> {
  try {
    const eventName = eventForCommand(args.command, args.exitCode);
    const result = args.exitCode === 0 ? "ok" : args.exitCode === 64 ? "blocked" : "failed";
    if (eventName) {
      await recordCliTelemetryEvent(env, {
        eventName,
        result,
        appVersion: args.appVersion,
        durationMs: args.durationMs,
        featureTag: featureTagForCommand(args.command),
        blockingReason: args.exitCode === 64 ? "usage_or_preflight_blocked" : undefined,
      });
    }

    const deadEnd = deadEndForCommand(args.command, args.exitCode);
    if (deadEnd) {
      await recordCliTelemetryEvent(env, {
        eventName: "dead_end_seen",
        result: "blocked",
        appVersion: args.appVersion,
        durationMs: args.durationMs,
        featureTag: deadEnd.featureTag,
        blockingReason: deadEnd.blockingReason,
      });
    }
  } catch {
    // Telemetry must never change CLI behavior or output.
  }
}

function eventForCommand(command: string, exitCode: number): CliTelemetryEventName | null {
  switch (command) {
    case "help":
    case "version":
    case "status":
      return "surface_viewed";
    case "setup":
      return exitCode === 0 ? "cli_setup_completed" : "cli_setup_started";
    case "doctor":
      return exitCode === 0 ? null : "cli_doctor_failed";
    case "sync":
      return exitCode === 0 ? "agent_sync_succeeded" : null;
    case "billing":
    case "team":
    case "upgrade":
    case "reactivate":
    case "open":
      return "web_admin_route_opened_from_cli";
    case "preflight":
      return exitCode === 0 ? null : "cli_preflight_blocked";
    case "init":
      return exitCode === 0 ? "workspace_initialized" : null;
    case "install":
      return exitCode === 0 ? "agent_connected" : null;
    case "login":
      return exitCode === 0 ? "cli_login_completed" : null;
    default:
      return null;
  }
}

function featureTagForCommand(command: string): string {
  if (command === "setup") return "cli_setup";
  if (command === "doctor") return "cli_doctor";
  if (command === "sync") return "agent_sync";
  if (["billing", "team", "upgrade", "reactivate", "open"].includes(command)) return "web_route";
  if (command === "preflight") return "preflight";
  if (command === "init") return "cli_init";
  if (command === "install") return "cli_install";
  if (command === "login") return "cli_login";
  return "surface";
}

function deadEndForCommand(
  command: string,
  exitCode: number,
): { featureTag: string; blockingReason: string } | null {
  if (exitCode === 0) return null;
  if (command === "doctor") {
    return { featureTag: "cli_doctor", blockingReason: "doctor_cannot_repair" };
  }
  if (command === "preflight") {
    return { featureTag: "preflight", blockingReason: "preflight_blocked" };
  }
  if (command === "setup") {
    return { featureTag: "cli_setup", blockingReason: "cli_setup_incomplete" };
  }
  if (["billing", "team", "upgrade", "reactivate", "open"].includes(command)) {
    return { featureTag: "web_route", blockingReason: "web_route_not_opened" };
  }
  return null;
}

/** A CI run: `CI` set to anything but false (GitHub, GitLab, CircleCI, Buildkite and others set it). */
function isContinuousIntegration(env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI?.trim().toLowerCase();
  return Boolean(ci) && ci !== "false" && ci !== "0";
}

function envOptOut(env: NodeJS.ProcessEnv): boolean {
  const on = (value: string | undefined) => value === "1" || value?.toLowerCase() === "true";
  return on(env.NO_TELEMETRY) || on(env.DO_NOT_TRACK);
}

/** Whether telemetry is on, and what decided it, under a consent mode (this build's by default). */
export function resolveTelemetryEnabled(
  env: NodeJS.ProcessEnv,
  config: Pick<CliTelemetryConfigFile, "telemetry_enabled" | "notice_shown_at"> | null,
  mode: TelemetryConsentMode = TELEMETRY_CONSENT_MODE,
): CliTelemetryEnabledState {
  if (isContinuousIntegration(env)) {
    return { key: "telemetry.enabled", value: false, source: "ci", configurable: false };
  }
  if (envOptOut(env)) {
    return { key: "telemetry.enabled", value: false, source: "env", configurable: false };
  }
  if (typeof config?.telemetry_enabled === "boolean") {
    return {
      key: "telemetry.enabled",
      value: config.telemetry_enabled,
      source: "config",
      configurable: true,
    };
  }
  if (mode === "opt-in") {
    return { key: "telemetry.enabled", value: false, source: "default", configurable: true };
  }
  const noticed =
    config?.notice_shown_at !== undefined &&
    Date.parse(config.notice_shown_at) < PROCESS_STARTED_AT;
  return noticed
    ? { key: "telemetry.enabled", value: true, source: "default", configurable: true }
    : { key: "telemetry.enabled", value: false, source: "notice_pending", configurable: true };
}

type CliTelemetryConfigWithId = CliTelemetryConfigFile & { pseudonymous_install_id: string };

async function ensureTelemetryConfig(env: NodeJS.ProcessEnv): Promise<CliTelemetryConfigWithId> {
  const existing = await readTelemetryConfig(env);
  if (existing?.pseudonymous_install_id) return existing as CliTelemetryConfigWithId;
  const created: CliTelemetryConfigWithId = {
    ...(existing ?? { schema_version: 1 }),
    pseudonymous_install_id: randomUUID(),
  };
  await writeTelemetryConfig(created, env);
  return created;
}

async function readTelemetryConfig(env: NodeJS.ProcessEnv): Promise<CliTelemetryConfigFile | null> {
  try {
    const parsed = JSON.parse(await readFile(telemetryConfigPath(env), "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.schema_version === 1 &&
      (parsed.pseudonymous_install_id === undefined ||
        typeof parsed.pseudonymous_install_id === "string")
    ) {
      return parsed as CliTelemetryConfigFile;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return null;
}

async function writeTelemetryConfig(
  config: CliTelemetryConfigFile,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const target = telemetryConfigPath(env);
  await mkdir(dirname(target), { recursive: true, mode: PATHRULE_DIR_MODE });
  await chmod(dirname(target), PATHRULE_DIR_MODE).catch(() => {});
  // One temporary name per writer: several MCP servers of one install may record at once.
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2), {
    encoding: "utf8",
    mode: PATHRULE_FILE_MODE,
  });
  await chmod(tmp, PATHRULE_FILE_MODE).catch(() => {});
  await rename(tmp, target);
}

function telemetryConfigPath(env: NodeJS.ProcessEnv): string {
  return join(localRuntimePaths(env).home, "telemetry.json");
}

// The PostHog queue. `telemetry-events.jsonl`, the queue of an earlier ingest endpoint, holds events
// in an old schema; nothing reads it any more.
function telemetryEventsPath(env: NodeJS.ProcessEnv): string {
  return join(localRuntimePaths(env).logsDir, "telemetry-queue.jsonl");
}

async function flushCliTelemetryQueue(env: NodeJS.ProcessEnv): Promise<void> {
  const target = managedTelemetryTarget(env);
  if (!target) return;

  const eventPath = telemetryEventsPath(env);
  let lines: string[];
  try {
    lines = (await readFile(eventPath, "utf8")).split("\n").filter(Boolean);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (lines.length === 0) return;

  const batch = lines.slice(0, FLUSH_BATCH_SIZE).map((line) => JSON.parse(line));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);
  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(posthogBatch(batch, target, "pathrule-cli")),
      signal: controller.signal,
    });
    // A refused batch (4xx other than a rate limit) would block the queue forever: it goes. A 5xx or
    // a rate limit keeps it for the next command.
    const refused = response.status >= 400 && response.status < 500 && response.status !== 429;
    if (!response.ok && !refused) return;
    const remaining = lines.slice(batch.length).join("\n");
    await writeFile(eventPath, remaining ? `${remaining}\n` : "", {
      encoding: "utf8",
      mode: PATHRULE_FILE_MODE,
    });
    await chmod(eventPath, PATHRULE_FILE_MODE).catch(() => {});
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Where this install's telemetry goes, or null for nowhere. Only Pathrule's managed build sends: one
 * built against Pathrule Cloud and still pointed at it. A source or development build (no Cloud baked
 * in) and a run given another Cloud (`PATHRULE_NATIVE_CLOUD_URL`: staging, a local Worker) send
 * nothing; their events stay in the bounded local queue. `PATHRULE_TELEMETRY_HOST` (with `PATHRULE_TELEMETRY_KEY`)
 * names a target explicitly, for a test stand-in or a staging project.
 */
export function managedTelemetryTarget(env: NodeJS.ProcessEnv): TelemetryTarget | null {
  if (env.PATHRULE_TELEMETRY_HOST) {
    return posthogTarget({ host: env.PATHRULE_TELEMETRY_HOST, key: env.PATHRULE_TELEMETRY_KEY });
  }
  const built = typeof __BUILD_NATIVE_CLOUD_URL__ !== "undefined" ? __BUILD_NATIVE_CLOUD_URL__ : "";
  if (!built || !posthogProjectKey()) return null;
  const runtime = env.PATHRULE_NATIVE_CLOUD_URL?.trim();
  const strip = (url: string) => url.replace(/\/+$/, "");
  if (runtime && strip(runtime) !== strip(built)) return null;
  return posthogTarget();
}

function normalizeBoolean(value: string | null | undefined): boolean | null {
  if (!value) return null;
  const normalized = value.toLowerCase().trim();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function assertTelemetryPayloadHasNoPii(payload: TelemetryEventPayload): void {
  const body = JSON.stringify(payload);
  const piiPatterns = [
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
    /(?:^|["\s])\/Users\/[^"\s]+/,
    /(?:^|["\s])\/home\/[^"\s]+/,
    /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
    /ghp_[A-Za-z0-9_]{20,}/,
  ];
  for (const pattern of piiPatterns) {
    if (pattern.test(body)) {
      throw new Error(`telemetry_payload_contains_sensitive_material:${pattern}`);
    }
  }
}

/** The telemetry of what `pathrule doctor` found about the files Pathrule manages. */
export async function recordManagedFileTelemetry(
  env: NodeJS.ProcessEnv,
  managedFiles: ManagedFileOwnershipSummary[],
): Promise<void> {
  if (
    !managedFiles.some(
      (entry) => entry.status === "other_owner" || entry.status === "newer_version",
    )
  ) {
    return;
  }
  await recordCliTelemetryEvent(env, {
    eventName: "managed_file_owner_conflict",
    result: "blocked",
    appVersion: CLI_VERSION,
    featureTag: "managed_files",
    blockingReason: "managed_file_owner_conflict",
  }).catch(() => undefined);
  await recordCliTelemetryEvent(env, {
    eventName: "dead_end_seen",
    result: "blocked",
    appVersion: CLI_VERSION,
    featureTag: "managed_files",
    blockingReason: "managed_file_owner_conflict",
  }).catch(() => undefined);
}
