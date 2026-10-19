// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalVectorSpace,
  currentEmbeddingSpace,
  embeddingConfigStatus,
  embeddingSpaceKey,
  embedTextBYO,
  hasEmbeddingKey,
  storedVectorInSpace,
  truncateEmbeddingInput,
} from "./embedding-adapter.js";

// Every case reads its files from an empty home of its own, never the developer's ~/.pathrule.
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pathrule-embedding-adapter-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const env = (vars: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ PATHRULE_HOME: home, ...vars }) as NodeJS.ProcessEnv;
const VOYAGE = { PATHRULE_EMBEDDING_PROVIDER: "voyage", PATHRULE_EMBEDDING_API_KEY: "vk-test" };
const OPENAI = { PATHRULE_EMBEDDING_PROVIDER: "openai", PATHRULE_EMBEDDING_API_KEY: "sk-test" };
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const CLOUDFLARE = {
  PATHRULE_EMBEDDING_PROVIDER: "cloudflare",
  PATHRULE_EMBEDDING_API_KEY: "cf-token-test",
  PATHRULE_EMBEDDING_ACCOUNT_ID: ACCOUNT,
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

const okFetch = (body: unknown) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse(body));
const sent = (fetchImpl: ReturnType<typeof okFetch>) => {
  const [url, init] = fetchImpl.mock.calls[0]!;
  return {
    url: String(url),
    init: init as RequestInit,
    body: JSON.parse((init as RequestInit).body as string) as Record<string, unknown>,
    headers: (init as RequestInit).headers as Record<string, string>,
  };
};

function writeSettings(
  settings: Record<string, unknown>,
  credentials?: Record<string, unknown>,
): void {
  writeFileSync(join(home, "embedding.json"), JSON.stringify({ schema_version: 1, ...settings }));
  if (credentials) {
    writeFileSync(
      join(home, "embedding-credentials.json"),
      JSON.stringify({ schema_version: 1, ...credentials }),
    );
  }
}

describe("embedding-adapter", () => {
  it("hasEmbeddingKey is false without a provider/key and true with both", () => {
    expect(hasEmbeddingKey(env())).toBe(false);
    expect(hasEmbeddingKey(env({ PATHRULE_EMBEDDING_PROVIDER: "voyage" }))).toBe(false);
    expect(hasEmbeddingKey(env(VOYAGE))).toBe(true);
    // Unknown provider name ⇒ OFF.
    expect(
      hasEmbeddingKey(
        env({ PATHRULE_EMBEDDING_PROVIDER: "cohere", PATHRULE_EMBEDDING_API_KEY: "x" }),
      ),
    ).toBe(false);
    // local needs no key.
    expect(hasEmbeddingKey(env({ PATHRULE_EMBEDDING_PROVIDER: "local" }))).toBe(true);
  });

  it("returns null when no key/provider is configured (capability unwired)", async () => {
    const fetchImpl = vi.fn();
    const result = await embedTextBYO("hello", { inputType: "query" }, { env: env(), fetchImpl });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls Voyage with input_type and returns the native-dimension vector", async () => {
    const fetchImpl = okFetch({ data: [{ embedding: [0.1, 0.2, 0.3] }], model: "voyage-3-large" });
    const result = await embedTextBYO(
      "doc text",
      { inputType: "document" },
      { env: env(VOYAGE), fetchImpl },
    );
    expect(result).toEqual({
      embedding: [0.1, 0.2, 0.3],
      model: "voyage-3-large",
      dims: 3,
      space: "voyage/voyage-3-large@3#v1",
    });
    const { url, body, headers } = sent(fetchImpl);
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(body).toEqual({
      input: "doc text",
      model: "voyage-3-large",
      output_dtype: "float",
      input_type: "document",
    });
    expect(headers.Authorization).toBe("Bearer vk-test");
  });

  it("calls OpenAI (no input_type knob) and returns the vector", async () => {
    const fetchImpl = okFetch({
      data: [{ embedding: [1, 2, 3, 4] }],
      model: "text-embedding-3-large",
    });
    const result = await embedTextBYO("q", { inputType: "query" }, { env: env(OPENAI), fetchImpl });
    expect(result?.dims).toBe(4);
    expect(result?.space).toBe("openai/text-embedding-3-large@4#v1");
    expect(result?.minSimilarity).toBeUndefined();
    const { url, body } = sent(fetchImpl);
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(body).toEqual({ input: "q", model: "text-embedding-3-large", encoding_format: "float" });
  });

  it("throws on a provider HTTP error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 429));
    await expect(
      embedTextBYO("x", { inputType: "query" }, { env: env(VOYAGE), fetchImpl }),
    ).rejects.toThrow(/voyage_http_429/);
  });

  it("throws on empty input before any fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(
      embedTextBYO("   ", { inputType: "query" }, { env: env(VOYAGE), fetchImpl }),
    ).rejects.toThrow(/empty/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws on a non-numeric / empty vector", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ embedding: ["nope"] }] }));
    await expect(
      embedTextBYO("x", { inputType: "query" }, { env: env(VOYAGE), fetchImpl }),
    ).rejects.toThrow(/non_numeric|invalid/);
  });
});

describe("local provider", () => {
  it("posts {model, input} to the default Ollama endpoint, with no key and no redirect", async () => {
    const fetchImpl = okFetch({ data: [{ embedding: [0.5, 0.5] }], model: "qwen3-embedding:0.6b" });
    const result = await embedTextBYO(
      "a memory",
      { inputType: "document" },
      // A key in the environment is never sent to a local server.
      {
        env: env({ PATHRULE_EMBEDDING_PROVIDER: "local", PATHRULE_EMBEDDING_API_KEY: "sk-test" }),
        fetchImpl,
      },
    );
    const { url, body, headers, init } = sent(fetchImpl);
    expect(url).toBe("http://127.0.0.1:11434/v1/embeddings");
    expect(body).toEqual({ model: "qwen3-embedding:0.6b", input: "a memory" });
    expect(headers.Authorization).toBeUndefined();
    expect(init.redirect).toBe("error");
    expect(result).toMatchObject({ space: "local/qwen3-embedding:0.6b@2#v1", minSimilarity: 0.45 });
  });

  it("accepts every loopback host and keeps the path of the base URL", async () => {
    for (const base of [
      "http://localhost:1234/v1/",
      "http://[::1]:8080/v1",
      "https://127.0.0.1/api/v1",
    ]) {
      const fetchImpl = okFetch({ data: [{ embedding: [1] }] });
      await embedTextBYO(
        "x",
        { inputType: "query" },
        {
          env: env({ PATHRULE_EMBEDDING_PROVIDER: "local", PATHRULE_EMBEDDING_BASE_URL: base }),
          fetchImpl,
        },
      );
      expect(sent(fetchImpl).url).toBe(`${base.replace(/\/+$/, "")}/embeddings`);
    }
  });

  it("refuses a base URL off this machine before any request", async () => {
    for (const base of [
      "http://192.168.1.5:11434/v1",
      "http://127.0.0.1.example.com/v1",
      "https://api.openai.com/v1",
      "http://user:pass@127.0.0.1:11434/v1",
      "file:///tmp/x",
    ]) {
      const local = env({
        PATHRULE_EMBEDDING_PROVIDER: "local",
        PATHRULE_EMBEDDING_BASE_URL: base,
      });
      const fetchImpl = vi.fn();
      expect(await embedTextBYO("x", { inputType: "query" }, { env: local, fetchImpl })).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(embeddingConfigStatus(local).reason).toMatch(/non_loopback_base_url|invalid_base_url/);
    }
  });
});

describe("cloudflare provider", () => {
  const vector = { success: true, result: { data: [[0.1, 0.2, 0.3]], shape: [1, 3] }, errors: [] };

  it("sends qwen3 documents as {documents} and queries as {queries} to the account's run URL", async () => {
    const doc = okFetch(vector);
    const docResult = await embedTextBYO(
      "a memory",
      { inputType: "document" },
      { env: env(CLOUDFLARE), fetchImpl: doc },
    );
    expect(sent(doc).url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/qwen/qwen3-embedding-0.6b`,
    );
    expect(sent(doc).body).toEqual({ documents: ["a memory"] });
    expect(sent(doc).headers.Authorization).toBe("Bearer cf-token-test");
    expect(docResult).toEqual({
      embedding: [0.1, 0.2, 0.3],
      model: "@cf/qwen/qwen3-embedding-0.6b",
      dims: 3,
      space: "cloudflare/@cf/qwen/qwen3-embedding-0.6b@3#v1",
      minSimilarity: 0.35,
    });

    const query = okFetch(vector);
    await embedTextBYO(
      "a prompt",
      { inputType: "query" },
      { env: env(CLOUDFLARE), fetchImpl: query },
    );
    expect(sent(query).body).toEqual({ queries: ["a prompt"] });
  });

  it("sends any other model one {text} list, and keeps today's floor for it", async () => {
    const fetchImpl = okFetch(vector);
    const result = await embedTextBYO(
      "a prompt",
      { inputType: "query" },
      { env: env({ ...CLOUDFLARE, PATHRULE_EMBEDDING_MODEL: "@cf/baai/bge-m3" }), fetchImpl },
    );
    expect(sent(fetchImpl).url).toMatch(/\/ai\/run\/@cf\/baai\/bge-m3$/);
    expect(sent(fetchImpl).body).toEqual({ text: ["a prompt"] });
    expect(result?.minSimilarity).toBeUndefined();
  });

  it("treats success:false and a non-2xx as failures", async () => {
    await expect(
      embedTextBYO(
        "x",
        { inputType: "query" },
        {
          env: env(CLOUDFLARE),
          fetchImpl: okFetch({ success: false, result: null, errors: [{ code: 1 }] }),
        },
      ),
    ).rejects.toThrow(/cloudflare_unsuccessful/);
    await expect(
      embedTextBYO(
        "x",
        { inputType: "query" },
        {
          env: env(CLOUDFLARE),
          fetchImpl: vi.fn(async () => jsonResponse({}, false, 403)),
        },
      ),
    ).rejects.toThrow(/cloudflare_http_403/);
  });

  it("is unconfigured without a valid account id", () => {
    const { PATHRULE_EMBEDDING_ACCOUNT_ID: _omit, ...noAccount } = CLOUDFLARE;
    expect(embeddingConfigStatus(env(noAccount)).reason).toBe("missing_account_id");
    expect(
      embeddingConfigStatus(env({ ...CLOUDFLARE, PATHRULE_EMBEDDING_ACCOUNT_ID: "../../x" }))
        .reason,
    ).toBe("invalid_account_id");
  });
});

describe("configuration sources", () => {
  it("reads the machine files when the environment names no provider", async () => {
    writeSettings(
      { provider: "voyage", model: "voyage-3.5", dims: 3 },
      { provider: "voyage", api_key: "vk-file" },
    );
    const fetchImpl = okFetch({ data: [{ embedding: [1, 0, 0] }] });
    const result = await embedTextBYO("x", { inputType: "query" }, { env: env(), fetchImpl });
    expect(sent(fetchImpl).headers.Authorization).toBe("Bearer vk-file");
    expect(sent(fetchImpl).body.model).toBe("voyage-3.5");
    expect(result?.space).toBe("voyage/voyage-3.5@3#v1");
    const status = embeddingConfigStatus(env());
    expect(status).toMatchObject({
      configured: true,
      provider: "voyage",
      space: "voyage/voyage-3.5@3#v1",
      sources: { provider: "file", key: "file" },
      endpointHost: "api.voyageai.com",
    });
  });

  it("puts each environment variable before the file", async () => {
    writeSettings(
      { provider: "voyage", model: "voyage-3.5" },
      { provider: "voyage", api_key: "vk-file" },
    );
    const fetchImpl = okFetch({ data: [{ embedding: [1] }] });
    await embedTextBYO(
      "x",
      { inputType: "query" },
      { env: env({ PATHRULE_EMBEDDING_MODEL: "voyage-code-3" }), fetchImpl },
    );
    expect(sent(fetchImpl).body.model).toBe("voyage-code-3");

    // Another provider in the environment: the file's model and its stored key are not used.
    const other = okFetch({ data: [{ embedding: [1] }] });
    await embedTextBYO("x", { inputType: "query" }, { env: env(OPENAI), fetchImpl: other });
    expect(sent(other).url).toContain("openai.com");
    expect(sent(other).body.model).toBe("text-embedding-3-large");
    expect(sent(other).headers.Authorization).toBe("Bearer sk-test");
  });

  it("never hands a stored key to another provider", () => {
    writeSettings({ provider: "voyage" }, { provider: "voyage", api_key: "vk-file" });
    expect(embeddingConfigStatus(env({ PATHRULE_EMBEDDING_PROVIDER: "openai" }))).toMatchObject({
      configured: false,
      reason: "missing_key",
      key: "missing",
    });
  });

  it("reads the environment alone, and only the allowed providers, when the caller asks", () => {
    writeSettings({ provider: "local" });
    expect(hasEmbeddingKey(env(), { machineConfig: false })).toBe(false);
    expect(hasEmbeddingKey(env(CLOUDFLARE), { providers: ["voyage", "openai"] })).toBe(false);
    expect(hasEmbeddingKey(env(VOYAGE), { providers: ["voyage", "openai"] })).toBe(true);
  });

  it("status describes the provider and never carries the key", () => {
    const status = embeddingConfigStatus(env(CLOUDFLARE));
    expect(status).toMatchObject({
      configured: true,
      key: "set",
      endpointHost: "api.cloudflare.com",
      spaceFamily: "cloudflare/@cf/qwen/qwen3-embedding-0.6b#v1",
      descriptor: {
        provider: "cloudflare",
        keyRequired: true,
        inputTypesDiffer: true,
        distance: "cosine",
        normalized: "unknown",
        spaceVersion: 1,
        minSimilarity: 0.35,
      },
    });
    const text = JSON.stringify(status);
    expect(text).not.toContain("cf-token-test");
    expect(text).not.toContain(ACCOUNT);
  });
});

describe("vector spaces", () => {
  const voyage = { provider: "voyage" as const, model: "voyage-3-large", version: 1 };

  it("never treats two spaces of one dimension as one", () => {
    const key = embeddingSpaceKey(
      { provider: "local", model: "qwen3-embedding:0.6b", version: 1 },
      1024,
    );
    expect(storedVectorInSpace({ model: key, dims: 1024 }, key, 1024)).toBe(true);
    expect(
      storedVectorInSpace(
        { model: "cloudflare/@cf/qwen/qwen3-embedding-0.6b@1024#v1", dims: 1024 },
        key,
        1024,
      ),
    ).toBe(false);
    expect(storedVectorInSpace({ model: key, dims: 1024 }, key.replace("#v1", "#v2"), 1024)).toBe(
      false,
    );
  });

  it("accepts a legacy row only where its bare model name can mean nothing else", () => {
    const space = embeddingSpaceKey(voyage, 1024);
    expect(storedVectorInSpace({ model: "voyage-3-large", dims: 1024 }, space, 1024)).toBe(true);
    expect(storedVectorInSpace({ model: "voyage-3-large", dims: 512 }, space, 1024)).toBe(false);
    expect(storedVectorInSpace({ model: "voyage-3.5", dims: 1024 }, space, 1024)).toBe(false);
    expect(
      storedVectorInSpace(
        { model: "text-embedding-3-large", dims: 3072 },
        "openai/text-embedding-3-large@3072#v1",
        3072,
      ),
    ).toBe(true);
    // The same name under another provider, a custom name, or a newer space version: stale.
    expect(
      storedVectorInSpace(
        { model: "text-embedding-3-large", dims: 3072 },
        "local/text-embedding-3-large@3072#v1",
        3072,
      ),
    ).toBe(false);
    expect(
      storedVectorInSpace({ model: "my-embedder", dims: 1024 }, "local/my-embedder@1024#v1", 1024),
    ).toBe(false);
    expect(
      storedVectorInSpace(
        { model: "voyage-3-large", dims: 1024 },
        "voyage/voyage-3-large@1024#v2",
        1024,
      ),
    ).toBe(false);
    expect(canonicalVectorSpace({ model: "voyage-3-large", dims: 1024 })).toBe(space);
  });

  it("picks the configured family's space, or the most held one for a custom seam", () => {
    const groups = [
      { model: "voyage-3-large", dims: 1024, count: 2 },
      { model: embeddingSpaceKey(voyage, 1024), dims: 1024, count: 1 },
      { model: "local/qwen3-embedding:0.6b@1024#v1", dims: 1024, count: 5 },
    ];
    expect(currentEmbeddingSpace(groups, voyage, false)).toEqual({
      key: embeddingSpaceKey(voyage, 1024),
      dims: 1024,
    });
    expect(currentEmbeddingSpace(groups, null, true)?.key).toBe(
      "local/qwen3-embedding:0.6b@1024#v1",
    );
    expect(currentEmbeddingSpace(groups, null, false)).toBeNull();
    expect(currentEmbeddingSpace([], voyage, false)).toBeNull();
  });

  it("cuts long input at a character boundary", () => {
    expect(truncateEmbeddingInput("abcdef", 4)).toBe("abcd");
    // A surrogate pair is never split in half.
    expect(truncateEmbeddingInput("ab\u{1F600}cd", 3)).toBe("ab");
    expect(truncateEmbeddingInput("short", 10)).toBe("short");
  });

  it("sends at most the provider's input limit", async () => {
    const fetchImpl = okFetch({ data: [{ embedding: [1] }] });
    await embedTextBYO("x".repeat(50_000), { inputType: "query" }, { env: env(OPENAI), fetchImpl });
    expect((sent(fetchImpl).body.input as string).length).toBe(24000);
  });
});
