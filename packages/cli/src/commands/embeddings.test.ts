// SPDX-License-Identifier: Apache-2.0
// `pathrule embeddings`: a provider is checked with one embedding before it is saved, its key lands
// only in the owner-only credentials file, no output ever carries the key, and `reindex` moves the
// current workspace's memories into the provider's space in resumable steps. The local provider
// runs against a real loopback server, the way Ollama answers.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalBackend } from "@pathrule/core/backend/local/local-backend.js";
import { localRuntimePaths } from "@pathrule/core/storage/paths.js";

import { initLocalWorkspace } from "../local/init-local.js";
import type { CliRuntime } from "../plugin.js";
import { runCli } from "../run.js";
import { parseEmbeddingsArgs } from "./embeddings.js";

class MemoryWriter {
  chunks: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
  toString() {
    return this.chunks.join("");
  }
}

const KEY = "sk-proj-embeddingsTestKey0123456789";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
let home: string;
let env: NodeJS.ProcessEnv;
let server: Server | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pathrule-embeddings-cli-"));
  env = { PATHRULE_HOME: home };
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  rmSync(home, { recursive: true, force: true });
});

async function run(argv: string[], runtime: Partial<CliRuntime> = {}, cwd = "/Users/me/proj") {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const exitCode = await runCli([...argv, "--no-color"], {
    cwd,
    env,
    stdout,
    stderr,
    stdinIsTTY: true,
    ...runtime,
  });
  return {
    exitCode,
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    all: `${stdout}${stderr}`,
  };
}

const vectorFetch = (body: unknown, status = 200) =>
  vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      ({ ok: status < 300, status, json: async () => body }) as unknown as Response,
  );

/** A loopback OpenAI-compatible embeddings server: one axis per topic word. */
async function localServer(): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const { input } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: string };
      const embedding = ["alpha", "beta", "gamma"].map((t) =>
        input.toLowerCase().includes(t) ? 1 : 0.01,
      );
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ embedding }] }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
}

describe("pathrule embeddings use / status / off", () => {
  it("checks and saves a keyed provider from stdin, and never prints the key", async () => {
    const fetchImpl = vectorFetch({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
      model: "text-embedding-3-large",
    });
    const used = await run(["embeddings", "use", "openai"], {
      fetch: fetchImpl,
      stdinIsTTY: false,
      readStdin: async () => `${KEY}\n`,
    });
    expect(used.exitCode).toBe(0);
    expect(used.stdout).toContain("openai/text-embedding-3-large@3#v1");
    expect(used.stdout).toContain("are sent to api.openai.com");
    expect(used.stdout).toContain("pathrule embeddings reindex");
    expect(used.stdout).toContain("pathrule host stop");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const paths = localRuntimePaths(env);
    expect(statSync(paths.embeddingCredentialsFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.embeddingSettingsFile, "utf8")).not.toContain(KEY);

    const status = await run(["embeddings", "status"]);
    const json = await run(["embeddings", "status", "--json"]);
    for (const output of [used.all, status.all, json.all]) {
      expect(output).not.toContain(KEY);
      expect(output).not.toContain(KEY.slice(-8));
    }
    expect(status.stdout).toContain(
      "key:       set (****, stored in embedding-credentials.json, 0600)",
    );
    expect(JSON.parse(json.stdout).data).toMatchObject({
      provider: "openai",
      configured: true,
      space: "openai/text-embedding-3-large@3#v1",
      key: "set",
      endpoint_host: "api.openai.com",
    });

    const off = await run(["embeddings", "off"]);
    expect(off.stdout).toContain("Removed the embedding provider and its stored key");
    expect(() => statSync(paths.embeddingCredentialsFile)).toThrow();
    expect((await run(["embeddings", "status"])).stdout).toContain("Embeddings: off");
  });

  it("saves nothing when the check fails, and the error carries no key", async () => {
    const used = await run(["embeddings", "use", "voyage", "--json"], {
      fetch: vectorFetch({ detail: `bad key ${KEY}` }, 401),
      stdinIsTTY: false,
      readStdin: async () => KEY,
    });
    expect(used.exitCode).toBe(1);
    const body = JSON.parse(used.stdout);
    expect(body.error.code).toBe("embedding_http_401");
    expect(body.error.message).toContain("api.voyageai.com answered HTTP 401");
    expect(used.all).not.toContain(KEY);
    expect(() => statSync(localRuntimePaths(env).embeddingSettingsFile)).toThrow();
  });

  it("refuses to prompt for a key under --json or CI, and takes one from a hidden prompt otherwise", async () => {
    const refused = await run(["embeddings", "use", "voyage", "--json"]);
    expect(refused.exitCode).toBe(64);
    expect(JSON.parse(refused.stdout).error.code).toBe("embedding_key_required");

    const promptSecret = vi.fn(async () => KEY);
    const asked = await run(["embeddings", "use", "cloudflare", "--account-id", ACCOUNT], {
      promptSecret,
      fetch: vectorFetch({
        success: true,
        result: { data: [[0.1, 0.2]], shape: [1, 2] },
        errors: [],
      }),
    });
    expect(asked.exitCode).toBe(0);
    expect(promptSecret).toHaveBeenCalledTimes(1);
    expect(asked.stdout).toContain("cloudflare/@cf/qwen/qwen3-embedding-0.6b@2#v1");
    expect(asked.all).not.toContain(KEY);
    expect(asked.all).not.toContain(ACCOUNT);
  });

  it("refuses a local base URL off this machine and a cloudflare provider without an account", async () => {
    const remote = await run([
      "embeddings",
      "use",
      "local",
      "--base-url",
      "http://192.168.1.20:11434/v1",
    ]);
    expect(remote.exitCode).toBe(64);
    expect(remote.stderr).toContain("must be 127.0.0.1, ::1 or localhost");
    const noAccount = await run(["embeddings", "use", "cloudflare"], {
      stdinIsTTY: false,
      readStdin: async () => KEY,
    });
    expect(noAccount.exitCode).toBe(64);
    expect(noAccount.stderr).toContain("--account-id");
    expect(() => statSync(localRuntimePaths(env).embeddingSettingsFile)).toThrow();
  });

  it("parses options with and without =", () => {
    expect(
      parseEmbeddingsArgs([
        "use",
        "LOCAL",
        "--model=nomic-embed-text",
        "--base-url",
        "http://localhost:1/v1",
      ]),
    ).toEqual({
      sub: "use",
      provider: "local",
      model: "nomic-embed-text",
      baseUrl: "http://localhost:1/v1",
    });
  });
});

describe("pathrule embeddings reindex", () => {
  it("re-embeds the workspace's memories into the local provider's space", async () => {
    const cwd = "/Users/me/proj";
    const { workspaceId } = await initLocalWorkspace({
      cwd,
      env,
      genWorkspaceId: () => "ws-embed",
    });
    const seed = LocalBackend.openForWorkspace(workspaceId, env);
    for (const title of ["alpha notes", "beta notes", "gamma notes"]) {
      await seed.writeMemory({ workspaceId, title, content: `${title} body` });
    }
    seed.close();

    const notConfigured = await run(["embeddings", "reindex"], {}, cwd);
    expect(notConfigured.exitCode).toBe(64);

    const base = await localServer();
    const used = await run(
      ["embeddings", "use", "local", "--model", "nomic-embed-text", "--base-url", base],
      {},
      cwd,
    );
    expect(used.exitCode).toBe(0);
    expect(used.stdout).toContain("stay on this machine");

    const before = await run(["embeddings", "status", "--json"], {}, cwd);
    expect(JSON.parse(before.stdout).data.workspace).toMatchObject({
      memories: 3,
      current: 0,
      missing: 3,
    });

    const reindexed = await run(["embeddings", "reindex"], {}, cwd);
    expect(reindexed.exitCode).toBe(0);
    expect(reindexed.stdout).toContain("Reindex complete: re-embedded 3");

    const after = await run(["embeddings", "status", "--json"], {}, cwd);
    expect(JSON.parse(after.stdout).data.workspace).toMatchObject({
      memories: 3,
      current: 3,
      stale: 0,
      missing: 0,
      space: "local/nomic-embed-text@3#v1",
    });
  });
});
