// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const PATHRULE_DIR_MODE = 0o700;
export const PATHRULE_FILE_MODE = 0o600;

export interface PathruleLocalRuntimePaths {
  home: string;
  activeUserFile: string;
  credentialsFile: string;
  /** Who is signed in, per account provider, with no credential (account-owners.ts). */
  accountOwnersFile: string;
  tokenLockFile: string;
  /** The embedding provider this machine uses, without its key (embedding-settings.ts). */
  embeddingSettingsFile: string;
  /** The embedding provider's API key, alone in its own 0600 file. */
  embeddingCredentialsFile: string;
  embeddingLockFile: string;
  logsDir: string;
  supportDir: string;
}

export interface PathruleUserRuntimePaths {
  userHash: string;
  userConfigDir: string;
  userConfigFile: string;
  userCacheDir: string;
  epochCacheDir: string;
}

export interface PathruleActiveUserPointer {
  user_id: string;
  updated_at: string;
}

export interface PathruleUserConfig {
  schema_version: 1;
  current_org_id?: string;
  current_workspace_id?: string;
  /** `automatic` or `notify`; `manual` and `auto` are what earlier CLIs wrote (read as notify, automatic). */
  update_policy?: "automatic" | "notify" | "manual" | "auto";
  work_state_runtime_id?: string;
  last_update_check_at?: string;
}

export interface PathruleWorkspaceRuntimePaths extends PathruleUserRuntimePaths {
  workspaceCacheDir: string;
}

export function hashUserIdForPath(userId: string): string {
  return createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 32);
}

export function pathruleHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PATHRULE_HOME && env.PATHRULE_HOME.trim() !== ""
    ? env.PATHRULE_HOME
    : join(homedir(), ".pathrule");
}

export function localRuntimePaths(env: NodeJS.ProcessEnv = process.env): PathruleLocalRuntimePaths {
  const home = pathruleHome(env);
  return {
    home,
    activeUserFile: join(home, "active-user"),
    credentialsFile: join(home, "credentials.json"),
    accountOwnersFile: join(home, "account-owners.json"),
    tokenLockFile: join(home, ".token-lock"),
    embeddingSettingsFile: join(home, "embedding.json"),
    embeddingCredentialsFile: join(home, "embedding-credentials.json"),
    embeddingLockFile: join(home, ".embedding-lock"),
    logsDir: join(home, "logs"),
    supportDir: join(home, "support"),
  };
}

export function userRuntimePaths(
  userId: string,
  securityEpoch = 0,
  env: NodeJS.ProcessEnv = process.env,
): PathruleUserRuntimePaths {
  const home = pathruleHome(env);
  const userHash = hashUserIdForPath(userId);
  const userConfigDir = join(home, "config", "users", userHash);
  const userCacheDir = join(home, "cache", "users", userHash);
  const epochCacheDir = join(userCacheDir, `epoch-${securityEpoch}`);
  return {
    userHash,
    userConfigDir,
    userConfigFile: join(userConfigDir, "config.json"),
    userCacheDir,
    epochCacheDir,
  };
}

export function workspaceRuntimePaths(
  userId: string,
  workspaceId: string,
  securityEpoch = 0,
  env: NodeJS.ProcessEnv = process.env,
): PathruleWorkspaceRuntimePaths {
  const userPaths = userRuntimePaths(userId, securityEpoch, env);
  return {
    ...userPaths,
    workspaceCacheDir: join(userPaths.epochCacheDir, workspaceId),
  };
}
