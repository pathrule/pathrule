// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  localRuntimePaths,
  PATHRULE_DIR_MODE,
  PATHRULE_FILE_MODE,
  userRuntimePaths,
  type PathruleActiveUserPointer,
  type PathruleUserConfig,
} from "./paths.js";

export async function readUserConfig(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PathruleUserConfig> {
  const paths = userRuntimePaths(userId, 0, env);
  try {
    const raw = await readFile(paths.userConfigFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.schema_version === 1) {
      return parsed as PathruleUserConfig;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { schema_version: 1 };
}

export async function writeUserConfig(
  userId: string,
  config: PathruleUserConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const paths = userRuntimePaths(userId, 0, env);
  await writeJsonFile(paths.userConfigFile, { ...config, schema_version: 1 });
}

export async function updateUserConfig(
  userId: string,
  patch: Partial<Omit<PathruleUserConfig, "schema_version">>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PathruleUserConfig> {
  const current = await readUserConfig(userId, env);
  const next: PathruleUserConfig = { ...current, ...patch, schema_version: 1 };
  await writeUserConfig(userId, next, env);
  return next;
}

export async function writeActiveUserPointer(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const paths = localRuntimePaths(env);
  const pointer: PathruleActiveUserPointer = {
    user_id: userId,
    updated_at: new Date().toISOString(),
  };
  await writeJsonFile(paths.activeUserFile, pointer);
}

export async function clearActiveUserPointer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await rm(localRuntimePaths(env).activeUserFile, { force: true });
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: PATHRULE_DIR_MODE });
  await chmod(dir, PATHRULE_DIR_MODE).catch(() => {});
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode: PATHRULE_FILE_MODE,
  });
  await chmod(tmp, PATHRULE_FILE_MODE).catch(() => {});
  await rename(tmp, path);
}
