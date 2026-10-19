#!/usr/bin/env node
// The open CLI end to end, with no account and no network service:
//
//   1. `pathrule setup --local --target claude` creates a local workspace for a
//      project, registers the MCP server with Claude Code and installs the hook, with the open
//      packages alone;
//   2. the MCP server (`pathrule mcp run`, as Claude Code starts it) writes a memory, a rule and a
//      skill, reads them back, and `pathrule_get_context` returns them;
//   3. the CLI lists and searches them (`memory list`, `rule list`, `skill list`, `search`);
//   4. the hook Claude Code runs delivers the memory for a prompt about its path.
//
// Every run uses fresh temporary directories for HOME, PATHRULE_HOME and the project, so no real
// configuration is read or written, and stops the local host it started. PATHRULE_SMOKE_KEEP=1 keeps
// the directories for a look afterwards.
//
// usage: node scripts/smoke-open-local.mjs [<cli>]
//   <cli>  the CLI's entry: a bundle (default artifacts/cli/dist/index.js, `pnpm cli:bundle`) or
//          an installed package's dist/index.js
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const require = createRequire(import.meta.url);

export async function smokeOpenLocal({ cli, log = console.log }) {
  cli = resolve(cli);
  if (!existsSync(cli)) throw new Error(`${cli} does not exist (pnpm cli:bundle builds it)`);
  // The resolved path: an AI client reports its working directory resolved (macOS's /var is a link).
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-smoke-")));
  const home = join(base, "home");
  const project = join(base, "project");
  mkdirSync(home);
  mkdirSync(join(project, "src", "api"), { recursive: true });
  // A clean environment: what a person's shell has, without anything Pathrule or CI would read.
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    PATHRULE_HOME: join(home, ".pathrule"),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };
  const run = (args, { json = true } = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args, ...(json ? ["--json"] : [])], {
      cwd: project,
      env,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `pathrule ${args.join(" ")} exited ${result.status}:\n${result.stdout}${result.stderr}`,
      );
    }
    return json ? JSON.parse(result.stdout) : result.stdout;
  };
  const check = (ok, what) => {
    if (!ok) throw new Error(what);
    log(`  ok  ${what}`);
  };

  try {
    execFileSync("git", ["init", "-q"], { cwd: project, env });

    // 1. Setup.
    const setup = run(["setup", "--local", "--target", "claude"]);
    check(setup.ok === true, "setup --local creates a local workspace");
    const workspaceId = setup.data.workspace.workspaceId;
    check(typeof workspaceId === "string" && workspaceId.length > 0, `workspace ${workspaceId}`);
    const claudeConfig = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    const entry =
      Object.values(claudeConfig.mcpServers ?? {})[0] ??
      claudeConfig.projects?.[project]?.mcpServers?.pathrule;
    check(entry?.args?.slice(-2).join(" ") === "mcp run", "Claude Code has the MCP entry");
    check(!("PATHRULE_LOCAL" in (entry.env ?? {})), "the MCP entry names no edition: the server resolves the folder");
    // The hook entry is personal (one machine's path): the local settings file, never the team's shared one.
    const settings = JSON.parse(readFileSync(join(project, ".claude", "settings.local.json"), "utf8"));
    const hookCommand = settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
    check(
      typeof hookCommand === "string" && hookCommand.includes("pathrule-hook"),
      "the hook is installed",
    );
    check(!existsSync(join(project, ".claude", "settings.json")), "the shared .claude/settings.json is not written");

    // 2. The MCP server, started the way Claude Code starts it.
    const { Client } = await import(
      pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href
    );
    const { StdioClientTransport } = await import(
      pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href
    );
    const client = new Client({ name: "pathrule-smoke", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        cwd: project,
        env: { ...env, ...entry.env },
        stderr: "pipe",
      }),
    );
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      for (const name of [
        "pathrule_get_context",
        "pathrule_write_memory",
        "pathrule_write_rule",
        "pathrule_write_skill",
      ]) {
        check(tools.includes(name), `the MCP server lists ${name}`);
      }
      const call = async (name, args) => {
        const result = await client.callTool({ name, arguments: args });
        const text = result.content?.map((c) => c.text ?? "").join("\n") ?? "";
        if (result.isError) throw new Error(`${name} failed: ${text}`);
        return text;
      };
      const where = { workspace_id: workspaceId, cwd: project, node_path: "/src/api" };
      await call("pathrule_write_memory", {
        ...where,
        title: "Retries use exponential backoff",
        content:
          "Retry a failed upstream call twice with exponential backoff, then dead-letter it.",
      });
      await call("pathrule_write_rule", {
        ...where,
        name: "Never log request bodies",
        content: "- Request bodies may hold personal data: log their size, never their content.",
        scope_type: "folder",
        priority: "high",
      });
      await call("pathrule_write_skill", {
        ...where,
        name: "add-endpoint",
        description: "Add an API endpoint with its handler, validation and test.",
        content:
          "---\nname: add-endpoint\ndescription: Add an API endpoint with its handler, validation and test.\n---\n\n1. Write the handler.\n2. Validate the input.\n3. Add a test.\n",
      });
      check(true, "the MCP server writes a memory, a rule and a skill");
      const context = await call("pathrule_get_context", {
        cwd: join(project, "src", "api"),
        user_intent: "change how the API retries upstream calls",
      });
      check(context.includes("Retries use exponential backoff"), "get_context returns the memory");
      check(context.includes("Never log request bodies"), "get_context returns the rule");
      check(context.includes("add-endpoint"), "get_context returns the skill");
    } finally {
      await client.close();
    }

    // 3. The CLI reads the same store.
    const titles = (kind) => JSON.stringify(run([kind, "list", "--local"]).data);
    check(
      titles("memory").includes("Retries use exponential backoff"),
      "memory list shows the memory",
    );
    check(titles("rule").includes("Never log request bodies"), "rule list shows the rule");
    check(titles("skill").includes("add-endpoint"), "skill list shows the skill");
    check(
      JSON.stringify(run(["search", "backoff", "--local"]).data).includes(
        "Retries use exponential backoff",
      ),
      "search finds the memory",
    );

    // 4. What Claude Code reads. `sync` compiles the knowledge into path-scoped rules files under
    // .claude/rules/pathrule, which Claude Code loads for the paths they name; the hook then routes
    // each prompt to the paths whose knowledge applies instead of sending the bodies again.
    run(["sync", "--local"]);
    const rulesDir = join(project, ".claude", "rules", "pathrule");
    const compiled = existsSync(rulesDir)
      ? readdirSync(rulesDir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => readFileSync(join(rulesDir, f), "utf8"))
          .join("\n")
      : "";
    check(
      compiled.includes("Retries use exponential backoff"),
      `the compiled rules carry the memory${compiled.includes("Retries use exponential backoff") ? "" : `: ${rulesDir}`}`,
    );
    check(compiled.includes("Never log request bodies"), "the compiled rules carry the rule");
    const hookEvent = (input) =>
      spawnSync(hookCommand, {
        shell: true,
        cwd: project,
        env,
        encoding: "utf8",
        input: JSON.stringify(input),
      });
    const sessionStart = hookEvent({
      hook_event_name: "SessionStart",
      session_id: "pathrule-smoke",
      cwd: project,
    });
    check(
      sessionStart.status === 0 && sessionStart.stdout.includes("Pathrule Protocol"),
      `SessionStart delivers the protocol${sessionStart.status === 0 ? "" : `: ${sessionStart.stderr}`}`,
    );
    const hook = hookEvent({
      hook_event_name: "UserPromptSubmit",
      session_id: "pathrule-smoke",
      cwd: project,
      prompt: "change how src/api retries upstream calls",
    });
    check(hook.status === 0, `the hook exits 0${hook.status === 0 ? "" : `: ${hook.stderr}`}`);
    check(
      hook.stdout.includes("/src/api"),
      `the hook routes the prompt to src/api${hook.stdout.includes("/src/api") ? "" : `: ${hook.stdout || "(no output)"} ${hook.stderr}`}`,
    );
  } finally {
    spawnSync(process.execPath, [cli, "host", "stop", "--json"], { cwd: project, env });
    if (process.env.PATHRULE_SMOKE_KEEP === "1") log(`  kept ${base}`);
    else rmSync(base, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = process.argv[2] ?? join(ROOT, "artifacts", "cli", "dist", "index.js");
  try {
    console.log(`open local smoke: ${cli}`);
    await smokeOpenLocal({ cli });
    console.log("open local smoke passed");
  } catch (error) {
    console.error(
      `open local smoke failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
