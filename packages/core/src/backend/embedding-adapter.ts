// SPDX-License-Identifier: Apache-2.0
// BYO ("bring your own") embedding adapter.
//
// Embedding works networklessly by default, so semantic search is OFF unless a developer
// configures a provider, and every surface keeps its lexical ranking without one. Four providers
// are interchangeable:
//   local       an embedding model on this machine behind a loopback OpenAI-compatible endpoint
//               (Ollama, LM Studio, llama.cpp's server). No key, and content stays on the device.
//   openai      the developer's own key.
//   voyage      the developer's own key.
//   cloudflare  the developer's own Cloudflare account and API token (Workers AI REST API).
// Vectors land in a local SQLite store (brute-force cosine; at solo scale the counts are
// sub-millisecond).
//
// This module holds no SQLite and no network deps beyond fetch, so the SQLite-backed and in-memory
// backends share it. It reads two small files under the Pathrule home (storage/embedding-settings.ts).
//
// Configuration, each setting from its environment variable first, then from the files
// `pathrule embeddings use` writes (runtime only, never baked into a build):
//   PATHRULE_EMBEDDING_PROVIDER    "local" | "openai" | "voyage" | "cloudflare" (any other value ⇒ OFF)
//   PATHRULE_EMBEDDING_API_KEY     provider API key (read at call time; `local` sends none)
//   PATHRULE_EMBEDDING_MODEL       optional; defaults per provider below
//   PATHRULE_EMBEDDING_BASE_URL    `local` only; default http://127.0.0.1:11434/v1, loopback hosts only
//   PATHRULE_EMBEDDING_ACCOUNT_ID  `cloudflare` only; the account the call runs in
//   PATHRULE_EMBEDDING_TIMEOUT_MS  optional; default 5000, clamped to [200, 10000]
// A key from the credentials file is used only for the provider it was stored for.
//
// Contract: embedTextBYO returns `null` when no provider is configured (capability unwired) and
// THROWS on a provider/network failure so the caller can map it to a soft `provider_failure` skip.
// The dimension is provider-native, and every vector carries its space key (embeddingSpaceKey):
// the stores compare a vector only with vectors of the same space. A store with a fixed vector
// width asks for it (`dimensions`) and gets nothing else back.

import { readEmbeddingCredentials, readEmbeddingSettings } from "../storage/embedding-settings.js";

export type EmbeddingProviderName = "local" | "openai" | "voyage" | "cloudflare";

export const EMBEDDING_PROVIDERS: readonly EmbeddingProviderName[] = [
  "local",
  "openai",
  "voyage",
  "cloudflare",
];

export interface EmbedResult {
  embedding: number[];
  model: string;
  dims: number;
  /** The vector space (embeddingSpaceKey). A custom EmbedFn may leave it out; `model` then names it. */
  space?: string;
  /** The model's own cosine floor, when it has one (EmbeddingProviderDescriptor.minSimilarity). */
  minSimilarity?: number;
}

/** The injectable embedding seam the backends depend on (tests pass a stub). */
export type EmbedFn = (
  text: string,
  opts: { inputType: "document" | "query" },
) => Promise<EmbedResult | null>;

/** What one provider is, for one model. Never carries a key. */
export interface EmbeddingProviderDescriptor {
  provider: EmbeddingProviderName;
  defaultModel: string;
  keyRequired: boolean;
  /** Where requests go. `local`: the default base URL; `cloudflare`: a template. */
  endpoint: string;
  /** The most characters of one input sent; longer text is cut at a character boundary. */
  maxInputChars: number;
  /** Whether a document and a query of the same text are embedded differently. */
  inputTypesDiffer: boolean;
  distance: "cosine";
  /** Whether the provider returns unit-length vectors; "unknown" when the model or server decides. */
  normalized: boolean | "unknown";
  /** Bumped when a change to how inputs are sent moves vectors into a new space. */
  spaceVersion: number;
  /** True when content never leaves this machine. */
  onDevice: boolean;
  /**
   * This model's cosine floor, where its similarity scale differs from the one the defaults were
   * set on. Unset: each surface keeps its own default.
   */
  minSimilarity?: number;
}

interface ProviderSpec extends Omit<
  EmbeddingProviderDescriptor,
  "provider" | "inputTypesDiffer" | "minSimilarity"
> {
  inputTypesDiffer: (model: string) => boolean;
  /** Floors for models whose cosine scale is lower than the one the defaults were measured on. */
  modelFloors?: ReadonlyArray<{ modelIncludes: string; minSimilarity: number }>;
  /** Vectors stored before spaces were recorded carry the bare model name; it names this provider when it starts so. */
  legacyModelPrefix?: string;
}

// qwen3-embedding floors, calibrated on 2026-10-12 against the 83-query fixture set (58 labelled and
// 25 multilingual queries over 105 records): the floor keeps about 94% of the correct top hits, and
// the confidence tiers follow it (medium = floor + 0.05, high = floor + 0.33, the precision-1 band).
// With the query instruction (cloudflare) 0.35 keeps 94% with 5.5 unrelated records above it per
// query; a local OpenAI-compatible server embeds queries without it, which lifts the whole scale, and
// there 0.45 keeps 92% with 5.8.
const CLOUDFLARE_QWEN3_FLOOR = [{ modelIncludes: "qwen3-embedding", minSimilarity: 0.35 }] as const;
const LOCAL_QWEN3_FLOOR = [{ modelIncludes: "qwen3-embedding", minSimilarity: 0.45 }] as const;
const isQwen3 = (model: string): boolean => model.includes("qwen3-embedding");

const PROVIDERS: Record<EmbeddingProviderName, ProviderSpec> = {
  local: {
    defaultModel: "qwen3-embedding:0.6b",
    keyRequired: false,
    endpoint: "http://127.0.0.1:11434/v1",
    maxInputChars: 4000,
    inputTypesDiffer: () => false,
    distance: "cosine",
    normalized: "unknown",
    spaceVersion: 1,
    onDevice: true,
    modelFloors: LOCAL_QWEN3_FLOOR,
  },
  openai: {
    defaultModel: "text-embedding-3-large",
    keyRequired: true,
    endpoint: "https://api.openai.com/v1/embeddings",
    maxInputChars: 24000,
    inputTypesDiffer: () => false,
    distance: "cosine",
    normalized: true,
    spaceVersion: 1,
    onDevice: false,
    legacyModelPrefix: "text-embedding-",
  },
  voyage: {
    defaultModel: "voyage-3-large",
    keyRequired: true,
    endpoint: "https://api.voyageai.com/v1/embeddings",
    maxInputChars: 16000,
    inputTypesDiffer: () => true,
    distance: "cosine",
    normalized: true,
    spaceVersion: 1,
    onDevice: false,
    legacyModelPrefix: "voyage-",
  },
  cloudflare: {
    defaultModel: "@cf/qwen/qwen3-embedding-0.6b",
    keyRequired: true,
    endpoint: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}",
    maxInputChars: 20000,
    inputTypesDiffer: isQwen3,
    distance: "cosine",
    normalized: "unknown",
    spaceVersion: 1,
    onDevice: false,
    modelFloors: CLOUDFLARE_QWEN3_FLOOR,
  },
};

export function isEmbeddingProviderName(value: string): value is EmbeddingProviderName {
  return (EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}

/** The descriptor of `provider` for `model` (its default model when omitted). */
export function describeEmbeddingProvider(
  provider: EmbeddingProviderName,
  model?: string,
): EmbeddingProviderDescriptor {
  const spec = PROVIDERS[provider];
  const resolved = model ?? spec.defaultModel;
  const floor = spec.modelFloors?.find((f) => resolved.includes(f.modelIncludes))?.minSimilarity;
  return {
    provider,
    defaultModel: spec.defaultModel,
    keyRequired: spec.keyRequired,
    endpoint: spec.endpoint,
    maxInputChars: spec.maxInputChars,
    inputTypesDiffer: spec.inputTypesDiffer(resolved),
    distance: spec.distance,
    normalized: spec.normalized,
    spaceVersion: spec.spaceVersion,
    onDevice: spec.onDevice,
    ...(floor === undefined ? {} : { minSimilarity: floor }),
  };
}

// ── vector spaces ─────────────────────────────────────────────────────────

/** One provider model at one space version, before a vector reveals its dimension. */
export interface EmbeddingSpaceFamily {
  provider: EmbeddingProviderName;
  model: string;
  version: number;
}

/**
 * The key of one vector space: `<provider>/<model>@<dims>#v<version>`, e.g.
 * `cloudflare/@cf/qwen/qwen3-embedding-0.6b@1024#v1`. Two vectors are comparable only when their
 * keys are equal; a key is parsed only to match a stored vector to the configured provider model.
 */
export function embeddingSpaceKey(family: EmbeddingSpaceFamily, dims: number): string {
  return `${family.provider}/${family.model}@${dims}#v${family.version}`;
}

/** `<provider>/<model>#v<version>`: how status names a space whose dimension is not known yet. */
export function embeddingSpaceFamilyLabel(family: EmbeddingSpaceFamily): string {
  return `${family.provider}/${family.model}#v${family.version}`;
}

const SPACE_KEY = /^([a-z]+)\/(.+)@(\d+)#v(\d+)$/;

export function parseEmbeddingSpaceKey(
  key: string,
): (EmbeddingSpaceFamily & { dims: number }) | null {
  const match = SPACE_KEY.exec(key);
  if (!match || !isEmbeddingProviderName(match[1]!)) return null;
  return {
    provider: match[1],
    model: match[2]!,
    dims: Number(match[3]),
    version: Number(match[4]),
  };
}

/**
 * The space key a stored vector (its `model` column and dimension) is in. A row written before
 * spaces were recorded holds the bare model name the provider echoed; it maps to the first space
 * version of the one provider whose model names start that way (legacyModelPrefix), and any other
 * bare name (a custom EmbedFn's) stays as it is.
 */
export function canonicalVectorSpace(stored: { model: string; dims: number }): string {
  if (parseEmbeddingSpaceKey(stored.model)) return stored.model;
  for (const provider of EMBEDDING_PROVIDERS) {
    const prefix = PROVIDERS[provider].legacyModelPrefix;
    if (prefix && stored.model.startsWith(prefix)) {
      return embeddingSpaceKey({ provider, model: stored.model, version: 1 }, stored.dims);
    }
  }
  return stored.model;
}

/** Whether a stored vector belongs to `family`, at the dimension it was stored with. */
export function storedVectorInFamily(
  stored: { model: string; dims: number },
  family: EmbeddingSpaceFamily,
): boolean {
  const parsed = parseEmbeddingSpaceKey(canonicalVectorSpace(stored));
  return (
    parsed !== null &&
    parsed.provider === family.provider &&
    parsed.model === family.model &&
    parsed.version === family.version &&
    parsed.dims === stored.dims
  );
}

/**
 * Whether a stored vector lies in `space` at `dims`. `space` is a key, or, from a custom EmbedFn
 * that reports none, the model name it returned (then only an equal name matches).
 */
export function storedVectorInSpace(
  stored: { model: string; dims: number },
  space: string,
  dims: number,
): boolean {
  if (stored.dims !== dims) return false;
  return stored.model === space || canonicalVectorSpace(stored) === space;
}

/**
 * The space a store's vectors are compared in, from how many vectors each (model, dims) group
 * holds. With a configured `family`, only its vectors count and the most common dimension wins
 * (there is one in practice). Without one, `fromVectors` picks the most held space (a custom
 * EmbedFn's); otherwise there is none. Ties go to the lower key, so the choice is stable.
 */
export function currentEmbeddingSpace(
  groups: ReadonlyArray<{ model: string; dims: number; count: number }>,
  family: EmbeddingSpaceFamily | null,
  fromVectors: boolean,
): { key: string; dims: number } | null {
  if (!family && !fromVectors) return null;
  const totals = new Map<string, { key: string; dims: number; count: number }>();
  for (const group of groups) {
    if (family && !storedVectorInFamily(group, family)) continue;
    const key = family ? embeddingSpaceKey(family, group.dims) : canonicalVectorSpace(group);
    const id = `${key}\u0000${group.dims}`;
    const entry = totals.get(id) ?? { key, dims: group.dims, count: 0 };
    entry.count += group.count;
    totals.set(id, entry);
  }
  const best = [...totals.values()].sort(
    (a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : a.dims - b.dims),
  )[0];
  return best ? { key: best.key, dims: best.dims } : null;
}

// ── configuration ─────────────────────────────────────────────────────────

/** Why no provider is configured. */
export type EmbeddingUnconfiguredReason =
  | "no_provider"
  | "unknown_provider"
  | "provider_not_allowed"
  | "missing_key"
  | "missing_account_id"
  | "invalid_account_id"
  | "invalid_base_url"
  | "non_loopback_base_url"
  | "invalid_model";

type SettingSource = "env" | "file";

interface ProviderConfig {
  provider: EmbeddingProviderName;
  apiKey: string | null;
  model: string;
  baseUrl: string | null;
  accountId: string | null;
  timeoutMs: number;
  descriptor: EmbeddingProviderDescriptor;
  sources: { provider: SettingSource; key: SettingSource | null };
  /** The dimension stored with the settings, when they describe this provider and model. */
  knownDims: number | null;
}

type ConfigResolution =
  | { ok: true; config: ProviderConfig }
  | {
      ok: false;
      reason: EmbeddingUnconfiguredReason;
      provider: EmbeddingProviderName | null;
      model: string | null;
      sources: { provider: SettingSource | null; key: SettingSource | null };
    };

export interface EmbeddingAdapterOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /**
   * Read the machine-level files `pathrule embeddings use` writes, after the environment. Default
   * true; false reads the environment alone.
   */
  machineConfig?: boolean;
  /** Only these providers; any other one counts as unconfigured (`provider_not_allowed`). */
  providers?: readonly EmbeddingProviderName[];
  /**
   * Ask the provider for exactly this many dimensions and reject a vector of any other length,
   * for a store whose vectors have a fixed width. Unset: the provider's native dimension.
   */
  dimensions?: number;
  /** Bounds for PATHRULE_EMBEDDING_TIMEOUT_MS. Unset: 5000 ms, clamped to [200, 10000]. */
  timeout?: TimeoutBounds;
}

/** How long one embedding call may take, and the range PATHRULE_EMBEDDING_TIMEOUT_MS is held to. */
export interface TimeoutBounds {
  defaultMs: number;
  minMs: number;
  maxMs: number;
}

const DEFAULT_TIMEOUT: TimeoutBounds = { defaultMs: 5000, minMs: 200, maxMs: 10000 };

/** A provider answered with a non-2xx status. The message names the provider and the status. */
export class EmbeddingHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** The local base URL without a trailing slash, or why it is refused. Loopback hosts only. */
export function checkLocalBaseUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; reason: "invalid_base_url" | "non_loopback_base_url" } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_base_url" };
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    return { ok: false, reason: "invalid_base_url" };
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) return { ok: false, reason: "non_loopback_base_url" };
  url.search = "";
  url.hash = "";
  return { ok: true, url: url.toString().replace(/\/+$/, "") };
}

const CLOUDFLARE_ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const CLOUDFLARE_MODEL = /^@[a-z0-9-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function validModel(provider: EmbeddingProviderName, model: string): boolean {
  if (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) return false;
  return provider !== "cloudflare" || (CLOUDFLARE_MODEL.test(model) && !model.includes(".."));
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = (env[name] ?? "").trim();
  return value === "" ? undefined : value;
}

function resolveConfig(
  env: NodeJS.ProcessEnv,
  options: Pick<EmbeddingAdapterOptions, "machineConfig" | "providers" | "timeout"> = {},
): ConfigResolution {
  const files = options.machineConfig !== false;
  const settings = files ? readEmbeddingSettings(env) : null;
  const envProvider = envValue(env, "PATHRULE_EMBEDDING_PROVIDER")?.toLowerCase();
  const rawProvider = envProvider ?? settings?.provider;
  const providerSource: SettingSource | null = envProvider ? "env" : rawProvider ? "file" : null;
  const fail = (
    reason: EmbeddingUnconfiguredReason,
    provider: EmbeddingProviderName | null = null,
    model: string | null = null,
    key: SettingSource | null = null,
  ): ConfigResolution => ({
    ok: false,
    reason,
    provider,
    model,
    sources: { provider: providerSource, key },
  });

  if (!rawProvider) return fail("no_provider");
  if (!isEmbeddingProviderName(rawProvider)) return fail("unknown_provider");
  const provider = rawProvider;
  if (options.providers && !options.providers.includes(provider)) {
    return fail("provider_not_allowed", provider);
  }
  // File settings and a stored key count only for the provider they were written for.
  const own = settings?.provider === provider ? settings : null;
  const credentials = files ? readEmbeddingCredentials(env) : null;
  const storedKey = credentials?.provider === provider ? credentials.api_key : undefined;

  const envModel = envValue(env, "PATHRULE_EMBEDDING_MODEL");
  const model = envModel ?? own?.model ?? PROVIDERS[provider].defaultModel;
  const descriptor = describeEmbeddingProvider(provider, model);

  let apiKey: string | null = null;
  let keySource: SettingSource | null = null;
  if (descriptor.keyRequired) {
    const envKey = envValue(env, "PATHRULE_EMBEDDING_API_KEY");
    apiKey = envKey ?? storedKey ?? null;
    keySource = envKey ? "env" : storedKey ? "file" : null;
    if (!apiKey) return fail("missing_key", provider, model);
  }
  if (!validModel(provider, model)) return fail("invalid_model", provider, model, keySource);

  let baseUrl: string | null = null;
  if (provider === "local") {
    const checked = checkLocalBaseUrl(
      envValue(env, "PATHRULE_EMBEDDING_BASE_URL") ?? own?.base_url ?? descriptor.endpoint,
    );
    if (!checked.ok) return fail(checked.reason, provider, model, keySource);
    baseUrl = checked.url;
  }

  let accountId: string | null = null;
  if (provider === "cloudflare") {
    accountId = envValue(env, "PATHRULE_EMBEDDING_ACCOUNT_ID") ?? own?.account_id ?? null;
    if (!accountId) return fail("missing_account_id", provider, model, keySource);
    if (!CLOUDFLARE_ACCOUNT_ID.test(accountId))
      return fail("invalid_account_id", provider, model, keySource);
  }

  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const rawTimeout = Number(env.PATHRULE_EMBEDDING_TIMEOUT_MS ?? String(timeout.defaultMs));
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(Math.max(rawTimeout, timeout.minMs), timeout.maxMs)
      : timeout.defaultMs;
  return {
    ok: true,
    config: {
      provider,
      apiKey,
      model,
      baseUrl,
      accountId,
      timeoutMs,
      descriptor,
      sources: { provider: providerSource ?? "env", key: keySource },
      knownDims: own?.model === model ? (own.dims ?? null) : null,
    },
  };
}

/** The configured provider, or null when none is configured. */
export function embeddingProviderName(
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<EmbeddingAdapterOptions, "machineConfig" | "providers"> = {},
): EmbeddingProviderName | null {
  const resolved = resolveConfig(env, options);
  return resolved.ok ? resolved.config.provider : null;
}

/** True when an embedding provider is configured (with its key, where it needs one): drives capabilities().semantic. */
export function hasEmbeddingKey(
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<EmbeddingAdapterOptions, "machineConfig" | "providers"> = {},
): boolean {
  return resolveConfig(env, options).ok;
}

/** The configured provider model and space version: the space, short of the dimension. */
export function configuredEmbeddingSpace(
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<EmbeddingAdapterOptions, "machineConfig" | "providers"> = {},
): EmbeddingSpaceFamily | null {
  const resolved = resolveConfig(env, options);
  if (!resolved.ok) return null;
  const { provider, model, descriptor } = resolved.config;
  return { provider, model, version: descriptor.spaceVersion };
}

/** What status output may show about the embedding configuration. It never holds the key. */
export interface EmbeddingConfigStatus {
  configured: boolean;
  /** Why not, when not configured. */
  reason: EmbeddingUnconfiguredReason | null;
  provider: EmbeddingProviderName | null;
  model: string | null;
  /** The full space key when the dimension is known (checked by `pathrule embeddings use`). */
  space: string | null;
  /** The space short of its dimension: `<provider>/<model>#v<version>`. */
  spaceFamily: string | null;
  /** The host requests go to; never a path, a query or an account id. */
  endpointHost: string | null;
  onDevice: boolean;
  key: "set" | "missing" | "not_needed" | null;
  sources: { provider: SettingSource | null; key: SettingSource | null };
  descriptor: EmbeddingProviderDescriptor | null;
}

export function embeddingConfigStatus(
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<EmbeddingAdapterOptions, "machineConfig" | "providers"> = {},
): EmbeddingConfigStatus {
  const resolved = resolveConfig(env, options);
  if (!resolved.ok) {
    const descriptor = resolved.provider
      ? describeEmbeddingProvider(resolved.provider, resolved.model ?? undefined)
      : null;
    return {
      configured: false,
      reason: resolved.reason,
      provider: resolved.provider,
      model: resolved.model,
      space: null,
      spaceFamily:
        resolved.provider && resolved.model
          ? embeddingSpaceFamilyLabel({
              provider: resolved.provider,
              model: resolved.model,
              version: descriptor!.spaceVersion,
            })
          : null,
      endpointHost: descriptor ? endpointHost(descriptor.endpoint) : null,
      onDevice: descriptor?.onDevice ?? false,
      key: !descriptor
        ? null
        : !descriptor.keyRequired
          ? "not_needed"
          : resolved.sources.key
            ? "set"
            : "missing",
      sources: resolved.sources,
      descriptor,
    };
  }
  const { config } = resolved;
  const family = {
    provider: config.provider,
    model: config.model,
    version: config.descriptor.spaceVersion,
  };
  return {
    configured: true,
    reason: null,
    provider: config.provider,
    model: config.model,
    space: config.knownDims ? embeddingSpaceKey(family, config.knownDims) : null,
    spaceFamily: embeddingSpaceFamilyLabel(family),
    endpointHost: endpointHost(config.baseUrl ?? config.descriptor.endpoint),
    onDevice: config.descriptor.onDevice,
    key: config.descriptor.keyRequired ? "set" : "not_needed",
    sources: config.sources,
    descriptor: config.descriptor,
  };
}

function endpointHost(endpoint: string): string | null {
  try {
    return new URL(endpoint.replace("{account_id}", "x").replace("{model}", "x")).host;
  } catch {
    return null;
  }
}

// ── provider calls ────────────────────────────────────────────────────────

function toFiniteVector(raw: unknown, dimensions: number | undefined): number[] {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    (dimensions !== undefined && raw.length !== dimensions)
  ) {
    throw new Error("embedding_invalid_vector");
  }
  const numbers = raw.map((v) => Number(v));
  if (numbers.some((n) => !Number.isFinite(n))) {
    throw new Error("embedding_non_numeric_vector");
  }
  return numbers;
}

/** `text` cut to `max` UTF-16 units, never between the two halves of a surrogate pair. */
export function truncateEmbeddingInput(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

interface CallInput {
  text: string;
  config: ProviderConfig;
  inputType: "document" | "query";
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  dimensions: number | undefined;
}

async function postJson(
  input: CallInput,
  url: string,
  body: unknown,
  extra: RequestInit = {},
): Promise<Record<string, unknown>> {
  const { config } = input;
  const res = await input.fetchImpl(url, {
    method: "POST",
    signal: input.signal,
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    ...extra,
  });
  if (!res.ok) throw new EmbeddingHttpError(`${config.provider}_http_${res.status}`, res.status);
  const json = (await res.json()) as unknown;
  if (!json || typeof json !== "object") throw new Error("embedding_invalid_vector");
  return json as Record<string, unknown>;
}

function firstDataEmbedding(json: Record<string, unknown>): unknown {
  const data = json.data as Array<{ embedding?: unknown }> | undefined;
  return Array.isArray(data) ? data[0]?.embedding : undefined;
}

async function callVoyage(input: CallInput): Promise<{ raw: unknown; model?: unknown }> {
  const json = await postJson(input, PROVIDERS.voyage.endpoint, {
    input: input.text,
    model: input.config.model,
    ...(input.dimensions !== undefined ? { output_dimension: input.dimensions } : {}),
    output_dtype: "float",
    input_type: input.inputType,
  });
  return { raw: firstDataEmbedding(json), model: json.model };
}

async function callOpenAi(input: CallInput): Promise<{ raw: unknown; model?: unknown }> {
  // OpenAI has no document/query knob; the input type is intentionally ignored here.
  const json = await postJson(input, PROVIDERS.openai.endpoint, {
    input: input.text,
    model: input.config.model,
    ...(input.dimensions !== undefined ? { dimensions: input.dimensions } : {}),
    encoding_format: "float",
  });
  return { raw: firstDataEmbedding(json), model: json.model };
}

async function callLocal(input: CallInput): Promise<{ raw: unknown; model?: unknown }> {
  // The OpenAI-compatible embeddings route Ollama, LM Studio and llama.cpp's server all expose.
  // A redirect is refused: it is the one way a loopback answer could send the text elsewhere.
  const json = await postJson(
    input,
    `${input.config.baseUrl}/embeddings`,
    { model: input.config.model, input: input.text },
    { redirect: "error" },
  );
  return { raw: firstDataEmbedding(json), model: json.model };
}

async function callCloudflare(input: CallInput): Promise<{ raw: unknown; model?: unknown }> {
  const { config, text } = input;
  // qwen3-embedding embeds documents and queries differently and applies its default instruction
  // to queries (it measured best); other models take one `text` list.
  const body = isQwen3(config.model)
    ? input.inputType === "query"
      ? { queries: [text] }
      : { documents: [text] }
    : { text: [text] };
  const url = PROVIDERS.cloudflare.endpoint
    .replace("{account_id}", config.accountId ?? "")
    .replace("{model}", config.model);
  const json = await postJson(input, url, body);
  if (json.success === false) throw new Error("cloudflare_unsuccessful");
  const result = json.result as { data?: unknown } | undefined;
  return { raw: Array.isArray(result?.data) ? result.data[0] : undefined };
}

const CALLS: Record<
  EmbeddingProviderName,
  (input: CallInput) => Promise<{ raw: unknown; model?: unknown }>
> = {
  local: callLocal,
  openai: callOpenAi,
  voyage: callVoyage,
  cloudflare: callCloudflare,
};

/**
 * Embed one text. `null` ⇒ no provider configured (capability unwired).
 * Throws on empty input or a provider/network failure — callers wrap in
 * try/catch and map to a soft skip.
 */
export async function embedTextBYO(
  text: string,
  opts: { inputType: "document" | "query" },
  options: EmbeddingAdapterOptions = {},
): Promise<EmbedResult | null> {
  const env = options.env ?? process.env;
  const resolved = resolveConfig(env, options);
  if (!resolved.ok) return null;
  const { config } = resolved;

  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("embedding_empty_input");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const { raw, model } = await CALLS[config.provider]({
      text: truncateEmbeddingInput(trimmed, config.descriptor.maxInputChars),
      config,
      inputType: opts.inputType,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      signal: controller.signal,
      dimensions: options.dimensions,
    });
    const embedding = toFiniteVector(raw, options.dimensions);
    const family = {
      provider: config.provider,
      model: config.model,
      version: config.descriptor.spaceVersion,
    };
    return {
      embedding,
      model: typeof model === "string" && model !== "" ? model : config.model,
      dims: embedding.length,
      space: embeddingSpaceKey(family, embedding.length),
      ...(config.descriptor.minSimilarity === undefined
        ? {}
        : { minSimilarity: config.descriptor.minSimilarity }),
    };
  } finally {
    clearTimeout(timer);
  }
}
