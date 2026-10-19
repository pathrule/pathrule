// SPDX-License-Identifier: Apache-2.0
// embed-query.cjs, the hook's self-contained prompt embedder: the same four providers, the same
// configuration sources and the same space keys as core's adapter, and its exit-code contract
// (0 vector · 1 failure · 3 no provider · 4 empty prompt). The local provider runs against a real
// loopback server, the way Ollama answers.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "embed-query.cjs");
const helper = createRequire(import.meta.url)(HELPER) as {
  resolveConfig(
    env: NodeJS.ProcessEnv,
  ): { provider: string; model: string; apiKey: string | null } | null;
  request(config: unknown, input: string): { url: string; body: unknown; redirect?: string };
};

let home: string;
let server: Server | null = null;
let seen: Array<{ url: string; auth: string | undefined; body: Record<string, unknown> }> = [];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pathrule-embed-query-"));
  seen = [];
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A loopback OpenAI-compatible embeddings server. Returns its base URL. */
async function localServer(): Promise<string> {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      seen.push({ url: req.url ?? "", auth: req.headers.authorization, body });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ embedding: [0.6, 0.8, 0] }], model: body.model }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
}

function run(env: Record<string, string>, prompt = "how do retries work?") {
  return new Promise<{ code: number; out: Record<string, unknown> | null }>((resolve) => {
    const child = execFile(
      process.execPath,
      [HELPER],
      { env: { PATH: process.env.PATH ?? "", PATHRULE_HOME: home, ...env }, timeout: 10_000 },
      (error, stdout) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({
          code,
          out: stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : null,
        });
      },
    );
    child.stdin!.end(prompt);
  });
}

describe("embed-query.cjs", () => {
  it("embeds the prompt with a local server, sends no key, and reports the space and the floor", async () => {
    const base = await localServer();
    const { code, out } = await run({
      PATHRULE_EMBEDDING_PROVIDER: "local",
      PATHRULE_EMBEDDING_BASE_URL: base,
      PATHRULE_EMBEDDING_API_KEY: "sk-not-for-local",
    });
    expect(code).toBe(0);
    expect(seen).toEqual([
      {
        url: "/v1/embeddings",
        auth: undefined,
        body: { model: "qwen3-embedding:0.6b", input: "how do retries work?" },
      },
    ]);
    expect(out).toEqual({
      embedding: [0.6, 0.8, 0],
      dims: 3,
      model: "qwen3-embedding:0.6b",
      space: "local/qwen3-embedding:0.6b@3#v1",
      min_similarity: 0.45,
    });
  });

  it("reads the machine files the CLI writes when the environment names no provider", async () => {
    const base = await localServer();
    await writeFile(
      join(home, "embedding.json"),
      JSON.stringify({
        schema_version: 1,
        provider: "local",
        model: "nomic-embed-text",
        base_url: base,
      }),
    );
    const { code, out } = await run({});
    expect(code).toBe(0);
    expect(out).toMatchObject({ space: "local/nomic-embed-text@3#v1" });
    expect(out).not.toHaveProperty("min_similarity");
  });

  it("exits 3 with no provider, a missing key, or a base URL off this machine", async () => {
    expect((await run({})).code).toBe(3);
    expect((await run({ PATHRULE_EMBEDDING_PROVIDER: "openai" })).code).toBe(3);
    expect(
      (
        await run({
          PATHRULE_EMBEDDING_PROVIDER: "local",
          PATHRULE_EMBEDDING_BASE_URL: "http://10.0.0.2:11434/v1",
        })
      ).code,
    ).toBe(3);
    // A stored key belongs to its provider only.
    await writeFile(
      join(home, "embedding-credentials.json"),
      JSON.stringify({ schema_version: 1, provider: "voyage", api_key: "vk-file" }),
    );
    expect((await run({ PATHRULE_EMBEDDING_PROVIDER: "openai" })).code).toBe(3);
  });

  it("exits 4 on an empty prompt and 1 when the provider fails", async () => {
    const base = await localServer();
    expect(
      (
        await run(
          { PATHRULE_EMBEDDING_PROVIDER: "local", PATHRULE_EMBEDDING_BASE_URL: base },
          "   ",
        )
      ).code,
    ).toBe(4);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    expect(
      (await run({ PATHRULE_EMBEDDING_PROVIDER: "local", PATHRULE_EMBEDDING_BASE_URL: base })).code,
    ).toBe(1);
  });

  it("builds each provider's query request like core's adapter", () => {
    const account = "0123456789abcdef0123456789abcdef";
    const configFor = (env: Record<string, string>) =>
      helper.resolveConfig({ PATHRULE_HOME: home, ...env })!;
    const cloudflare = configFor({
      PATHRULE_EMBEDDING_PROVIDER: "cloudflare",
      PATHRULE_EMBEDDING_API_KEY: "cf-token",
      PATHRULE_EMBEDDING_ACCOUNT_ID: account,
    });
    expect(helper.request(cloudflare, "p")).toEqual({
      url: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/qwen/qwen3-embedding-0.6b`,
      body: { queries: ["p"] },
    });
    const bge = configFor({
      PATHRULE_EMBEDDING_PROVIDER: "cloudflare",
      PATHRULE_EMBEDDING_API_KEY: "cf-token",
      PATHRULE_EMBEDDING_ACCOUNT_ID: account,
      PATHRULE_EMBEDDING_MODEL: "@cf/baai/bge-m3",
    });
    expect(helper.request(bge, "p").body).toEqual({ text: ["p"] });
    const voyage = configFor({
      PATHRULE_EMBEDDING_PROVIDER: "voyage",
      PATHRULE_EMBEDDING_API_KEY: "vk",
    });
    expect(helper.request(voyage, "p")).toEqual({
      url: "https://api.voyageai.com/v1/embeddings",
      body: { input: "p", model: "voyage-3-large", output_dtype: "float", input_type: "query" },
    });
    const openai = configFor({
      PATHRULE_EMBEDDING_PROVIDER: "openai",
      PATHRULE_EMBEDDING_API_KEY: "sk",
    });
    expect(helper.request(openai, "p")).toEqual({
      url: "https://api.openai.com/v1/embeddings",
      body: { input: "p", model: "text-embedding-3-large", encoding_format: "float" },
    });
    expect(
      configFor({
        PATHRULE_EMBEDDING_PROVIDER: "cloudflare",
        PATHRULE_EMBEDDING_API_KEY: "cf-token",
        PATHRULE_EMBEDDING_ACCOUNT_ID: "../../evil",
      } as Record<string, string>),
    ).toBeNull();
  });
});
