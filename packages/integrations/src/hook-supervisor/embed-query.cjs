#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Standalone prompt-embedding helper. Shipped next to pathrule-hook.js in ~/.pathrule/bin/.
// The hook spawns it (bounded, best-effort) to turn the current prompt into a vector so it
// can rank items against the knowledge embeddings precomputed in embeddings.json.
//
// SELF-CONTAINED on purpose: the hook ships as a single file with no node_modules, so this
// helper cannot import @pathrule/core. It is a faithful CJS port of
// core/src/backend/embedding-adapter.ts (inputType "query"): the same four providers (local,
// openai, voyage, cloudflare), the same configuration (each setting from its
// PATHRULE_EMBEDDING_* variable first, then <PATHRULE_HOME>/embedding.json and the key in
// embedding-credentials.json), the same space keys and floors. Keep the two in step.
//
// Contract: reads the prompt from stdin (utf8) and prints
//   {"embedding":[...],"dims":N,"model":"...","space":"<provider>/<model>@<dims>#v<n>"}
// plus "min_similarity" when the model has its own cosine floor, to stdout on exit 0. The hook
// compares the space with the one its index names and ranks by keywords when they differ. On no
// provider / failure / timeout / empty input it exits non-zero and the hook falls back to keyword
// overlap. Never throws to the parent beyond exit code.
//
// Exit codes: 0 ok · 1 provider failure/timeout · 3 no provider configured · 4 empty prompt.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Calibrated qwen3-embedding floors (core embedding-adapter.ts): queries carry the model's instruction
// on cloudflare; a local OpenAI-compatible server embeds them without it, on a higher scale.
const QWEN3_FLOOR = { cloudflare: 0.35, local: 0.45 };
const isQwen3 = (model) => model.includes("qwen3-embedding");

const PROVIDERS = {
  local: { model: "qwen3-embedding:0.6b", key: false, maxChars: 4000, version: 1 },
  openai: { model: "text-embedding-3-large", key: true, maxChars: 24000, version: 1 },
  voyage: { model: "voyage-3-large", key: true, maxChars: 16000, version: 1 },
  cloudflare: { model: "@cf/qwen/qwen3-embedding-0.6b", key: true, maxChars: 20000, version: 1 },
};
const LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
const CLOUDFLARE_ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const CLOUDFLARE_MODEL = /^@[a-z0-9-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function pathruleHome(env) {
  return env.PATHRULE_HOME && env.PATHRULE_HOME.trim() !== ""
    ? env.PATHRULE_HOME
    : path.join(os.homedir(), ".pathrule");
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const text = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const envValue = (env, name) => text(env[name]);

function localBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
    return null;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return null; // content must stay on this machine
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function resolveConfig(env) {
  const home = pathruleHome(env);
  const rawSettings = readJson(path.join(home, "embedding.json"));
  const settings = rawSettings && rawSettings.schema_version === 1 ? rawSettings : null;
  const provider = (
    envValue(env, "PATHRULE_EMBEDDING_PROVIDER") ||
    text(settings && settings.provider) ||
    ""
  ).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) return null;
  const spec = PROVIDERS[provider];
  // File settings and a stored key count only for the provider they were written for.
  const own =
    settings && text(settings.provider) && settings.provider.trim().toLowerCase() === provider
      ? settings
      : null;
  const rawCredentials = readJson(path.join(home, "embedding-credentials.json"));
  const credentials =
    rawCredentials &&
    rawCredentials.schema_version === 1 &&
    String(rawCredentials.provider || "")
      .trim()
      .toLowerCase() === provider
      ? rawCredentials
      : null;

  const model = envValue(env, "PATHRULE_EMBEDDING_MODEL") || text(own && own.model) || spec.model;
  if (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) return null;
  let apiKey = null;
  if (spec.key) {
    apiKey =
      envValue(env, "PATHRULE_EMBEDDING_API_KEY") ||
      text(credentials && credentials.api_key) ||
      null;
    if (!apiKey) return null;
  }
  let baseUrl = null;
  if (provider === "local") {
    baseUrl = localBaseUrl(
      envValue(env, "PATHRULE_EMBEDDING_BASE_URL") || text(own && own.base_url) || LOCAL_BASE_URL,
    );
    if (!baseUrl) return null;
  }
  let accountId = null;
  if (provider === "cloudflare") {
    accountId =
      envValue(env, "PATHRULE_EMBEDDING_ACCOUNT_ID") || text(own && own.account_id) || null;
    if (!accountId || !CLOUDFLARE_ACCOUNT_ID.test(accountId)) return null;
    if (!CLOUDFLARE_MODEL.test(model) || model.includes("..")) return null;
  }
  const rawTimeout = Number(env.PATHRULE_EMBEDDING_TIMEOUT_MS || "5000");
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(Math.max(rawTimeout, 200), 10000)
      : 5000;
  return { provider, apiKey, model, baseUrl, accountId, timeoutMs, spec };
}

function toFiniteVector(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("embedding_invalid_vector");
  const numbers = raw.map((v) => Number(v));
  if (numbers.some((n) => !Number.isFinite(n))) throw new Error("embedding_non_numeric_vector");
  return numbers;
}

function truncate(value, max) {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function request(config, input) {
  switch (config.provider) {
    case "voyage":
      return {
        url: "https://api.voyageai.com/v1/embeddings",
        body: { input, model: config.model, output_dtype: "float", input_type: "query" },
      };
    case "openai":
      return {
        url: "https://api.openai.com/v1/embeddings",
        body: { input, model: config.model, encoding_format: "float" },
      };
    case "local":
      return {
        url: `${config.baseUrl}/embeddings`,
        body: { model: config.model, input },
        redirect: "error",
      };
    default:
      return {
        url: `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/run/${config.model}`,
        body: isQwen3(config.model) ? { queries: [input] } : { text: [input] },
      };
  }
}

async function embed(prompt, config, signal) {
  const { url, body, redirect } = request(config, truncate(prompt, config.spec.maxChars));
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    ...(redirect ? { redirect } : {}),
  });
  if (!res.ok) throw new Error(`${config.provider}_http_${res.status}`);
  const json = await res.json();
  let raw;
  if (config.provider === "cloudflare") {
    if (!json || json.success === false) throw new Error("cloudflare_unsuccessful");
    raw = json.result && Array.isArray(json.result.data) ? json.result.data[0] : undefined;
  } else {
    raw = json && json.data && json.data[0] && json.data[0].embedding;
  }
  const embedding = toFiniteVector(raw);
  const echoed =
    config.provider !== "cloudflare" && json && typeof json.model === "string" && json.model;
  return {
    embedding,
    dims: embedding.length,
    model: echoed || config.model,
    space: `${config.provider}/${config.model}@${embedding.length}#v${config.spec.version}`,
    ...((config.provider === "local" || config.provider === "cloudflare") && isQwen3(config.model)
      ? { min_similarity: QWEN3_FLOOR[config.provider] }
      : {}),
  };
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function main() {
  const config = resolveConfig(process.env);
  // No provider: exit 3 so the hook falls back to keyword overlap. That is the normal
  // state of an install without one, not an error.
  if (!config) process.exit(3);

  const prompt = (await readStdin()).trim();
  if (prompt.length === 0) process.exit(4);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const result = await embed(prompt, config, controller.signal);
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  } catch {
    process.exit(1); // provider failure, timeout, or bad payload
  } finally {
    clearTimeout(timer);
  }
}

if (require.main === module) main().catch(() => process.exit(1));

module.exports = { resolveConfig, request, embed };
