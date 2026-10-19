// SPDX-License-Identifier: Apache-2.0
/**
 * What this machine knows about Pathrule updates, shared by every surface (the CLI, its background
 * check, the MCP server, the editor extension):
 *
 *   <PATHRULE_HOME>/updates/
 *     state.json         the last verified manifest, the highest sequence accepted, check times,
 *                        the notices already shown and an update this machine installed
 *     preferences.json   `update.policy` when no account holds the CLI's preferences
 *     sessions/          one lease per running MCP server or host (./runtime-sessions.ts)
 *
 * Small files, written whole: a temporary file renamed into place, so a reader never sees half of
 * one. Two writers can race; the highest sequence is merged, never lowered, so a race can lose a
 * notice record but never re-open a rollback.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PATHRULE_DIR_MODE, PATHRULE_FILE_MODE, pathruleHome } from "../storage/paths.js";

/** What may be stored: today's two choices, and the values an earlier CLI wrote (read, never rewritten). */
export type UpdatePolicyValue = "automatic" | "notify" | "manual" | "auto";

export interface UpdateNoticeRecord {
  /** The version the notice was about. */
  version: string;
  at: string;
}

export interface InstalledUpdateRecord {
  component: string;
  from: string;
  to: string;
  at: string;
  /** How it was installed: `pathrule update`, or the background check under `update.policy automatic`. */
  by: "command" | "auto";
}

export interface UpdateState {
  schema: 1;
  /** Highest manifest sequence accepted on this machine; a lower one is refused as a rollback. */
  highest_sequence: number;
  /** Last time a manifest was fetched and verified. */
  last_check_at?: string;
  /** Last attempt, successful or not: an offline machine waits before trying again. */
  last_attempt_at?: string;
  /** Why the last attempt failed (a reason code, never a URL with a query or a response body). */
  last_error?: string;
  /** The last verified envelope, exactly as served; it is verified again whenever it is read. */
  envelope?: unknown;
  /** The last notice shown per component and kind (`cli:update_available`). */
  notified?: Record<string, UpdateNoticeRecord>;
  /** The last update this machine installed, until a surface told the person about it. */
  installed?: InstalledUpdateRecord & { announced?: boolean };
  /** The last background install attempt under `update.policy automatic`, and for which version. */
  auto?: { at: string; outcome: string; version?: string };
}

const EMPTY: UpdateState = { schema: 1, highest_sequence: 0 };

export function updatesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(pathruleHome(env), "updates");
}

function statePath(env: NodeJS.ProcessEnv): string {
  return join(updatesDir(env), "state.json");
}

function preferencesPath(env: NodeJS.ProcessEnv): string {
  return join(updatesDir(env), "preferences.json");
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown, env: NodeJS.ProcessEnv): void {
  const dir = updatesDir(env);
  mkdirSync(dir, { recursive: true, mode: PATHRULE_DIR_MODE });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: PATHRULE_FILE_MODE });
    renameSync(tmp, path);
    chmodSync(path, PATHRULE_FILE_MODE);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** The state, or an empty one when there is none or it does not read. */
export function readUpdateState(env: NodeJS.ProcessEnv = process.env): UpdateState {
  const raw = readJson(statePath(env)) as Partial<UpdateState> | null;
  if (!raw || raw.schema !== 1) return { ...EMPTY };
  const sequence = raw.highest_sequence;
  return {
    ...raw,
    schema: 1,
    highest_sequence:
      typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0,
  } as UpdateState;
}

/**
 * Change the state: `change` gets the current one and returns the next. Best effort: a home that
 * cannot be written leaves the state as it was and returns what would have been written.
 */
export function updateUpdateState(
  env: NodeJS.ProcessEnv,
  change: (state: UpdateState) => UpdateState,
): UpdateState {
  const current = readUpdateState(env);
  const next = change(current);
  // Re-read just before writing: another process may have accepted a newer manifest meanwhile.
  const latest = readUpdateState(env);
  const merged: UpdateState = {
    ...next,
    schema: 1,
    highest_sequence: Math.max(next.highest_sequence, latest.highest_sequence),
  };
  if (latest.highest_sequence > next.highest_sequence && latest.envelope !== undefined) {
    merged.envelope = latest.envelope;
    if (latest.last_check_at) merged.last_check_at = latest.last_check_at;
  }
  try {
    writeJsonAtomic(statePath(env), merged, env);
  } catch {
    // A read-only home: nothing is remembered, and the next run checks again.
  }
  return merged;
}

/** `update.policy` stored on this machine, for a CLI without an account to keep it. */
export function readUpdatePreference(
  env: NodeJS.ProcessEnv = process.env,
): UpdatePolicyValue | null {
  const raw = readJson(preferencesPath(env)) as { update_policy?: unknown } | null;
  const value = raw?.update_policy;
  return value === "automatic" || value === "notify" || value === "manual" || value === "auto"
    ? value
    : null;
}

export function writeUpdatePreference(env: NodeJS.ProcessEnv, policy: UpdatePolicyValue): void {
  writeJsonAtomic(
    preferencesPath(env),
    { update_policy: policy, updated_at: new Date().toISOString() },
    env,
  );
}
