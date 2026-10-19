// SPDX-License-Identifier: Apache-2.0
// The embedding provider this machine uses, as `pathrule embeddings use` writes it.
//
// Two files under the Pathrule home, both 0600 in a 0700 directory:
//   embedding.json              provider, model, base URL (local), account id (cloudflare), dims
//   embedding-credentials.json  the provider's API key and the provider it belongs to, nothing else
// The key never enters the settings file, so the settings can be read and shown without it, and a
// key is only ever used for the provider it was stored for.
//
// Reads are synchronous: the embedding adapter resolves its configuration on every call, a
// constructor included, and these files are a few hundred bytes. A missing or unreadable file reads
// as absent. embed-query.cjs (the hook's helper, which cannot import this) reads the same two files
// with the same rules; keep them in step.

import { readFileSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";

import { atomicWrite } from "./atomic-write.js";
import { withFileLock } from "./file-lock.js";
import { localRuntimePaths, PATHRULE_DIR_MODE, PATHRULE_FILE_MODE } from "./paths.js";

export interface EmbeddingSettingsFile {
  schema_version: 1;
  provider: string;
  model?: string;
  base_url?: string;
  account_id?: string;
  /** The dimension the provider answered with when the setting was checked. */
  dims?: number;
  updated_at?: string;
}

export interface EmbeddingCredentialsFile {
  schema_version: 1;
  provider: string;
  api_key: string;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

export function readEmbeddingSettings(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingSettingsFile | null {
  const raw = readJsonObject(localRuntimePaths(env).embeddingSettingsFile);
  const provider = text(raw?.provider);
  if (!raw || raw.schema_version !== 1 || !provider) return null;
  const dims = typeof raw.dims === "number" && Number.isInteger(raw.dims) && raw.dims > 0;
  return {
    schema_version: 1,
    provider: provider.toLowerCase(),
    ...(text(raw.model) ? { model: text(raw.model) } : {}),
    ...(text(raw.base_url) ? { base_url: text(raw.base_url) } : {}),
    ...(text(raw.account_id) ? { account_id: text(raw.account_id) } : {}),
    ...(dims ? { dims: raw.dims as number } : {}),
    ...(text(raw.updated_at) ? { updated_at: text(raw.updated_at) } : {}),
  };
}

export function readEmbeddingCredentials(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingCredentialsFile | null {
  const raw = readJsonObject(localRuntimePaths(env).embeddingCredentialsFile);
  const provider = text(raw?.provider);
  const apiKey = text(raw?.api_key);
  if (!raw || raw.schema_version !== 1 || !provider || !apiKey) return null;
  return { schema_version: 1, provider: provider.toLowerCase(), api_key: apiKey };
}

async function ensureHome(env: NodeJS.ProcessEnv): Promise<void> {
  const { home } = localRuntimePaths(env);
  await mkdir(home, { recursive: true, mode: PATHRULE_DIR_MODE });
  await chmod(home, PATHRULE_DIR_MODE).catch(() => {});
}

/**
 * Replace the machine's embedding provider. `apiKey` goes to the credentials file; null removes
 * that file, so a key stored for an earlier provider does not outlive the switch.
 */
export async function writeEmbeddingSettings(
  settings: Omit<EmbeddingSettingsFile, "schema_version" | "updated_at">,
  apiKey: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const paths = localRuntimePaths(env);
  await ensureHome(env);
  await withFileLock(paths.embeddingLockFile, async () => {
    if (apiKey) {
      const credentials: EmbeddingCredentialsFile = {
        schema_version: 1,
        provider: settings.provider,
        api_key: apiKey,
      };
      await atomicWrite(paths.embeddingCredentialsFile, `${JSON.stringify(credentials)}\n`, {
        mode: PATHRULE_FILE_MODE,
      });
    } else {
      await rm(paths.embeddingCredentialsFile, { force: true });
    }
    const file: EmbeddingSettingsFile = {
      schema_version: 1,
      ...settings,
      updated_at: new Date().toISOString(),
    };
    await atomicWrite(paths.embeddingSettingsFile, `${JSON.stringify(file, null, 2)}\n`, {
      mode: PATHRULE_FILE_MODE,
    });
  });
}

/** Remove the machine's embedding provider and its stored key. True when there was one. */
export async function clearEmbeddingSettings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const paths = localRuntimePaths(env);
  const had = readEmbeddingSettings(env) !== null || readEmbeddingCredentials(env) !== null;
  await ensureHome(env);
  await withFileLock(paths.embeddingLockFile, async () => {
    await rm(paths.embeddingCredentialsFile, { force: true });
    await rm(paths.embeddingSettingsFile, { force: true });
  });
  return had;
}
