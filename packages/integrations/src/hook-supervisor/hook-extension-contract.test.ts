// SPDX-License-Identifier: Apache-2.0
// The hook's side of the extension contract (@pathrule/protocol/hook-extension.ts).
//
// The hook ships as one file and cannot import the contract, so its loader carries the version and the
// file names as literals; this pins them to the protocol. The rest drives the real hook with
// extensions that must NOT be used: one that speaks another contract version, and one that fails to
// load. Either is logged and treated as missing, and the agent's turn is unaffected.
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOOK_EXTENSION_CONTRACT, HOOK_EXTENSION_FILES } from "@pathrule/protocol/hook-extension.js";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "77777777-7777-4777-8777-777777777777";

let home: string;
let wsRoot: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "pathrule-hook-ext-"));
  wsRoot = join(home, "project");
  await mkdir(wsRoot, { recursive: true });
  const cacheDir = join(home, "cache", WS_ID);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, "hook-index.json"),
    JSON.stringify({
      workspace_id: WS_ID,
      workspace_root: wsRoot,
      generated_at: "2026-10-06T00:00:00.000Z",
      session_digest: "",
      project_rules: [{ id: "r-1", name: "Use pnpm for every install", preview: "pnpm, never npm.", priority: "high", enforcement: "advisory" }],
      path_memories: {},
      path_rules: {},
      recent_subjects: [],
    }),
  );
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A bin directory holding the hook and the given extension files. */
async function binWith(name: string, extensions: Record<string, string>): Promise<string> {
  const bin = join(home, `bin-${name}`);
  await mkdir(bin, { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, join(bin, "pathrule-hook.js"));
  for (const [file, body] of Object.entries(extensions)) await writeFile(join(bin, file), body);
  return join(bin, "pathrule-hook.js");
}

function runPrompt(hookScript: string, sessionId: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      { env: { ...process.env, PATHRULE_HOME: home, PATHRULE_NAVIGATION: "on" }, timeout: 10_000 },
      (error, stdout) => resolve({ code: error && typeof error.code === "number" ? error.code : 0, stdout }),
    );
    child.stdin!.end(
      JSON.stringify({
        cwd: wsRoot,
        prompt: "which package manager do we install dependencies with",
        session_id: sessionId,
        hook_event_name: "UserPromptSubmit",
      }),
    );
  });
}

async function hookLog(): Promise<string> {
  const dir = join(home, "logs");
  const files = await readdir(dir).catch(() => [] as string[]);
  const bodies = await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
  return bodies.join("");
}

describe("the hook extension contract", () => {
  it("carries the protocol's contract version and file names", async () => {
    const hook = await readFile(HOOK_SCRIPT_SOURCE, "utf8");
    expect(hook).toContain(`const HOOK_EXTENSION_CONTRACT = ${HOOK_EXTENSION_CONTRACT};`);
    expect(hook).toContain(
      `const HOOK_EXTENSION_FILES = { cloud: "${HOOK_EXTENSION_FILES.cloud}" };`,
    );
  });

  it("ignores an extension built for another contract version, and logs it", async () => {
    const open = await runPrompt(await binWith("open", {}), "s-open");
    const mismatched = await runPrompt(
      await binWith("mismatch", {
        [HOOK_EXTENSION_FILES.cloud]: `module.exports = { contract: ${HOOK_EXTENSION_CONTRACT + 1}, create() { throw new Error("must not be created"); } };`,
      }),
      "s-mismatch",
    );
    expect(mismatched.code).toBe(0);
    expect(mismatched.stdout).toBe(open.stdout);
    expect(open.stdout).toContain("Use pnpm for every install");
    expect(await hookLog()).toContain(`contract_mismatch:${HOOK_EXTENSION_CONTRACT + 1}`);
  });

  it("survives an extension that fails to load, and logs it", async () => {
    const open = await runPrompt(await binWith("open-2", {}), "s-open-2");
    const broken = await runPrompt(
      await binWith("broken", { [HOOK_EXTENSION_FILES.cloud]: "this is not javascript {" }),
      "s-broken",
    );
    expect(broken.code).toBe(0);
    expect(broken.stdout).toBe(open.stdout);
    expect(await hookLog()).toMatch(/\textension\tcloud\t\d+ms\tload_error/);
  });
});
