// SPDX-License-Identifier: Apache-2.0
// `pathrule topics`: a model is checked by naming one sample topic before it is saved, its key lands
// only in the owner-only credentials file, and no output ever carries the key.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readTopicModelSettings,
  topicModelConfig,
  topicModelFiles,
} from "@pathrule/core/storage/topic-model-settings.js";

import type { CliRuntime } from "../plugin.js";
import { runCli } from "../run.js";
import { parseTopicsArgs } from "./topics.js";

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

// Not shaped like a real key: the OSS bundle scanner refuses `sk-ant-` followed by ten or more characters.
const KEY = "sk-ant-test";
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pathrule-topics-cli-"));
  env = { PATHRULE_HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

async function run(argv: string[], runtime: Partial<CliRuntime> = {}) {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const exitCode = await runCli([...argv, "--no-color"], {
    cwd: "/Users/me/proj",
    env,
    stdout,
    stderr,
    stdinIsTTY: false,
    ...runtime,
  });
  return { exitCode, all: `${stdout}${stderr}` };
}

const claude = (text: string, status = 200) =>
  vi.fn(
    async () => new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status }),
  );

describe("pathrule topics", () => {
  it("parses its options", () => {
    expect(
      parseTopicsArgs(["use", "LOCAL", "--model", "llama3.2", "--base-url=http://x/v1"]),
    ).toEqual({
      sub: "use",
      provider: "local",
      model: "llama3.2",
      baseUrl: "http://x/v1",
    });
  });

  it("is off until a model is connected", async () => {
    const result = await run(["topics"]);
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain("Topic names: off");
  });

  it("checks Claude with a sample topic, then keeps the key apart, owner-only and out of every output", async () => {
    const fetch = claude('{"t1":"Release & deploy"}');
    const used = await run(["topics", "use", "anthropic"], {
      fetch: fetch as unknown as typeof globalThis.fetch,
      readStdin: async () => `${KEY}\n`,
    });
    expect(used.exitCode).toBe(0);
    expect(used.all).toContain("“Release & deploy”");
    expect(used.all).not.toContain(KEY);
    const files = topicModelFiles(env);
    expect(readFileSync(files.settings, "utf8")).not.toContain(KEY);
    expect(JSON.parse(readFileSync(files.credentials, "utf8"))).toMatchObject({
      provider: "anthropic",
      api_key: KEY,
    });
    if (process.platform !== "win32") {
      expect(statSync(files.credentials).mode & 0o777).toBe(0o600);
      expect(statSync(files.settings).mode & 0o777).toBe(0o600);
    }
    expect(topicModelConfig(env)).toMatchObject({ provider: "anthropic", apiKey: KEY });

    const status = await run(["topics", "status"]);
    expect(status.all).toContain("anthropic");
    expect(status.all).toContain("set (****");
    expect(status.all).not.toContain(KEY);

    const off = await run(["topics", "off"]);
    expect(off.all).toContain("Removed the topic model");
    expect(readTopicModelSettings(env)).toBeNull();
  });

  it("saves nothing when the model cannot answer", async () => {
    const result = await run(["topics", "use", "anthropic"], {
      fetch: claude("", 401) as unknown as typeof globalThis.fetch,
      readStdin: async () => KEY,
    });
    expect(result.exitCode).toBe(1);
    expect(result.all).toContain("Nothing was saved. The model answered HTTP 401.");
    expect(readTopicModelSettings(env)).toBeNull();
  });

  it("asks a local model for its name, with no key", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: '{"t1":"Yayın ve dağıtım"}' } }] }),
        ),
    );
    const result = await run(["topics", "use", "local", "--model", "qwen3"], {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result.exitCode).toBe(0);
    expect(topicModelConfig(env)).toEqual({ provider: "local", model: "qwen3" });
    const missing = await run(["topics", "use", "openai"]);
    expect(missing.exitCode).toBe(64);
    expect(missing.all).toContain("needs a model");
  });
});
