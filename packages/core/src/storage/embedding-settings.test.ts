// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearEmbeddingSettings,
  readEmbeddingCredentials,
  readEmbeddingSettings,
  writeEmbeddingSettings,
} from "./embedding-settings.js";
import { localRuntimePaths } from "./paths.js";

let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), "pathrule-embedding-settings-")), "home");
  env = { PATHRULE_HOME: root };
});
afterEach(async () => {
  await rm(join(root, ".."), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("embedding settings", () => {
  it("keeps the key alone in an owner-only credentials file, never in the settings", async () => {
    await writeEmbeddingSettings(
      {
        provider: "cloudflare",
        model: "@cf/qwen/qwen3-embedding-0.6b",
        account_id: "a".repeat(32),
        dims: 1024,
      },
      "cf-secret-token-value",
      env,
    );
    const paths = localRuntimePaths(env);
    if (process.platform !== "win32") expect((await stat(paths.embeddingCredentialsFile)).mode & 0o777).toBe(0o600);
    if (process.platform !== "win32") expect((await stat(paths.embeddingSettingsFile)).mode & 0o777).toBe(0o600);
    if (process.platform !== "win32") expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect(await readFile(paths.embeddingSettingsFile, "utf8")).not.toContain(
      "cf-secret-token-value",
    );
    expect(readEmbeddingSettings(env)).toMatchObject({ provider: "cloudflare", dims: 1024 });
    expect(readEmbeddingCredentials(env)).toEqual({
      schema_version: 1,
      provider: "cloudflare",
      api_key: "cf-secret-token-value",
    });
  });

  it("drops a stored key when the new provider takes none", async () => {
    await writeEmbeddingSettings(
      { provider: "openai", model: "text-embedding-3-large" },
      "sk-old",
      env,
    );
    await writeEmbeddingSettings({ provider: "local", model: "qwen3-embedding:0.6b" }, null, env);
    expect(readEmbeddingCredentials(env)).toBeNull();
    expect(readEmbeddingSettings(env)?.provider).toBe("local");
  });

  it("clears both files and says whether there was a setting", async () => {
    expect(await clearEmbeddingSettings(env)).toBe(false);
    await writeEmbeddingSettings({ provider: "voyage", model: "voyage-3-large" }, "vk", env);
    expect(await clearEmbeddingSettings(env)).toBe(true);
    expect(readEmbeddingSettings(env)).toBeNull();
    expect(readEmbeddingCredentials(env)).toBeNull();
  });
});
