// SPDX-License-Identifier: Apache-2.0
// The model that names knowledge topics on this machine, as `pathrule topics use` writes it, and
// the names it made, per workspace.
//
// Under the Pathrule home, every file 0600 in a 0700 directory:
//   topic-model.json               provider, model, base URL (local), account id (cloudflare)
//   topic-model-credentials.json   the provider's API key and the provider it belongs to
//   cache/<workspace>/topic-names.json   names per topic id, with the terms and model they were for
// The key never enters the settings file, so the settings can be shown without it, and a key is
// only used for the provider it was stored for. Without a model, topics show their words.

import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DEFAULT_TOPIC_MODELS,
  TOPIC_MODEL_PROVIDERS,
  type TopicModelConfig,
  type TopicModelProvider,
  type TopicNameCache,
} from "../knowledge-map/topic-names.js";
import { atomicWrite } from "./atomic-write.js";
import { withFileLock } from "./file-lock.js";
import { PATHRULE_DIR_MODE, PATHRULE_FILE_MODE, pathruleHome } from "./paths.js";

export interface TopicModelSettingsFile {
  schema_version: 1;
  provider: TopicModelProvider;
  model: string;
  base_url?: string;
  account_id?: string;
  updated_at?: string;
}

export function topicModelFiles(env: NodeJS.ProcessEnv = process.env) {
  const home = pathruleHome(env);
  return {
    home,
    settings: join(home, "topic-model.json"),
    credentials: join(home, "topic-model-credentials.json"),
    lock: join(home, ".topic-model-lock"),
  };
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

export function isTopicModelProvider(value: unknown): value is TopicModelProvider {
  return (TOPIC_MODEL_PROVIDERS as readonly unknown[]).includes(value);
}

export function readTopicModelSettings(
  env: NodeJS.ProcessEnv = process.env,
): TopicModelSettingsFile | null {
  const raw = readJsonObject(topicModelFiles(env).settings);
  const provider = text(raw?.provider)?.toLowerCase();
  const model = text(raw?.model);
  if (!raw || raw.schema_version !== 1 || !isTopicModelProvider(provider) || !model) return null;
  return {
    schema_version: 1,
    provider,
    model,
    ...(text(raw.base_url) ? { base_url: text(raw.base_url) } : {}),
    ...(text(raw.account_id) ? { account_id: text(raw.account_id) } : {}),
    ...(text(raw.updated_at) ? { updated_at: text(raw.updated_at) } : {}),
  };
}

/** The stored key, only when it was stored for `provider`. */
export function readTopicModelKey(
  provider: TopicModelProvider,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = readJsonObject(topicModelFiles(env).credentials);
  if (!raw || raw.schema_version !== 1 || text(raw.provider)?.toLowerCase() !== provider) {
    return null;
  }
  return text(raw.api_key) ?? null;
}

/** The configured model with its key, or null when none is set (or its key is missing). */
export function topicModelConfig(env: NodeJS.ProcessEnv = process.env): TopicModelConfig | null {
  const settings = readTopicModelSettings(env);
  if (!settings) return null;
  const apiKey = readTopicModelKey(settings.provider, env) ?? undefined;
  if (settings.provider !== "local" && !apiKey) return null;
  return {
    provider: settings.provider,
    model: settings.model,
    ...(settings.base_url ? { baseUrl: settings.base_url } : {}),
    ...(settings.account_id ? { accountId: settings.account_id } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

/** The model a provider uses when none is named, or null when it needs one. */
export function defaultTopicModel(provider: TopicModelProvider): string | null {
  return DEFAULT_TOPIC_MODELS[provider] ?? null;
}

async function ensureHome(env: NodeJS.ProcessEnv): Promise<void> {
  const { home } = topicModelFiles(env);
  await mkdir(home, { recursive: true, mode: PATHRULE_DIR_MODE });
  await chmod(home, PATHRULE_DIR_MODE).catch(() => {});
}

/**
 * Replace the machine's topic model. `apiKey` goes to the credentials file; null removes that
 * file, so a key stored for an earlier provider does not outlive the switch.
 */
export async function writeTopicModelSettings(
  settings: Omit<TopicModelSettingsFile, "schema_version" | "updated_at">,
  apiKey: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const files = topicModelFiles(env);
  await ensureHome(env);
  await withFileLock(files.lock, async () => {
    if (apiKey) {
      await atomicWrite(
        files.credentials,
        `${JSON.stringify({ schema_version: 1, provider: settings.provider, api_key: apiKey })}\n`,
        { mode: PATHRULE_FILE_MODE },
      );
    } else {
      await rm(files.credentials, { force: true });
    }
    const file: TopicModelSettingsFile = {
      schema_version: 1,
      ...settings,
      updated_at: new Date().toISOString(),
    };
    await atomicWrite(files.settings, `${JSON.stringify(file, null, 2)}\n`, {
      mode: PATHRULE_FILE_MODE,
    });
  });
}

/** Remove the machine's topic model and its stored key. True when there was one. */
export async function clearTopicModelSettings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const files = topicModelFiles(env);
  const had = readTopicModelSettings(env) !== null;
  await ensureHome(env);
  await withFileLock(files.lock, async () => {
    await rm(files.credentials, { force: true });
    await rm(files.settings, { force: true });
  });
  return had;
}

// ── names ────────────────────────────────────────────────────────────────

export function topicNamesFile(workspaceId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(pathruleHome(env), "cache", workspaceId, "topic-names.json");
}

/** The names kept for a workspace; none when the file is missing or unreadable. */
export async function readTopicNames(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TopicNameCache> {
  try {
    const parsed = JSON.parse(await readFile(topicNamesFile(workspaceId, env), "utf8")) as {
      names?: unknown;
    };
    const names = parsed?.names;
    if (!names || typeof names !== "object" || Array.isArray(names)) return {};
    const cache: TopicNameCache = {};
    for (const [id, entry] of Object.entries(names as Record<string, unknown>)) {
      const e = entry as Record<string, unknown> | null;
      if (
        e &&
        typeof e.name === "string" &&
        typeof e.terms === "string" &&
        typeof e.model === "string"
      ) {
        cache[id] = { name: e.name, terms: e.terms, model: e.model };
      }
    }
    return cache;
  } catch {
    return {};
  }
}

export async function writeTopicNames(
  workspaceId: string,
  cache: TopicNameCache,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = topicNamesFile(workspaceId, env);
  await mkdir(dirname(file), { recursive: true, mode: PATHRULE_DIR_MODE });
  await atomicWrite(file, `${JSON.stringify({ version: 1, names: cache }, null, 2)}\n`, {
    mode: PATHRULE_FILE_MODE,
  });
}
