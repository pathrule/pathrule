// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CORE_PACKAGE } from "@pathrule/core/package-instance.js";
import { MCP_PACKAGE } from "@pathrule/mcp/package-instance.js";
import { DuplicatePackageError, packageInstance } from "@pathrule/protocol/package-instance.js";
import { CLI_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLI_PACKAGE } from "./package-instance.js";
import {
  CLI_SHARED_PACKAGES,
  checkCliPlugins,
  cliAccount,
  cliHookExtensions,
  cliPassiveUpdateNotice,
  installCliPlugins,
  loadCliPlugins,
  type CliAccountEdition,
  type CliCommand,
  type CommandPlugin,
} from "./plugin.js";
import { runCli } from "./run.js";

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

// A home no test writes to: nothing on this machine decides a folder's edition in these tests.
const EMPTY_HOME = join(tmpdir(), `pathrule-plugin-test-home-${process.pid}`);

function run(argv: string[], plugins: CommandPlugin[], env: NodeJS.ProcessEnv = { PATHRULE_HOME: EMPTY_HOME }) {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const code = runCli(argv, { cwd: "/repo", env, stdout, stderr }, { plugins });
  return code.then((exitCode) => ({
    exitCode,
    stdout: stdout.toString(),
    stderr: stderr.toString(),
  }));
}

const plugin = (overrides: Partial<CommandPlugin>): CommandPlugin => ({
  name: "test",
  contract: CLI_PLUGIN_CONTRACT,
  sharedPackages: [],
  ...overrides,
});

const echo = (name: string, extra: Partial<CliCommand> = {}): CliCommand => ({
  name,
  run: async ({ runtime, args }) => {
    runtime.stdout.write(`${name}:${args.join(",")}\n`);
    return 0;
  },
  ...extra,
});

/** An account edition whose call sites say which one ran. */
function account(commands: CliAccountEdition["commands"]): CliAccountEdition {
  return {
    commands,
    mcpEntry: () => ({ type: "stdio", command: "account", args: [] }),
    afterInstall: async () => {},
    doctorChecks: async () => [],
    doctorNextStep: () => null,
    authorizeSupportBundle: async () => {},
    configUser: async () => "user-1",
    signedInUser: async () => "user-1",
  };
}

describe("the plugin registry", () => {
  afterEach(() => installCliPlugins([]));

  it("refuses a plugin built for another contract", () => {
    expect(() => installCliPlugins([plugin({ contract: CLI_PLUGIN_CONTRACT + 1 })])).toThrow(
      /built for contract/,
    );
  });

  it("shares one copy of cli, core, integrations and mcp with its plugins", () => {
    expect(CLI_SHARED_PACKAGES.map((p) => p.name)).toEqual([
      "@pathrule/cli",
      "@pathrule/core",
      "@pathrule/integrations",
      "@pathrule/mcp",
    ]);
    expect(() =>
      installCliPlugins([plugin({ sharedPackages: [CLI_PACKAGE, CORE_PACKAGE, MCP_PACKAGE] })]),
    ).not.toThrow();
  });

  it("refuses a plugin that resolved a second copy of a shared package, before activating it", () => {
    const activate = vi.fn();
    const secondCore = packageInstance(
      "@pathrule/core",
      "file:///prefix/node_modules/@pathrule/intelligence-engine/node_modules/@pathrule/core/dist/package-instance.js",
    );
    const engine = plugin({ name: "intelligence-engine", activate, sharedPackages: [secondCore] });
    expect(() => installCliPlugins([engine])).toThrow(DuplicatePackageError);
    expect(() => checkCliPlugins([engine])).toThrow(
      /The CLI plugin "intelligence-engine" loaded a second copy of @pathrule\/core/,
    );
    expect(activate).not.toHaveBeenCalled();
  });

  it("turns the daily update notice on only when an installed plugin asks for it", () => {
    installCliPlugins([plugin({})]);
    expect(cliPassiveUpdateNotice()).toBe(false);
    installCliPlugins([plugin({}), plugin({ name: "feed", passiveUpdateNotice: true })]);
    expect(cliPassiveUpdateNotice()).toBe(true);
  });

  it("refuses a second account edition", () => {
    const edition = account({});
    expect(() =>
      installCliPlugins([
        plugin({ name: "a", account: edition }),
        plugin({ name: "b", account: edition }),
      ]),
    ).toThrow(/account edition; got a, b/);
  });

  it("activates each plugin once, when it is installed, and replaces the earlier set", () => {
    const activate = vi.fn();
    installCliPlugins([plugin({ activate, account: account({}) })]);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(cliAccount()).not.toBeNull();
    installCliPlugins([]);
    expect(cliAccount()).toBeNull();
  });

  it("merges the hook extensions the plugins ship", () => {
    installCliPlugins([
      plugin({ name: "a", hookExtensions: () => ({ "a.cjs": "a" }) }),
      plugin({ name: "b", hookExtensions: () => ({ "b.cjs": "b" }) }),
    ]);
    expect(cliHookExtensions()).toEqual({ "a.cjs": "a", "b.cjs": "b" });
  });

  it("loads deferred plugins in order", async () => {
    const loaded = await loadCliPlugins([
      async () => plugin({ name: "late" }),
      plugin({ name: "now" }),
    ]);
    expect(loaded.map((p) => p.name)).toEqual(["late", "now"]);
  });
});

describe("the router", () => {
  afterEach(() => installCliPlugins([]));

  it("runs a plugin command, and lists it in help by section and rank", async () => {
    const hello = echo("hello", {
      help: { section: "account", rank: 10, summary: "Say hello" },
      jsonRank: 25,
    });
    expect(await run(["hello", "a", "b"], [plugin({ commands: [hello] })])).toMatchObject({
      exitCode: 0,
      stdout: "hello:a,b\n",
    });
    const help = await run(["help"], [plugin({ commands: [hello] })]);
    expect(help.stdout).toContain("Account & Context:\n  hello         Say hello\n");
    const json = JSON.parse(
      (await run(["help", "--json"], [plugin({ commands: [hello] })])).stdout,
    );
    expect(json.data.commands.slice(0, 3)).toEqual(["help", "version", "hello"]);
  });

  it("refuses a plugin command that takes an open command's name", async () => {
    await expect(run(["help"], [plugin({ commands: [echo("doctor")] })])).rejects.toThrow(
      /"doctor" is defined twice/,
    );
  });

  it("answers --json for a command without a JSON form with unknown_command", async () => {
    const result = await run(["hello", "--json"], [plugin({ commands: [echo("hello")] })]);
    expect(result.exitCode).toBe(64);
    expect(JSON.parse(result.stdout).error.code).toBe("unknown_command");
  });

  it("runs a knowledge command in the folder's edition, and never runs --local in a Cloud folder", async () => {
    const edition = account({ memory: echo("account-memory") });
    const root = await mkdtemp(join(tmpdir(), "pathrule-cli-router-"));
    // A build that names a Cloud: a folder with nothing of its own is a Pathrule Cloud folder.
    const cloud = {
      PATHRULE_HOME: root,
      PATHRULE_NATIVE_CLOUD_URL: "https://cloud.example",
      PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-test",
    };
    try {
      const accountRun = await run(["memory", "list"], [plugin({ account: edition })], cloud);
      expect(accountRun.stdout).toBe("account-memory:list\n");

      const mismatch = await run(["memory", "list", "--local", "--no-color"], [plugin({ account: edition })], cloud);
      expect(mismatch.exitCode).toBe(64);
      expect(mismatch.stdout).toBe("");
      expect(mismatch.stderr).toContain("uses Pathrule Cloud");
      expect(mismatch.stderr).toContain("pathrule setup --local");

      // No Cloud named: the folder is a Pathrule Local folder, served by the open command.
      const localRun = await run(["memory", "list", "--no-color"], [plugin({ account: edition })], { PATHRULE_HOME: root });
      expect(localRun.stdout).toBe("");
      expect(localRun.stderr).toContain("No local Pathrule workspace covers this folder");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("adds a plugin's subcommand to an open command, in its place in the usage line", async () => {
    const teach = { rank: 20, run: async () => 7 };
    const result = await run(["me", "teach", "x"], [plugin({ subcommands: { me: { teach } } })]);
    expect(result.exitCode).toBe(7);
    const usage = await run(
      ["me", "nope", "--no-color"],
      [plugin({ subcommands: { me: { teach } } })],
    );
    expect(usage.stderr).toContain("try: list | teach | explain | forget | scope");
  });

  it("tells every plugin's telemetry what ran, in the terminal and as JSON", async () => {
    const commandFinished = vi.fn(async () => {});
    const telemetry = { commandFinished, doctorFinished: async () => {} };
    await run(["version"], [plugin({ telemetry })]);
    await run(["nope", "--json"], [plugin({ telemetry })]);
    expect(commandFinished.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      expect.objectContaining({ command: "version", exitCode: 0 }),
      expect.objectContaining({ command: "nope", exitCode: 64 }),
    ]);
  });

  it("lists a plugin's help topics and options", async () => {
    const result = await run(
      ["help", "--no-color"],
      [
        plugin({
          helpTopics: [{ name: "web", rank: 20, text: "Web\n" }],
          helpOptions: [{ rank: 40, text: "--plugin-flag  Does a thing" }],
        }),
      ],
    );
    expect(result.stdout).toContain("help          Show this help, help for one command, or for web/cli");
    expect(result.stdout).toContain(
      "  --no-open   Do not open browser windows\n  --plugin-flag  Does a thing\n",
    );
    expect(
      (
        await run(
          ["help", "web"],
          [plugin({ helpTopics: [{ name: "web", rank: 20, text: "Web\n" }] })],
        )
      ).stdout,
    ).toBe("Web\n");
  });
});

describe("the open CLI, with no plugin", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn(async () => {
      throw new Error("the open CLI made a network request");
    });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists only the commands it has", async () => {
    const json = JSON.parse((await run(["help", "--json"], [])).stdout);
    expect(json.data.commands).toEqual([
      "help",
      "version",
      "status",
      "doctor",
      "init",
      "setup",
      "install",
      "integrations",
      "uninstall",
      "eject",
      "sync",
      "config",
      "update",
      "host",
      "ui",
      "search",
      "memory",
      "rule",
      "skill",
      "instrument",
      "index",
      "learning",
      "home",
    ]);
    expect(json.data.topics).toEqual(["cli"]);
    const help = (await run(["help", "--no-color"], [])).stdout;
    for (const absent of [
      "Account & Context:",
      "Team & Billing:",
      "login",
      "intelligence",
      "--no-intelligence",
      "--browser-callback",
    ]) {
      expect(help).not.toContain(absent);
    }
    expect(help).toContain(
      "me            Inspect and correct what Pathrule knows about how you work",
    );
    expect(help).toContain("help          Show this help, help for one command, or for cli");
  });

  it("prints one command's help for `<command> --help` and `help <command>`, whatever follows it", async () => {
    for (const argv of [["setup", "--help"], ["help", "setup"], ["setup", "--local", "-h"]]) {
      const result = await run(argv, []);
      expect(result.exitCode, argv.join(" ")).toBe(0);
      expect(result.stdout).toContain("pathrule setup\n");
      expect(result.stdout).toContain("pathrule setup --local");
      expect(result.stdout).not.toContain("Quick Start:");
    }
    const nested = await run(["rule", "checks", "--help"], []);
    expect(nested.exitCode).toBe(0);
    expect(nested.stdout).toContain("pathrule rule approve-check <rule-id> <check-id>");
    const unknown = await run(["help", "nonsense"], []);
    expect(unknown.exitCode).toBe(64);
    expect(unknown.stderr).toContain('Unknown command or help topic "nonsense"');
  });

  it("has no account commands without the plugin that brings them", async () => {
    for (const command of ["login", "whoami", "intelligence"]) {
      expect((await run([command, "--no-color"], [])).exitCode).toBe(64);
    }
    const me = await run(["me", "teach", "something", "--no-color"], []);
    expect(me.stderr).toContain("try: list | explain | forget | scope");
  });

  it("keeps the update policy on this machine without an account, and reads its default", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-cli-policy-"));
    try {
      const env = { PATHRULE_HOME: root };
      const before = await run(["config", "get", "update.policy", "--json"], [], env);
      expect(JSON.parse(before.stdout).data).toMatchObject({
        value: "automatic",
        source: "default",
      });
      const set = await run(["config", "set", "update.policy", "notify", "--json"], [], env);
      expect(JSON.parse(set.stdout)).toMatchObject({ ok: true, data: { value: "notify" } });
      const after = await run(["config", "get", "update.policy", "--json"], [], env);
      expect(JSON.parse(after.stdout).data).toMatchObject({ value: "notify", source: "config" });
      // An earlier CLI's value is read as today's choice.
      const legacy = await run(["config", "set", "update.policy", "manual", "--json"], [], env);
      expect(JSON.parse(legacy.stdout).data).toMatchObject({ value: "notify" });
      const off = await run(["config", "set", "update.policy", "off", "--json"], [], env);
      expect(JSON.parse(off.stdout).error.code).toBe("invalid_update_policy");
      const telemetry = await run(["config", "get", "telemetry.enabled", "--json"], [], env);
      expect(JSON.parse(telemetry.stdout).error.code).toBe("unsupported_config_key");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("runs doctor with no account check and passes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-cli-doctor-"));
    try {
      const result = await run(["doctor", "--json"], [], { PATHRULE_HOME: root, HOME: root });
      const report = JSON.parse(result.stdout).data;
      expect(report.checks.map((check: { name: string }) => check.name)).not.toContain("auth");
      expect(report.ok).toBe(true);
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  // Since 2026-10-13 (owner decision: update.policy automatic by default) a released install checks
  // for updates in the background after a command run by a person at a terminal. A run that is not
  // at a terminal (a script, a pipe, an agent), like these, still sends nothing anywhere.
  it("sends nothing anywhere from a run outside a terminal, even for a new user", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-cli-quiet-"));
    try {
      for (const argv of [["help"], ["memory", "list"], ["doctor"]]) {
        await run(argv, [], { PATHRULE_HOME: root, HOME: root });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("a plugin's passive notice", () => {
  afterEach(() => installCliPlugins([]));

  function runIn(argv: string[], plugins: CommandPlugin[], terminal: boolean, env = {}) {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const runtime = { cwd: "/repo", env, stdout, stderr, stderrIsTTY: terminal };
    return runCli(argv, runtime, { plugins }).then((exitCode) => ({
      exitCode,
      stderr: stderr.toString(),
    }));
  }

  const noticing = (asked: string[]) =>
    plugin({
      commands: [echo("hello"), echo("quiet", { quiet: true })],
      passiveNotice: async () => {
        asked.push("asked");
        return "Telemetry is off.";
      },
    });

  it("is printed after an interactive command, to a terminal", async () => {
    const asked: string[] = [];
    const result = await runIn(["hello"], [noticing(asked)], true);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Telemetry is off.");
    expect(asked).toEqual(["asked"]);
  });

  it("is not even asked for in a pipe, with --json, in CI or after a quiet command", async () => {
    const asked: string[] = [];
    for (const [argv, terminal, env] of [
      [["hello"], false, {}],
      [["hello", "--json"], true, {}],
      [["hello"], true, { CI: "true" }],
      [["quiet"], true, {}],
    ] as const) {
      const result = await runIn([...argv], [noticing(asked)], terminal, env);
      expect(result.stderr).not.toContain("Telemetry is off.");
    }
    expect(asked).toEqual([]);
  });

  it("never fails the command when the plugin's notice throws", async () => {
    const throwing = plugin({
      commands: [echo("hello")],
      passiveNotice: async () => {
        throw new Error("broken");
      },
    });
    await expect(runIn(["hello"], [throwing], true)).resolves.toMatchObject({ exitCode: 0 });
  });
});
