// SPDX-License-Identifier: Apache-2.0
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sharedMocks = vi.hoisted(() => ({
  setHookCommand: vi.fn(),
}));

// hook-script-install.ts imports setHookCommand from the subpath
// module (not the barrel) so the OSS closure stays barrel-free; mock the
// module it actually imports.
vi.mock("@pathrule/integrations/hook-supervisor/hook-command.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@pathrule/integrations/hook-supervisor/hook-command.js")>();
  return {
    ...actual,
    setHookCommand: sharedMocks.setHookCommand,
  };
});

import {
  __WINDOWS_CMD_SHIM_FOR_TESTS,
  installCliHookScript,
  resolveCliHookScriptPaths,
} from "./hook-script-install.js";

describe("resolveCliHookScriptPaths", () => {
  it("returns POSIX paths and registers the .js path on linux/darwin", () => {
    const paths = resolveCliHookScriptPaths({
      PATHRULE_HOME: "/Users/pat/.pathrule",
      PATHRULE_TEST_PLATFORM: "linux",
    } as NodeJS.ProcessEnv);
    expect(paths.binDir).toBe("/Users/pat/.pathrule/bin");
    expect(paths.scriptPath).toBe("/Users/pat/.pathrule/bin/pathrule-hook.js");
    expect(paths.shimPath).toBeNull();
    expect(paths.hookCommandPath).toBe(paths.scriptPath);
  });

  it("returns Windows paths and registers the .cmd shim on win32", () => {
    const paths = resolveCliHookScriptPaths({
      PATHRULE_HOME: "C:\\Users\\Pat Smith\\.pathrule",
      PATHRULE_TEST_PLATFORM: "win32",
    } as NodeJS.ProcessEnv);
    expect(paths.binDir).toBe("C:\\Users\\Pat Smith\\.pathrule\\bin");
    expect(paths.scriptPath).toBe("C:\\Users\\Pat Smith\\.pathrule\\bin\\pathrule-hook.js");
    expect(paths.shimPath).toBe("C:\\Users\\Pat Smith\\.pathrule\\bin\\pathrule-hook.cmd");
    // The contract: setHookCommand receives the .cmd path on
    // Windows. AI clients that spawn hooks without a shell (Codex) can
    // execute a .cmd directly; a bare .js path would ENOENT silently.
    expect(paths.hookCommandPath).toBe(paths.shimPath);
  });
});

describe("Windows shim format", () => {
  it('is fixture-locked to @echo off + node "%~dp0pathrule-hook.js" %*', () => {
    expect(__WINDOWS_CMD_SHIM_FOR_TESTS).toBe(`@echo off\nnode "%~dp0pathrule-hook.js" %*\n`);
  });
});

describe("installCliHookScript on POSIX", () => {
  let home: string;

  beforeEach(async () => {
    sharedMocks.setHookCommand.mockClear();
    home = await mkdtemp(join(tmpdir(), "pathrule hook home "));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("materializes the hook script and registers its absolute path", async () => {
    const env = { PATHRULE_HOME: home, PATHRULE_TEST_PLATFORM: "linux" } as NodeJS.ProcessEnv;
    const result = await installCliHookScript(env, { scriptSource: "console.log('hook')\n" });

    expect(result.scriptPath).toBe(`${home}/bin/pathrule-hook.js`);
    expect(result.shimPath).toBeNull();
    expect(result.hookCommandPath).toBe(result.scriptPath);
    expect(result.changed).toBe(true);
    await expect(readFile(result.scriptPath, "utf8")).resolves.toBe("console.log('hook')\n");
    expect(sharedMocks.setHookCommand).toHaveBeenCalledWith(result.scriptPath);
  });

  it("is idempotent — unchanged source returns changed=false", async () => {
    const env = { PATHRULE_HOME: home, PATHRULE_TEST_PLATFORM: "linux" } as NodeJS.ProcessEnv;
    const source = "console.log('hook')\n";
    const first = await installCliHookScript(env, { scriptSource: source });
    expect(first.changed).toBe(true);
    const second = await installCliHookScript(env, { scriptSource: source });
    expect(second.changed).toBe(false);
  });

  // `pnpm --filter @pathrule/cli dev` runs the CLI from source, where no build embedded the hook:
  // setup --local used to fail there with "hook script source is empty".
  it("installs the checkout's own hook and embed helper when run from source", async () => {
    const env = { PATHRULE_HOME: home, PATHRULE_TEST_PLATFORM: "linux" } as NodeJS.ProcessEnv;
    await installCliHookScript(env);
    const hookDir = new URL("../../integrations/src/hook-supervisor/", import.meta.url);
    expect(await readFile(`${home}/bin/pathrule-hook.js`, "utf8")).toBe(
      await readFile(new URL("pathrule-hook.js", hookDir), "utf8"),
    );
    expect(await readFile(`${home}/bin/embed-query.cjs`, "utf8")).toBe(
      await readFile(new URL("embed-query.cjs", hookDir), "utf8"),
    );
  });

  it("throws when the embedded source is empty and no override is supplied", async () => {
    const env = { PATHRULE_HOME: home, PATHRULE_TEST_PLATFORM: "linux" } as NodeJS.ProcessEnv;
    await expect(installCliHookScript(env, { scriptSource: "" })).rejects.toThrow(/empty/);
  });

  it("writes embed-query.cjs next to the hook so semantic injection is not silently lexical", async () => {
    const env = { PATHRULE_HOME: home, PATHRULE_TEST_PLATFORM: "linux" } as NodeJS.ProcessEnv;
    await installCliHookScript(env, {
      scriptSource: "console.log('hook')\n",
      embedHelperSource: "module.exports = 1\n",
    });
    await expect(readFile(`${home}/bin/embed-query.cjs`, "utf8")).resolves.toBe(
      "module.exports = 1\n",
    );
  });

  it("writes the hook's extensions next to it, and nothing whose name could leave the directory", async () => {
    const env = { PATHRULE_HOME: home, PATHRULE_TEST_PLATFORM: "linux" } as NodeJS.ProcessEnv;
    await installCliHookScript(env, {
      scriptSource: "console.log('hook')\n",
      embedHelperSource: "",
      extensionSources: { "pathrule-hook-cloud.cjs": "module.exports = 2\n", "../escape.cjs": "x\n" },
    });
    await expect(readFile(`${home}/bin/pathrule-hook-cloud.cjs`, "utf8")).resolves.toBe("module.exports = 2\n");
    await expect(access(`${home}/escape.cjs`)).rejects.toThrow();
  });

  it("removes the engine extension an old install left beside the hook, and never writes it", async () => {
    const env = { PATHRULE_HOME: home, PATHRULE_TEST_PLATFORM: "linux" } as NodeJS.ProcessEnv;
    await mkdir(`${home}/bin`, { recursive: true });
    await writeFile(`${home}/bin/pathrule-hook-engine.cjs`, "module.exports = { contract: 1 };\n");
    await installCliHookScript(env, {
      scriptSource: "console.log('hook')\n",
      embedHelperSource: "",
      extensionSources: { "pathrule-hook-engine.cjs": "module.exports = 3\n" },
    });
    await expect(access(`${home}/bin/pathrule-hook-engine.cjs`)).rejects.toThrow();
    await expect(readFile(`${home}/bin/pathrule-hook.js`, "utf8")).resolves.toBe("console.log('hook')\n");
  });

  it("skips the embed helper when its source is empty (degrades to lexical, no crash)", async () => {
    const env = { PATHRULE_HOME: home, PATHRULE_TEST_PLATFORM: "linux" } as NodeJS.ProcessEnv;
    await installCliHookScript(env, { scriptSource: "console.log('hook')\n", embedHelperSource: "" });
    await expect(access(`${home}/bin/embed-query.cjs`)).rejects.toThrow();
  });
});
