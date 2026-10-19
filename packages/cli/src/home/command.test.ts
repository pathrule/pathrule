// SPDX-License-Identifier: Apache-2.0
// Bare `pathrule` and `pathrule home`: help exactly as before for pipes, CI and --json; the home for
// a person; and the home's flows driven by scripted keys in a scratch Pathrule home, where nothing
// loads the built-in capability (a fake whose plugin does not load) and nothing changes
// without a yes.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLI_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import { CapabilityHost, installCapabilityHost } from "../capabilities/host.js";
import { readFolderChoices, recordFolderChoice } from "@pathrule/core/workspace/folder-mode.js";
import { readSelection } from "../capabilities/selection.js";
import { setupCommand } from "../commands/workspace-local.js";
import { integrationsCommand } from "../commands/integrations.js";
import {
  CLI_SHARED_PACKAGES,
  installCliPlugins,
  type CliCommand,
  type CliCommandContext,
  type CliRuntime,
  type CommandPlugin,
} from "../plugin.js";
import { runCli } from "../run.js";
import { scriptedKeys } from "../terminal/keys.js";
import { TerminalUi } from "../terminal/ui.js";
import { stripAnsi } from "../terminal/text.js";
import { homeCommand, homeJson, runHome } from "./command.js";
import { connectAgents, groupArgs, signIn, switchPlan } from "./intelligence-mode.js";

/** Output with the setup rail's line prefixes folded away, so a wrapped sentence reads as one. */
function unrailed(text: string): string {
  return text.replace(/\s*\n[│|] {0,2}/g, " ");
}

class Writer {
  chunks: string[] = [];
  constructor(
    readonly isTTY = false,
    readonly columns = 100,
    readonly rows = 60,
  ) {}
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
  toString() {
    return stripAnsi(this.chunks.join(""));
  }
}

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-home-cmd-")));
  env = {
    PATH: "",
    HOME: join(dir, "user"),
    PATHRULE_HOME: join(dir, ".pathrule"),
    LANG: "en_US.UTF-8",
  };
  mkdirSync(env.HOME!, { recursive: true });
  mkdirSync(env.PATHRULE_HOME!, { recursive: true });
});

afterEach(() => {
  installCapabilityHost(null);
  installCliPlugins([]);
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function runtimeWith(stdout: Writer, extra: Partial<CliRuntime> = {}): CliRuntime {
  return { cwd: dir, env, stdout, stderr: new Writer(), stdinIsTTY: stdout.isTTY, ...extra };
}

describe("bare pathrule", () => {
  it("prints help exactly as `pathrule help` when stdout is not a terminal", async () => {
    const bare = new Writer(false);
    const help = new Writer(false);
    expect(await runCli([], runtimeWith(bare))).toBe(0);
    expect(await runCli(["help"], runtimeWith(help))).toBe(0);
    expect(bare.toString()).toBe(help.toString());
    expect(bare.toString()).toContain("Usage:\n  pathrule <command> [options]");
  });

  it("prints help with piped stdin, in CI, with --json, and for --help, even at a terminal", async () => {
    const spy = vi.spyOn(homeCommand, "run");
    const piped = new Writer(true);
    await runCli([], runtimeWith(piped, { stdinIsTTY: false }));
    expect(piped.toString()).toContain("Usage:");
    const ci = new Writer(true);
    await runCli([], runtimeWith(ci, { env: { ...env, CI: "true" } }));
    expect(ci.toString()).toContain("Usage:");
    const json = new Writer(true);
    await runCli(["--json"], runtimeWith(json));
    expect(JSON.parse(json.toString())).toMatchObject({ ok: true, command: "help" });
    const flag = new Writer(true);
    await runCli(["--help"], runtimeWith(flag));
    expect(flag.toString()).toContain("Usage:");
    const dumb = new Writer(true);
    await runCli([], runtimeWith(dumb, { env: { ...env, TERM: "dumb" } }));
    expect(dumb.toString()).toContain("Usage:");
    expect(spy).not.toHaveBeenCalled();
  });

  it("opens the home for a person at a terminal", async () => {
    const spy = vi.spyOn(homeCommand, "run").mockResolvedValue(0);
    const out = new Writer(true);
    expect(await runCli([], runtimeWith(out))).toBe(0);
    expect(spy).toHaveBeenCalledOnce();
    expect(out.toString()).not.toContain("Usage:");
  });

  it("lists home in help, and last in help --json after every command in its old order", async () => {
    const text = new Writer();
    await runCli(["help"], runtimeWith(text));
    expect(text.toString()).toContain("home          Project home");
    const json = new Writer();
    await runCli(["help", "--json"], runtimeWith(json));
    const commands: string[] = JSON.parse(json.toString()).data.commands;
    expect(commands.indexOf("home")).toBe(commands.length - 1);
  });
});

describe("pathrule home --json", () => {
  it("prints the facts as one envelope, with the unmeasured as such and next steps", async () => {
    const host = new CapabilityHost({ env, loadPlugin: unavailable });
    installCapabilityHost(host);
    await host.readSelection();
    const out = new Writer();
    expect(await runCli(["home", "--json"], runtimeWith(out))).toBe(0);
    const envelope = JSON.parse(out.chunks.join(""));
    expect(envelope).toMatchObject({
      ok: true,
      command: "home",
      data: {
        schema: 1,
        workspace: { kind: "none" },
        intelligence: { mode: "unset" },
        knowledge: { state: "unavailable" },
        context: {
          deliveredTokens: { state: "not_measured" },
          agentIrTokens: { state: "not_measured" },
          compression: { state: "not_measured" },
        },
      },
    });
    expect(envelope.next_steps.map((s: { command: string }) => s.command)).toEqual([
      "pathrule setup --cloud",
      "pathrule setup --local",
      "pathrule integrations",
    ]);
  });
});

const unavailable = async (): Promise<never> => {
  throw new Error("the built-in plugin did not load");
};

function homeCtx(stdout: Writer): CliCommandContext {
  const runtime = runtimeWith(stdout, { stdinIsTTY: false });
  return {
    command: "home",
    args: [],
    flags: {
      json: false,
      yes: false,
      noOpen: true,
      deviceCode: false,
      browserCallback: false,
      help: false,
      version: false,
      color: false,
      interactive: true,
      local: false,
      cloud: false,
      noIntelligence: false,
      all: false,
      apply: false,
    },
    runtime,
    mode: { json: false, color: false, interactive: true, noOpen: true },
  };
}

describe("the home in a terminal", { timeout: 60_000 }, () => {
  it("welcomes a new machine, and q leaves with nothing written", async () => {
    const host = new CapabilityHost({ env, loadPlugin: unavailable });
    installCapabilityHost(host);
    await host.readSelection();
    const before = readdirSync(env.PATHRULE_HOME!).sort();
    const out = new Writer(true);
    expect(await runHome(homeCtx(out), { keys: scriptedKeys(["q"]) })).toBe(0);
    const text = unrailed(out.toString());
    // The logo first, then one line on what Pathrule is and one on what it found.
    expect(out.toString()).toContain("⢀⣠⣶⣿⣿⠟⠛⢿⣿⣷⣦⣀");
    expect(text).toContain("The context layer for your coding agents.");
    expect(text).toContain("No supported coding agent found on this machine yet.");
    expect(text).toContain("Set up Pathrule");
    // On the setup rail: it starts, asks on it, and ends.
    expect(out.toString()).toMatch(
      /^┌ {2}Setup takes a minute\. Nothing changes until you choose\./m,
    );
    expect(out.toString()).toMatch(/^└ {2}Nothing changed\./m);
    expect(readdirSync(env.PATHRULE_HOME!).sort()).toEqual(before);
    expect(readSelection(env)).toBeNull();
  });

  it("runs the first run offline: Local installs nothing, hands agents to integrations, ends without launching an agent", async () => {
    const host = new CapabilityHost({ env, loadPlugin: unavailable });
    installCapabilityHost(host);
    await host.readSelection();
    const out = new Writer(true);
    // s: set up; l: Local; a key; then q.
    const code = await runHome(homeCtx(out), { keys: scriptedKeys(["s", "l", "x", "q"]) });
    expect(code).toBe(0);
    const text = unrailed(out.toString());
    expect(text).toMatch(/◆ {2}Choose your mode +step 1/);
    expect(text).not.toMatch(/could not be installed|model|Pathrule Intelligence/);
    expect(text).toMatch(/◆ {2}Connect your coding agents +step 2 of 2/);
    // Without a terminal to ask in, the integrations command lists and changes nothing.
    expect(text).toContain("Coding agents on this machine:");
    expect(text).toContain("Open Claude Code, Codex or Cursor as usual.");
    // An answered question folds to its answer, and the rail ends where setup does.
    expect(text).toMatch(/◇ {2}Choose your mode +Local/);
    expect(out.toString()).toMatch(/^└ {2}✓ Pathrule is set up as Local\./m);
    expect(text).not.toMatch(/launching|starting claude|starting codex/i);
    // Setup ran for this folder: its choice is recorded, and the device default is untouched.
    expect(readFolderChoices(env)).toEqual([expect.objectContaining({ root: dir, mode: "local" })]);
    expect(readSelection(env)).toBeNull();
    expect(existsSync(join(env.PATHRULE_HOME!, "integrations", "registry.json"))).toBe(false);
  });

  it("stops before any change when Cloud cannot be loaded", async () => {
    // A build that names a Cloud, whose plugin cannot load here.
    env.PATHRULE_NATIVE_CLOUD_URL = "https://cloud.example";
    env.PATHRULE_NATIVE_DEVICE_CLIENT_ID = "pathrule-test";
    const host = new CapabilityHost({ env, loadPlugin: unavailable });
    installCapabilityHost(host);
    await host.readSelection();
    const out = new Writer(true);
    await runHome(homeCtx(out), { keys: scriptedKeys(["s", "c", "x", "q"]) });
    const text = out.toString();
    expect(text).toContain("Pathrule Cloud could not be loaded");
    expect(text).toContain("Nothing else changed.");
    expect(text).not.toContain("step 2 of 3");
    expect(readSelection(env)).toBeNull();
    expect(readFolderChoices(env)).toEqual([]);
  });

  it("shows the dashboard once a mode is chosen, and the mode switch changes nothing on no", async () => {
    recordFolderChoice(env, dir, "local", "setup");
    const host = new CapabilityHost({ env, loadPlugin: unavailable });
    installCapabilityHost(host);
    await host.readSelection();
    const out = new Writer(true);
    // m: mode; c: Cloud; n: do not switch; a key back; q.
    await runHome(homeCtx(out), { keys: scriptedKeys(["m", "c", "n", "x", "q"]) });
    const text = out.toString();
    expect(text).toContain("Project home");
    expect(text).toMatch(/Local .* on this machine, no account, open source/);
    expect(text).toContain("Switch this folder to Pathrule Cloud");
    expect(unrailed(text)).toMatch(/copies\s+it\s+only\s+if\s+you\s+approve/);
    expect(text).toContain("Nothing changed.");
    expect(readFolderChoices(env)).toEqual([expect.objectContaining({ mode: "local" })]);
  });

  it("refreshes, ignores unknown keys with a hint, and quits on Ctrl-C", async () => {
    recordFolderChoice(env, dir, "local", "setup");
    const host = new CapabilityHost({ env, loadPlugin: unavailable });
    installCapabilityHost(host);
    await host.readSelection();
    const out = new Writer(true);
    expect(await runHome(homeCtx(out), { keys: scriptedKeys(["r", "z", "\x03"]) })).toBe(0);
    expect(out.toString()).toContain('No action on "z".');
  });
});

describe("the cockpit", { timeout: 60_000 }, () => {
  /** A person at a real terminal: stdin and stdout are TTYs, so the full screen can open. */
  function cockpitCtx(stdout: Writer): CliCommandContext {
    const ctx = homeCtx(stdout);
    return { ...ctx, runtime: { ...ctx.runtime, stdinIsTTY: true } };
  }

  it("opens full screen once set up, moves between panels, and gives the screen back on quit", async () => {
    recordFolderChoice(env, dir, "local", "setup");
    const host = new CapabilityHost({ env, loadPlugin: unavailable });
    installCapabilityHost(host);
    await host.readSelection();
    const out = new Writer(true, 100, 30);
    // An unknown key, Tab to Agents, then q.
    expect(await runHome(cockpitCtx(out), { keys: scriptedKeys(["z", "\t", "q"]) })).toBe(0);
    const raw = out.chunks.join("");
    expect(raw.startsWith("\x1b[?1049h")).toBe(true);
    expect(raw.endsWith("\x1b[?25h\x1b[?1049l")).toBe(true);
    const text = out.toString();
    for (const title of ["Knowledge", "Agents", "Context delivered", "Needs you"]) {
      expect(text).toContain(title);
    }
    expect(text).toContain('No action on "z".');
    expect(text).toContain("No agent connected");
    // Tab moved the focus: the last frame frames Agents in the accent, so its title is drawn again.
    expect(raw.lastIndexOf("Agents")).toBeGreaterThan(raw.indexOf("Agents"));
  });

  it("leaves the full screen before a flow, so the flow's output stays in the scrollback", async () => {
    recordFolderChoice(env, dir, "local", "setup");
    const host = new CapabilityHost({ env, loadPlugin: unavailable });
    installCapabilityHost(host);
    await host.readSelection();
    const out = new Writer(true, 100, 30);
    // m: mode; c: Cloud; n: do not switch; a key back; q.
    await runHome(cockpitCtx(out), { keys: scriptedKeys(["m", "c", "n", "x", "q"]) });
    const raw = out.chunks.join("");
    const left = raw.indexOf("\x1b[?1049l");
    expect(left).toBeGreaterThan(0);
    expect(raw.indexOf("Switch this folder to Pathrule Cloud")).toBeGreaterThan(left);
    // The flow ran on the rail, and the home came back full screen after it.
    expect(stripAnsi(raw)).toMatch(/┌ {2}◆ Pathrule +Mode/);
    expect(raw.indexOf("\x1b[?1049h", left)).toBeGreaterThan(left);
  });

  it("keeps the one-column home on a terminal too small for panels", async () => {
    recordFolderChoice(env, dir, "local", "setup");
    const host = new CapabilityHost({ env, loadPlugin: unavailable });
    installCapabilityHost(host);
    await host.readSelection();
    const out = new Writer(true, 70, 40);
    await runHome(cockpitCtx(out), { keys: scriptedKeys(["q"]) });
    expect(out.chunks.join("")).not.toContain("\x1b[?1049h");
    expect(out.toString()).toContain("Project home");
  });
});

describe("mode switching", () => {
  it("says what moves and what does not, both ways: this folder only, and nothing from Cloud", () => {
    const toCloud = switchPlan("local", "cloud");
    expect(toCloud.does.join(" ")).toContain("pathrule setup --cloud for this folder");
    expect(toCloud.does.join(" ")).toContain("copies it only if you approve");
    expect(toCloud.doesNot.join(" ")).toContain("Delete your Local workspace");
    const toLocal = switchPlan("cloud", "local");
    expect(toLocal.doesNot.join(" ")).toContain("Copy anything from Pathrule Cloud");
    expect(toLocal.doesNot.join(" ")).toContain("your Cloud session stays");
  });

  it("re-applies each recorded integration in its own scope, project and channel", () => {
    expect(
      groupArgs({
        scope: "user",
        projectRoot: null,
        channel: "plugin",
        mcp: true,
        mode: "local",
        providers: ["claude-code", "codex"],
      }),
    ).toEqual(["add", "claude-code", "codex", "--scope", "user", "--channel", "plugin"]);
    expect(
      groupArgs({
        scope: "project",
        projectRoot: "/p",
        channel: "settings",
        mcp: false,
        mode: "cloud",
        providers: ["codex"],
      }),
    ).toEqual([
      "add",
      "codex",
      "--scope",
      "project",
      "--project",
      "/p",
      "--channel",
      "settings",
      "--no-mcp",
    ]);
  });
});

describe("homeJson", () => {
  it("is deterministic for the same home", async () => {
    const ctx = homeCtx(new Writer());
    const now = () => Date.parse("2026-10-10T12:00:00Z");
    const a = await homeJson(ctx, { now });
    const b = await homeJson(ctx, { now });
    expect(a.envelope).toEqual(b.envelope);
  });
});

/** An account edition and its `login`, for flows that must never reach a real account. */
function fakeAccount(logins: number[]) {
  let signedIn = false;
  const login: CliCommand = {
    name: "login",
    run: async () => {
      const code = logins.shift() ?? 1;
      if (code === 0) signedIn = true;
      return code;
    },
  };
  return {
    calls: () => logins,
    plugin: {
      name: "cloud",
      contract: CLI_PLUGIN_CONTRACT,
      sharedPackages: CLI_SHARED_PACKAGES,
      commands: [login],
      account: {
        commands: {},
        mcpEntry: () => ({ type: "stdio" as const, command: "pathrule", args: ["mcp", "run"] }),
        afterInstall: async () => {},
        doctorChecks: async () => [],
        doctorNextStep: () => null,
        authorizeSupportBundle: async () => {},
        configUser: async () => "user",
        signedInUser: async () => (signedIn ? "user-1" : null),
      },
    } satisfies CommandPlugin,
  };
}

describe("Cloud sign-in", () => {
  it("offers a retry after a failed sign-in, and stops when signed in", async () => {
    const account = fakeAccount([1, 0]);
    installCliPlugins([account.plugin]);
    const out = new Writer(true);
    const ctx = homeCtx(out);
    const ui = new TerminalUi({
      runtime: ctx.runtime,
      profile: {
        interactive: true,
        color: false,
        unicode: true,
        cursor: false,
        plain: false,
        columns: 100,
        rows: 60,
      },
      keys: scriptedKeys(["s", "s"]),
    });
    expect(await signIn(ui, ctx)).toBe("signed_in");
    expect(out.toString()).toContain("Sign-in did not finish");
    expect(out.toString()).not.toMatch(/token|refresh_token|access_token/i);
  });

  it("can be left for later, and says how", async () => {
    installCliPlugins([fakeAccount([]).plugin]);
    const out = new Writer(true);
    const ctx = homeCtx(out);
    const ui = new TerminalUi({
      runtime: ctx.runtime,
      profile: {
        interactive: true,
        color: false,
        unicode: true,
        cursor: false,
        plain: false,
        columns: 100,
        rows: 60,
      },
      keys: scriptedKeys(["l"]),
    });
    expect(await signIn(ui, ctx)).toBe("skipped");
    expect(out.toString()).toContain("pathrule login");
  });

  it("says sign-in is unavailable when Cloud is not loaded", async () => {
    const out = new Writer(true);
    const ctx = homeCtx(out);
    const ui = new TerminalUi({
      runtime: ctx.runtime,
      profile: {
        interactive: true,
        color: false,
        unicode: true,
        cursor: false,
        plain: false,
        columns: 100,
        rows: 60,
      },
      keys: scriptedKeys([]),
    });
    expect(await signIn(ui, ctx)).toBe("unavailable");
  });
});

describe("handing agents to pathrule integrations", () => {
  it("passes the mode as flags and the subcommand as args, never --yes, so its handover keeps working", async () => {
    const spy = vi.spyOn(integrationsCommand, "run").mockResolvedValue(0);
    const ctx = homeCtx(new Writer(true));
    const ui = new TerminalUi({
      runtime: ctx.runtime,
      profile: {
        interactive: true,
        color: false,
        unicode: true,
        cursor: false,
        plain: false,
        columns: 100,
        rows: 60,
      },
      keys: scriptedKeys([]),
    });
    await connectAgents(ui, ctx, "local");
    await connectAgents(ui, ctx, "cloud", ["doctor"]);
    const [first, second] = spy.mock.calls.map(([c]) => c);
    expect(first).toMatchObject({
      command: "integrations",
      args: [],
      flags: { local: true, cloud: false, yes: false, json: false },
    });
    expect(second).toMatchObject({
      command: "integrations",
      args: ["doctor"],
      flags: { local: false, cloud: true, yes: false },
    });
  });

  it("hands a confirmed switch to pathrule setup for this folder, and re-points no integration itself", async () => {
    recordFolderChoice(env, dir, "local", "setup");
    const host = new CapabilityHost({ env, loadPlugin: unavailable });
    installCapabilityHost(host);
    await host.readSelection();
    const setup = vi.spyOn(setupCommand, "run").mockResolvedValue(0);
    const integrations = vi.spyOn(integrationsCommand, "run").mockResolvedValue(0);
    const out = new Writer(true);
    // m: mode; c: Cloud; y: switch; a key back; q.
    await runHome(homeCtx(out), { keys: scriptedKeys(["m", "c", "y", "x", "q"]) });
    expect(setup).toHaveBeenCalledOnce();
    expect(setup.mock.calls[0]![0]).toMatchObject({ command: "setup", flags: { cloud: true, local: false, yes: false } });
    expect(integrations).not.toHaveBeenCalled();
  });
});

describe("plain text for screen readers (PATHRULE_PLAIN=1)", { timeout: 60_000 }, () => {
  function plainCtx(answers: string[]) {
    const out = new Writer(true);
    const prompts: string[] = [];
    const ctx = homeCtx(out);
    ctx.runtime.env = { ...env, PATHRULE_PLAIN: "1" };
    ctx.runtime.promptLine = async (prompt: string) => {
      prompts.push(prompt);
      return answers.shift() ?? "q";
    };
    return { out, prompts, ctx };
  }

  it("asks the welcome as a numbered list answered by a line, with no escapes or redraws", async () => {
    const host = new CapabilityHost({ env, loadPlugin: unavailable });
    installCapabilityHost(host);
    await host.readSelection();
    const { out, prompts, ctx } = plainCtx(["q"]);
    expect(await runHome(ctx, { keys: scriptedKeys([]) })).toBe(0);
    const raw = out.chunks.join("");
    expect(raw).not.toContain("\x1b[");
    expect(raw).toContain(
      "1. Set up Pathrule (s): choose Cloud or Local, then connect your agents",
    );
    expect(raw).not.toMatch(/[─━]{3,}|-{10,}/);
    expect(prompts[0]).toMatch(/^Choose 1-3 or a letter/);
  });

  it("prints the home once and takes actions by letter", async () => {
    recordFolderChoice(env, dir, "local", "setup");
    const host = new CapabilityHost({ env, loadPlugin: unavailable });
    installCapabilityHost(host);
    await host.readSelection();
    const { out, prompts, ctx } = plainCtx(["z", "q"]);
    expect(await runHome(ctx, { keys: scriptedKeys([]) })).toBe(0);
    const raw = out.chunks.join("");
    expect(raw).not.toContain("\x1b[");
    expect(raw.match(/Project home/g)).toHaveLength(1);
    expect(raw).toContain('No action on "z".');
    expect(prompts).toEqual(["Action: ", "Action: "]);
  });
});

describe("Ctrl-C inside a handed-off flow", () => {
  it("is a calm cancel back to the home, not a stack trace", async () => {
    recordFolderChoice(env, dir, "local", "setup");
    const host = new CapabilityHost({ env, loadPlugin: unavailable });
    installCapabilityHost(host);
    await host.readSelection();
    // readline/promises rejects a pending question with an AbortError on Ctrl-C.
    vi.spyOn(integrationsCommand, "run").mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), {
        code: "ABORT_ERR",
        name: "AbortError",
      }),
    );
    const out = new Writer(true);
    // a: agents; c: connect (the wizard is stopped with Ctrl-C); a key back; q.
    expect(await runHome(homeCtx(out), { keys: scriptedKeys(["a", "c", "x", "q"]) })).toBe(0);
    expect(out.toString()).toContain(
      "Canceled. Anything already applied stays; nothing else changed.",
    );
  });
});
