// SPDX-License-Identifier: Apache-2.0
// End-to-end: `init --local` then `setup --local` in a temp home → the
// AI-client MCP config has a pathrule server that names no edition
// and args ending in ["mcp","run"], hooks installed, offline hook-index warmed.
// Real installers (real inject/merge); only the config-file location is
// redirected into the temp dir.

import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ configDir: { value: "" } }));

vi.mock("@pathrule/integrations/mcp-installers/registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@pathrule/integrations/mcp-installers/registry.js")>();
  return {
    ...actual,
    getInstallers: (id: never) =>
      actual.getInstallers(id).map((real, index) => ({
        ...real,
        homeConfigPath: () =>
          join(mocks.configDir.value, `${String(id)}${index > 0 ? `-${index}` : ""}.json`),
      })),
  };
});

import { initLocalWorkspace } from "./init-local.js";
import { parseLocalSetupArgs, runLocalSetup } from "./setup-local.js";

const HOOK_SCRIPT_SOURCE = "#!/usr/bin/env node\n// pathrule-hook test body\n";

describe("parseLocalSetupArgs", () => {
  it("accepts --target, --workspace-name and --import-instructions", () => {
    expect(
      parseLocalSetupArgs([
        "--target",
        "claude",
        "--workspace-name",
        "My Site",
        "--import-instructions",
      ]),
    ).toEqual({ target: "claude", workspaceName: "My Site", importInstructions: true });
    expect(parseLocalSetupArgs([])).toEqual({
      target: null,
      workspaceName: null,
      importInstructions: false,
    });
  });

  it("rejects cloud-only setup options loudly", () => {
    for (const cloudOnly of ["--org", "--workspace", "--create-workspace", "bootstrap"]) {
      expect(() => parseLocalSetupArgs([cloudOnly, "x"])).toThrowError(
        `unknown_setup_option:${cloudOnly}`,
      );
    }
    expect(() => parseLocalSetupArgs(["--target"])).toThrowError("missing_value:--target");
  });
});

describe("runLocalSetup (e2e)", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    tmps.length = 0;
  });

  function freshDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmps.push(dir);
    return dir;
  }

  it("init --local then setup --local wires the MCP entry + hooks, no login", async () => {
    const home = freshDir("pathrule-setup-home-");
    const cwd = freshDir("pathrule-setup-ws-");
    mocks.configDir.value = freshDir("pathrule-setup-clients-");
    const env = { PATHRULE_HOME: home, HOME: freshDir("pathrule-setup-user-") } as NodeJS.ProcessEnv;

    const init = await initLocalWorkspace({ cwd, env, genWorkspaceId: () => "ws-setup-e2e" });
    expect(init.action).toBe("created");

    const result = await runLocalSetup({
      cwd,
      env,
      args: ["--target", "claude"],
      syncOptions: { hookScriptSource: HOOK_SCRIPT_SOURCE },
    });

    expect(result.ok).toBe(true);
    // Idempotent re-entry: setup reused the init'd store.
    expect(result.workspace.action).toBe("exists");
    expect(result.workspace.workspaceId).toBe("ws-setup-e2e");

    // The client MCP config: a pathrule server spawning `... mcp run`, naming no edition (the server
    // resolves each call's folder) and carrying no account keys.
    const config = JSON.parse(
      readFileSync(join(mocks.configDir.value, "claude-code.json"), "utf8"),
    ) as {
      mcpServers?: Record<
        string,
        { command?: string; args?: string[]; env?: Record<string, string> }
      >;
    };
    const entry = config.mcpServers?.pathrule;
    expect(entry).toBeDefined();
    expect(entry?.command).toBe(process.execPath);
    expect(entry?.args?.slice(-2)).toEqual(["mcp", "run"]);
    expect(entry?.env).not.toHaveProperty("PATHRULE_LOCAL");
    expect(entry?.env).not.toHaveProperty("SUPABASE_URL");
    expect(entry?.env).not.toHaveProperty("SUPABASE_ANON_KEY");

    // Hooks + offline index in place.
    expect(existsSync(join(home, "bin", "pathrule-hook.js"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/settings.local.json"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/settings.json"))).toBe(false);
    // `--target claude` writes no other agent's files.
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".codex"))).toBe(false);
    // Signature mode (default): the protocol rides the hook index, not a file in
    // the user's repo. Asserted as absent-here + present-there, together, because
    // either half alone can pass while the workspace has no protocol at all.
    expect(existsSync(join(cwd, ".claude/rules/pathrule-protocol.md"))).toBe(false);
    expect(existsSync(join(home, "cache", "ws-setup-e2e", "hook-index.json"))).toBe(true);
  });

  it("creates the workspace itself when init was skipped (one-command path)", async () => {
    const home = freshDir("pathrule-setup-home-");
    const cwd = freshDir("pathrule-setup-ws-");
    mocks.configDir.value = freshDir("pathrule-setup-clients-");
    const env = { PATHRULE_HOME: home, HOME: freshDir("pathrule-setup-user-") } as NodeJS.ProcessEnv;

    const result = await runLocalSetup({
      cwd,
      env,
      args: ["--target", "claude", "--workspace-name", "Solo"],
      syncOptions: { hookScriptSource: HOOK_SCRIPT_SOURCE },
    });

    expect(result.ok).toBe(true);
    expect(result.workspace.action).toBe("created");
    expect(result.workspace.name).toBe("Solo");
    expect(existsSync(join(home, "cache", result.workspace.workspaceId, "hook-index.json"))).toBe(
      true,
    );
  });

  it("--import-instructions imports a file a workspace with content does not hold yet", async () => {
    const home = freshDir("pathrule-setup-home-");
    const cwd = freshDir("pathrule-setup-ws-");
    mocks.configDir.value = freshDir("pathrule-setup-clients-");
    const env = { PATHRULE_HOME: home, HOME: freshDir("pathrule-setup-user-") } as NodeJS.ProcessEnv;
    writeFileSync(join(cwd, "CLAUDE.md"), "## Style\n\nUse camelCase.\n");
    const setup = (args: string[]) =>
      runLocalSetup({
        cwd,
        env,
        args: ["--target", "claude", ...args],
        syncOptions: { hookScriptSource: HOOK_SCRIPT_SOURCE },
      });

    const first = await setup([]);
    expect(first.workspace.instructions?.imported).toBe(1);

    writeFileSync(join(cwd, "AGENTS.md"), "## Errors\n\nWrap them.\n");
    const plain = await setup([]);
    expect(plain.workspace.instructions?.notImported).toEqual(["AGENTS.md"]);

    const asked = await setup(["--import-instructions"]);
    expect(asked.workspace.instructions).toEqual(
      expect.objectContaining({ imported: 1, notImported: [] }),
    );
  });
});
