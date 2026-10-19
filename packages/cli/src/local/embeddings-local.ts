// SPDX-License-Identifier: Apache-2.0
// What `pathrule embeddings` does: read the embedding configuration, check and save a provider,
// remove it, and re-embed the current workspace's memories into the configured space.
//
// The configuration is core's (backend/embedding-adapter.ts): environment first, then the machine
// files storage/embedding-settings.ts writes. The key lives only in the 0600 credentials file and
// never reaches output, logs or errors: every message here is built from codes, hosts and counts,
// and anything a provider or the network said passes through `redact` first.
//
// Counting and re-embedding happen in the store's owner, the Pathrule host (./host-session.ts),
// with the configuration the host resolves. A host started before a change resolves it as it did
// then (its environment, and whether semantic search is on at all), so the CLI compares the two
// and asks for a restart instead of re-embedding into a space the person just left.

import {
  checkLocalBaseUrl,
  describeEmbeddingProvider,
  embeddingConfigStatus,
  EmbeddingHttpError,
  embedTextBYO,
  isEmbeddingProviderName,
  type EmbeddingConfigStatus,
  type EmbeddingProviderName,
} from "@pathrule/core/backend/embedding-adapter.js";
import type {
  EmbeddingCoverage,
  ReindexProgress,
} from "@pathrule/core/backend/local/embedding-store.js";
import {
  clearEmbeddingSettings,
  readEmbeddingCredentials,
  writeEmbeddingSettings,
} from "@pathrule/core/storage/embedding-settings.js";
import { localRuntimePaths } from "@pathrule/core/storage/paths.js";

import { withCliHostSession } from "./host-session.js";

export class EmbeddingsCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "EmbeddingsCommandError";
  }
}

/** The environment variables that override the saved setting, by name only. */
const OVERRIDES = [
  "PATHRULE_EMBEDDING_PROVIDER",
  "PATHRULE_EMBEDDING_API_KEY",
  "PATHRULE_EMBEDDING_MODEL",
  "PATHRULE_EMBEDDING_BASE_URL",
  "PATHRULE_EMBEDDING_ACCOUNT_ID",
] as const;

export function environmentOverrides(env: NodeJS.ProcessEnv): string[] {
  return OVERRIDES.filter((name) => (env[name] ?? "").trim() !== "");
}

/** Every occurrence of `secret` in `text` replaced, so no message can carry a key. */
export function redact(text: string, secret: string | null | undefined): string {
  return secret && secret.length >= 4 ? text.split(secret).join("[redacted]") : text;
}

/** The plain sentence that says what leaves this machine, and where to. */
export function whatIsSent(
  status: Pick<EmbeddingConfigStatus, "configured" | "onDevice" | "endpointHost" | "provider">,
): string {
  if (!status.provider || !status.configured) {
    return "Nothing is sent anywhere: without a provider, Pathrule ranks by keywords on this machine.";
  }
  if (status.onDevice) {
    return `Embedding runs on this machine (${status.endpointHost ?? "loopback"}): memory and skill titles and bodies, and your prompts, stay on this machine.`;
  }
  return `Memory and skill titles and bodies, and your prompts (as queries), are sent to ${status.endpointHost ?? status.provider} to be embedded.`;
}

export const REINDEX_HINT =
  "Vectors of another provider or model are ignored until re-embedded: run pathrule embeddings reindex";
export const RESTART_HINT =
  "Restart the Pathrule host to apply this: pathrule host stop (the next Pathrule command starts it again)";

// ── status ────────────────────────────────────────────────────────────────

export interface EmbeddingsStatusResult {
  config: EmbeddingConfigStatus;
  sends: string;
  overrides: string[];
  settingsFile: string;
  /** The current folder's local workspace, when one covers it. */
  workspace: (EmbeddingCoverage & { id: string; hostSemantic: boolean }) | null;
  /** The running host resolves another configuration than this command. */
  hostDiffers: boolean;
}

export async function embeddingsStatus(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<EmbeddingsStatusResult> {
  const config = embeddingConfigStatus(env);
  const base = {
    config,
    sends: whatIsSent(config),
    overrides: environmentOverrides(env),
    settingsFile: localRuntimePaths(env).embeddingSettingsFile,
  };
  const workspace = await withCliHostSession(env, async (session) => {
    const match = session.resolveLocal(cwd);
    if (!match) return null;
    const store = await session.store(match.workspaceId);
    const coverage = await store.embeddingCoverage(match.workspaceId);
    return { id: match.workspaceId, ...coverage, hostSemantic: store.capabilities().semantic };
  });
  return { ...base, workspace, hostDiffers: workspace !== null && hostDiffers(config, workspace) };
}

function hostDiffers(
  config: EmbeddingConfigStatus,
  host: { family: string | null; hostSemantic: boolean },
): boolean {
  if ((config.configured ? config.spaceFamily : null) !== host.family) return true;
  return config.configured && !host.hostSemantic;
}

// ── use ───────────────────────────────────────────────────────────────────

export interface UseOptions {
  provider: string;
  model?: string;
  baseUrl?: string;
  accountId?: string;
  /** The key the person gave; null to keep the one stored for this provider. */
  apiKey: string | null;
  fetchImpl?: typeof fetch;
}

export interface UseResult {
  config: EmbeddingConfigStatus;
  sends: string;
  dims: number;
  space: string;
  overrides: string[];
}

/** Whether `provider` takes a key, so the caller knows to ask for one. Throws on an unknown name. */
export function providerNeedsKey(provider: string): boolean {
  if (!isEmbeddingProviderName(provider)) {
    throw new EmbeddingsCommandError(
      "invalid_embedding_provider",
      `Unknown embedding provider "${provider.slice(0, 40)}". Use local, openai, voyage or cloudflare.`,
      64,
    );
  }
  return describeEmbeddingProvider(provider).keyRequired;
}

/** The key already stored for `provider`, if any. Never printed; only reused. */
export function storedKeyFor(provider: string, env: NodeJS.ProcessEnv): string | null {
  const stored = readEmbeddingCredentials(env);
  return stored?.provider === provider ? stored.api_key : null;
}

const CHECK_TEXT = "Pathrule embedding check";

/**
 * Check `options` with one small embedding, then save them: settings to embedding.json, the key
 * alone to embedding-credentials.json (0600). Nothing is saved when the check fails.
 */
export async function useEmbeddingProvider(
  options: UseOptions,
  env: NodeJS.ProcessEnv,
): Promise<UseResult> {
  const needsKey = providerNeedsKey(options.provider);
  const provider = options.provider as EmbeddingProviderName;
  const apiKey = needsKey ? (options.apiKey ?? storedKeyFor(provider, env)) : null;
  if (needsKey && !apiKey) {
    throw new EmbeddingsCommandError("embedding_key_required", `${provider} needs an API key.`, 64);
  }
  // The candidate alone, from no file and none of this shell's PATHRULE_EMBEDDING_* variables.
  const candidate: NodeJS.ProcessEnv = {
    PATHRULE_HOME: localRuntimePaths(env).home,
    PATHRULE_EMBEDDING_PROVIDER: provider,
    PATHRULE_EMBEDDING_TIMEOUT_MS: "10000",
    ...(options.model ? { PATHRULE_EMBEDDING_MODEL: options.model } : {}),
    ...(apiKey ? { PATHRULE_EMBEDDING_API_KEY: apiKey } : {}),
    ...(options.baseUrl ? { PATHRULE_EMBEDDING_BASE_URL: options.baseUrl } : {}),
    ...(options.accountId ? { PATHRULE_EMBEDDING_ACCOUNT_ID: options.accountId } : {}),
  };
  const config = embeddingConfigStatus(candidate, { machineConfig: false });
  if (!config.configured) throw configError(config);

  let result;
  try {
    result = await embedTextBYO(
      CHECK_TEXT,
      { inputType: "document" },
      {
        env: candidate,
        machineConfig: false,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      },
    );
  } catch (err) {
    throw checkError(err, config, apiKey);
  }
  if (!result?.space) throw configError(config);

  const baseUrl = options.baseUrl ? checkLocalBaseUrl(options.baseUrl) : null;
  await writeEmbeddingSettings(
    {
      provider,
      model: config.model!,
      ...(baseUrl?.ok && provider === "local" ? { base_url: baseUrl.url } : {}),
      ...(options.accountId && provider === "cloudflare" ? { account_id: options.accountId } : {}),
      dims: result.dims,
    },
    apiKey,
    env,
  );
  const saved = { ...config, space: result.space };
  return {
    config: saved,
    sends: whatIsSent(saved),
    dims: result.dims,
    space: result.space,
    overrides: environmentOverrides(env),
  };
}

const REASONS: Record<string, string> = {
  missing_key: "an API key is required",
  missing_account_id: "cloudflare needs --account-id <your Cloudflare account id>",
  invalid_account_id:
    "the Cloudflare account id must be the 32-character hex id from the dashboard",
  invalid_base_url: "the base URL must be an http(s) URL without credentials",
  non_loopback_base_url:
    "the local provider only talks to this machine: the base URL host must be 127.0.0.1, ::1 or localhost",
  invalid_model: "the model name is not valid for this provider",
  unknown_provider: "unknown provider",
  no_provider: "no provider is configured",
};

export function reasonText(reason: string | null): string {
  return reason ? (REASONS[reason] ?? reason) : "";
}

function configError(config: EmbeddingConfigStatus): EmbeddingsCommandError {
  return new EmbeddingsCommandError(
    config.reason ? `embedding_${config.reason}` : "embedding_check_failed",
    `Not saved: ${reasonText(config.reason) || "the provider gave no vector"}.`,
    config.reason ? 64 : 1,
  );
}

/** A failed check, as a code and a message that names a host and a status, never a key or a body. */
function checkError(
  err: unknown,
  config: EmbeddingConfigStatus,
  apiKey: string | null,
): EmbeddingsCommandError {
  const where = config.endpointHost ?? config.provider ?? "the provider";
  let code = "embedding_check_failed";
  let message: string;
  if (err instanceof EmbeddingHttpError) {
    code = `embedding_http_${err.status}`;
    const hint =
      err.status === 401 || err.status === 403
        ? " Check the API key (and, for cloudflare, that the token may use Workers AI in that account)."
        : err.status === 404
          ? " Check the model name (and, for cloudflare, the account id)."
          : err.status === 429
            ? " The provider is rate limiting; try again shortly."
            : "";
    message = `${where} answered HTTP ${err.status}.${hint}`;
  } else if (err instanceof Error && err.name === "AbortError") {
    code = "embedding_timeout";
    message = `${where} did not answer within 10 s.`;
  } else if (err instanceof Error && /invalid_vector|non_numeric|unsuccessful/.test(err.message)) {
    code = "embedding_invalid_response";
    message = `${where} answered without a usable vector. Check that ${config.model ?? "the model"} is an embedding model.`;
  } else {
    code = "embedding_unreachable";
    message =
      config.provider === "local"
        ? `Nothing answered at ${where}. Start your local embedding server (for Ollama: ollama serve, then ollama pull ${config.model ?? "<model>"}).`
        : `Could not reach ${where}.`;
  }
  return new EmbeddingsCommandError(code, redact(`Not saved: ${message}`, apiKey));
}

// ── off ───────────────────────────────────────────────────────────────────

export async function embeddingsOff(
  env: NodeJS.ProcessEnv,
): Promise<{ removed: boolean; overrides: string[] }> {
  return { removed: await clearEmbeddingSettings(env), overrides: environmentOverrides(env) };
}

// ── reindex ───────────────────────────────────────────────────────────────

export interface ReindexTotals {
  workspaceId: string;
  space: string | null;
  reembedded: number;
  failed: number;
  remaining: number;
  stopped: ReindexProgress["stopped"];
}

/**
 * Re-embed the current folder's workspace in bounded host calls until it is done or a call stops
 * for a reason that another call would not fix. `onProgress` sees every call's totals.
 */
export async function reindexEmbeddings(
  cwd: string,
  env: NodeJS.ProcessEnv,
  onProgress: (totals: ReindexTotals) => void = () => {},
): Promise<ReindexTotals> {
  const config = embeddingConfigStatus(env);
  if (!config.configured) {
    throw new EmbeddingsCommandError(
      "embeddings_not_configured",
      `No embedding provider is configured (${reasonText(config.reason)}). Run: pathrule embeddings use <local|openai|voyage|cloudflare>`,
      64,
    );
  }
  return withCliHostSession(env, async (session) => {
    const match = session.resolveLocal(cwd);
    if (!match) {
      throw new EmbeddingsCommandError(
        "local_workspace_required",
        "No local Pathrule workspace covers this folder. Run: pathrule init --local",
        64,
      );
    }
    const store = await session.store(match.workspaceId);
    const before = await store.embeddingCoverage(match.workspaceId);
    if (
      hostDiffers(config, { family: before.family, hostSemantic: store.capabilities().semantic })
    ) {
      throw new EmbeddingsCommandError(
        "host_restart_required",
        `The running Pathrule host resolves embeddings as ${before.family ?? "off"}, not ${config.spaceFamily}. ${RESTART_HINT}, then run this again.`,
      );
    }
    const totals: ReindexTotals = {
      workspaceId: match.workspaceId,
      space: before.space,
      reembedded: 0,
      failed: 0,
      remaining: before.stale + before.missing,
      stopped: "done",
    };
    let cursor: string | undefined;
    for (;;) {
      const step = await store.reindexEmbeddings(
        match.workspaceId,
        cursor === undefined ? {} : { after: cursor },
      );
      totals.reembedded += step.reembedded;
      totals.failed += step.failed;
      totals.remaining = step.remaining;
      totals.space = step.space;
      totals.stopped = step.stopped;
      onProgress({ ...totals });
      const more = step.stopped === "limit" || step.stopped === "time_budget";
      if (!more || step.cursor === null || step.cursor === cursor) return totals;
      cursor = step.cursor;
    }
  });
}
