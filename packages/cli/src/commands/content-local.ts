// SPDX-License-Identifier: Apache-2.0
// `pathrule search`, `memory`, `rule` and `skill` against the local store. Local items have no
// web or desktop target, so a read always prints in the terminal. They run here for a Pathrule Local
// folder; a Pathrule Cloud folder's run the account's (capabilities/folder-edition.ts).
import type { CliContentKind } from "../content-helpers.js";
import { parseContentOptions, renderContentRows, requiredArg } from "../content-options.js";
import { listLocalContent, readLocalContent, searchLocalContent } from "../local/content-local.js";
import { cliErrorCode, jsonEnvelope, statusLabel, type CliOutputMode } from "../output.js";
import type { CliCommand, CliCommandContext, CliRuntime } from "../plugin.js";
import { editionCommand } from "../capabilities/folder-edition.js";
import { RULE_CHECK_SUBCOMMANDS, runRuleChecks } from "./rule-checks.js";

export const searchCommand: CliCommand = {
  name: "search",
  help: {
    section: "knowledge",
    rank: 10,
    summary: "Search memories, rules, and skills in the current workspace",
    usage: ["pathrule search <query> [--local] [--json]"],
  },
  jsonRank: 230,
  ...editionCommand({
    run: (ctx) => renderSearch(ctx.args, ctx.runtime, ctx.mode),
    json: (ctx) => runSearchJson(ctx.runtime, ctx.args),
  }),
};

function contentCommand(kind: CliContentKind, rank: number, jsonRank: number): CliCommand {
  return {
    name: kind,
    help: {
      section: "knowledge",
      rank,
      // The CLI reads knowledge; agents write it through the MCP server (`add` says so).
      summary: `List or read ${kind === "memory" ? "memories" : `${kind}s`}`,
      usage: [
        `pathrule ${kind} list [--local] [--json]`,
        `pathrule ${kind} read <id-or-title> [--print] [--local] [--json]`,
        ...(kind === "rule"
          ? ["pathrule rule checks [--json]", "pathrule rule approve-check <rule-id> <check-id>"]
          : []),
      ],
    },
    jsonRank,
    ...editionCommand({
      run: (ctx: CliCommandContext) => renderContent(kind, ctx.args, ctx.runtime, ctx.mode),
      json: (ctx: CliCommandContext) => runContentJson(kind, ctx.runtime, ctx.args),
    }),
  };
}

export const memoryCommand = contentCommand("memory", 20, 240);
export const ruleCommand = contentCommand("rule", 30, 250);
export const skillCommand = contentCommand("skill", 40, 260);

async function renderContent(
  kind: CliContentKind,
  args: string[],
  runtime: CliRuntime,
  mode: CliOutputMode,
): Promise<number> {
  try {
    const subcommand = args[0] ?? "list";
    if (kind === "rule" && RULE_CHECK_SUBCOMMANDS.has(subcommand)) {
      return await runRuleChecks(subcommand, args.slice(1), runtime, mode);
    }
    if (subcommand === "add") {
      runtime.stderr.write(
        `${statusLabel("error", mode)} The CLI does not write knowledge. Your AI agent writes ${kind}s through the MCP server; use list/read/search to browse them.\n`,
      );
      return 1;
    }
    const options = parseContentOptions(args.slice(1));
    if (subcommand === "read") {
      const selector = options.positionals[0];
      if (!selector) {
        runtime.stderr.write(
          `${statusLabel("error", mode)} Usage: pathrule ${kind} read <id-or-title>\n`,
        );
        return 64;
      }
      const item = await readLocalContent(kind, selector, runtime.cwd, runtime.env);
      // Local has no web/desktop target, so we always print the body in-terminal.
      runtime.stdout.write(
        [
          `${item.kind}: ${item.title}`,
          `Path: ${item.path ?? "/"}`,
          ...(item.url ? [`URL: ${item.url}`] : []),
          "",
          item.content,
          "",
        ].join("\n"),
      );
      return 0;
    }
    if (subcommand !== "list") {
      runtime.stderr.write(`${statusLabel("error", mode)} Usage: pathrule ${kind} list|read\n`);
      return 64;
    }
    const items = await listLocalContent(kind, runtime.cwd, runtime.env, options);
    renderContentRows(runtime.stdout, mode, items);
    return 0;
  } catch (err) {
    runtime.stderr.write(
      `${statusLabel("error", mode)} ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

async function renderSearch(
  args: string[],
  runtime: CliRuntime,
  mode: CliOutputMode,
): Promise<number> {
  try {
    const options = parseContentOptions(args);
    const query = options.positionals.join(" ").trim();
    if (!query) {
      runtime.stderr.write(`${statusLabel("error", mode)} Usage: pathrule search <query>\n`);
      return 64;
    }
    const items = await searchLocalContent(query, runtime.cwd, runtime.env, {
      ...options,
      types: options.types,
    });
    renderContentRows(runtime.stdout, mode, items);
    return 0;
  } catch (err) {
    runtime.stderr.write(
      `${statusLabel("error", mode)} ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

async function runContentJson(kind: CliContentKind, runtime: CliRuntime, args: string[]) {
  try {
    const subcommand = args[0] ?? "list";
    if (subcommand === "add") {
      return {
        exitCode: 1,
        envelope: jsonEnvelope({
          command: `${kind} add`,
          cwd: runtime.cwd,
          ok: false,
          error: {
            code: "local_write_unsupported",
            message: `The CLI does not write knowledge. Your AI agent writes ${kind}s through the MCP server.`,
          },
        }),
      };
    }
    const options = parseContentOptions(args.slice(1));
    const data =
      subcommand === "read"
        ? await readLocalContent(
            kind,
            requiredArg(options.positionals[0], `${kind}_selector_required`),
            runtime.cwd,
            runtime.env,
          )
        : await listLocalContent(kind, runtime.cwd, runtime.env, options);
    return {
      exitCode: 0,
      envelope: jsonEnvelope({
        command: kind,
        cwd: runtime.cwd,
        ok: true,
        data,
      }),
    };
  } catch (err) {
    return {
      exitCode: 1,
      envelope: jsonEnvelope({
        command: args[0] === "add" ? `${kind} add` : kind,
        cwd: runtime.cwd,
        ok: false,
        error: {
          code: cliErrorCode(err, "content_command_failed"),
          message: err instanceof Error ? err.message : String(err),
        },
      }),
    };
  }
}

async function runSearchJson(runtime: CliRuntime, args: string[]) {
  try {
    const options = parseContentOptions(args);
    const query = requiredArg(options.positionals.join(" ").trim(), "search_query_required");
    const data = await searchLocalContent(query, runtime.cwd, runtime.env, options);
    return {
      exitCode: 0,
      envelope: jsonEnvelope({
        command: "search",
        cwd: runtime.cwd,
        ok: true,
        data,
      }),
    };
  } catch (err) {
    return {
      exitCode: 1,
      envelope: jsonEnvelope({
        command: "search",
        cwd: runtime.cwd,
        ok: false,
        error: {
          code: "search_failed",
          message: err instanceof Error ? err.message : String(err),
        },
      }),
    };
  }
}
