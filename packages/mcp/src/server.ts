// SPDX-License-Identifier: Apache-2.0
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { setHookCommand } from "@pathrule/integrations/hook-supervisor/hook-command.js";
import { pathruleHome } from "@pathrule/core/storage/paths.js";
import type { HostLaunchCommand } from "@pathrule/host/launch.js";
import { HostSession } from "@pathrule/host/session.js";

import { useHostSession } from "./local-runtime.js";
import { installMcpPlugins, notifyToolCompleted, type McpPlugin } from "./plugin.js";
import { orderTools, CORE_TOOL_NAMES, DEFERRED_WRITE_TOOL_NAMES } from "./tools/index.js";
import { recordToolCall, getWarnings } from "./session-tracker.js";
import { log } from "./logger.js";
import { bindClientIdentitySource, resolveClientId } from "./client-identity.js";
import { runWithCallCwd } from "./lib/call-cwd.js";
import {
  compatibilityInstruction,
  markNoticesDelivered,
  mcpCompatibilityReport,
  mcpServerVersion,
  setMcpServerVersion,
  takeSessionNotice,
} from "./server-version.js";
import type { ReleaseDistributionId } from "@pathrule/protocol/release-manifest.js";

export interface StartPathruleMcpServerOptions {
  /**
   * When true (default), the function guarantees stdio purity: no human
   * banner, no telemetry, no setup hint, and stderr-only logs. CLI's
   * `pathrule mcp run` always sets this. Standalone bin keeps the same
   * behavior because the MCP protocol requires it.
   */
  stdioSafe?: boolean;
  /**
   * Transport to connect on. Defaults to a `StdioServerTransport` (the only
   * production path). Tests inject an `InMemoryTransport` to drive the server
   * with a real MCP client.
   */
  transport?: Transport;
  /**
   * Workspace root used to decide which capability tool families to advertise.
   * Defaults to `process.cwd()`, which is what a client-spawned stdio server
   * gets. Explicit because the process's cwd is not guaranteed to be the
   * workspace, and because a test needs to point this at a fixture.
   */
  workspaceRoot?: string;
  /**
   * What this composition adds to the open server: tools, and at most one account
   * edition. With none the server serves the local store.
   */
  plugins?: readonly McpPlugin[];
  /**
   * How to launch the home's Pathrule host, which owns the local stores, when none runs: the CLI
   * passes its own `host run`. Absent, the server runs the host in its own process when it needs
   * one.
   */
  hostLaunch?: HostLaunchCommand | null;
  /** The version of the CLI that starts this server; it is the server's version. */
  version?: string;
  /** Reads the version installed on disk now, so a server older than its install says so. */
  installedVersion?: () => string | null;
  /** The release channel the CLI was installed from; null when an editor or plugin updates it. */
  distribution?: ReleaseDistributionId | null;
}

/**
 * How many tools the stdio MCP advertises upfront.
 *   • "all" (default): every tool registers enabled upfront, so the advertised list never changes.
 *   • "core" (`PATHRULE_MCP_TOOLS=core`): the everyday tools (`CORE_TOOL_NAMES`) register enabled; the
 *     rest register DISABLED until the agent calls `pathrule_more_tools`.
 *   • "lazy": read set + `pathrule_log_activity` + `pathrule_enable_writes` are listed; the
 *     write/admin set is DISABLED until `enable_writes` (set `PATHRULE_MCP_TOOLS=lazy`).
 *
 * Lazy was the default once, and it optimised the wrong number (measured 2026-09-01: a constant
 * 7.682 cached schema tokens against a tool-list CHANGE on the first write, which invalidates the
 * prompt-cache prefix and re-bills the conversation so far). "all" replaced it. Measured again on
 * PathruleBench v3 (2026-10-16) with Claude Code 2.1, which defers MCP schemas and lists only the
 * names: 34 names cost ~3,900 characters a session, re-read on every model step, and a 32-turn
 * chain used six tools. "core" keeps every write a session ordinarily makes in the constant list.
 * It is NOT the default: on six PathruleBench v3 chains with it, agents saved the operational lesson
 * they met (a test suite's environment variable) in two, against every chain on the full list, and
 * the dollar saving at 20 items was inside run-to-run noise. Opt in where the saving is wanted.
 */
function resolveMcpToolsMode(env: NodeJS.ProcessEnv): "core" | "lazy" | "all" {
  const mode = env.PATHRULE_MCP_TOOLS?.trim().toLowerCase();
  return mode === "lazy" || mode === "core" ? mode : "all";
}

const ENABLE_WRITES_TOOL_NAME = "pathrule_enable_writes";
const MORE_TOOLS_NAME = "pathrule_more_tools";

let hookCommandConfigured = false;

function ensureHookCommandConfigured(env: NodeJS.ProcessEnv): void {
  if (hookCommandConfigured) return;
  // Honor PATHRULE_HOME so AI-client-spawned MCP reads the same hook script
  // location the CLI wrote. Default falls back to ~/.pathrule, the
  // home every Pathrule install uses.
  const home = pathruleHome(env) || pathJoin(homedir(), ".pathrule");
  setHookCommand(pathJoin(home, "bin", "pathrule-hook.js"));
  hookCommandConfigured = true;
}

function redirectConsoleToStderr(): void {
  // The StdioServerTransport owns stdout for JSON-RPC frames. Any rogue
  // console.log/info/warn from a tool import or third-party module would
  // corrupt the protocol stream, so re-route them to stderr. console.error
  // is already stderr-only.
  const reroute = (...args: unknown[]) => {
    process.stderr.write(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n",
    );
  };
  console.log = reroute;
  console.info = reroute;
  console.warn = reroute;
  console.debug = reroute;
}

/**
 * Register the always-visible `pathrule_enable_writes` tool. Calling it enables
 * every deferred write/admin tool for the rest of the session; the SDK emits a
 * tools/list_changed notification on each enable so the client re-fetches the
 * now-larger tool list. Idempotent — a second call is a harmless no-op.
 */
function registerEnableWritesTool(
  server: McpServer,
  deferredHandles: Array<ReturnType<typeof server.registerTool>>,
  gate: { name: string; title: string; description: string } = {
    name: ENABLE_WRITES_TOOL_NAME,
    title: "Enable Pathrule write tools",
    description:
      "Load Pathrule's write/admin tools for this session: write/update/delete " +
      "memory, rule, and skill; import/remove pattern bundles; resolve/request " +
      "refresh; setup; and runtime events activation. Call this ONCE before " +
      "your first write: the read tools and pathrule_log_activity are always " +
      "available without it. After calling, the write tools appear in your tool list.",
  },
): void {
  server.registerTool(
    gate.name,
    { title: gate.title, description: gate.description, inputSchema: {} },
    async () => {
      recordToolCall(gate.name);
      const newlyEnabled = deferredHandles.filter((h) => !h.enabled);
      // One notification, not fourteen. The SDK fires tools/list_changed from
      // `update()`, so a loop over N handles emits N notifications for a list that
      // changed once — measured: 14. Each one can send the client back for
      // tools/list, and every re-fetch is another chance to disturb the cached
      // prefix. Suppressed for the duration of the loop and sent once after it.
      const emit = server.sendToolListChanged.bind(server);
      server.sendToolListChanged = () => {};
      try {
        for (const handle of newlyEnabled) handle.enable();
      } finally {
        server.sendToolListChanged = emit;
      }
      if (newlyEnabled.length > 0) emit();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                enabled_count: newlyEnabled.length,
                already_enabled: newlyEnabled.length === 0,
                message:
                  newlyEnabled.length === 0
                    ? "Pathrule write tools were already enabled."
                    : "Pathrule write tools are now available in your tool list.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

export async function startPathruleMcpServer(
  options: StartPathruleMcpServerOptions = {},
): Promise<void> {
  const stdioSafe = options.stdioSafe ?? true;
  if (stdioSafe) redirectConsoleToStderr();
  const plugins = options.plugins ?? [];
  installMcpPlugins(plugins);
  ensureHookCommandConfigured(process.env);
  if (options.hostLaunch) {
    useHostSession(new HostSession({ env: process.env, launch: options.hostLaunch }));
  }

  setMcpServerVersion({
    version: options.version,
    installedVersion: options.installedVersion,
    distribution: options.distribution,
  });
  // Only an issue the person must act on (a required update, a restart) reaches the instructions,
  // read from the release manifest on disk: no network, and the same text every session otherwise.
  const startReport = mcpCompatibilityReport({ env: process.env, clientId: null });
  const instruction = compatibilityInstruction(startReport);
  if (instruction) markNoticesDelivered(startReport);
  const server = new McpServer(
    { name: "pathrule", version: mcpServerVersion() },
    instruction ? { instructions: instruction } : undefined,
  );

  // Make the connected client's identity (Claude Code / Cursor / Codex /
  // Windsurf) available to every tool handler so telemetry stamps the right
  // `ai_client` automatically. McpServer wraps an underlying Server whose
  // `getClientVersion()` is populated post-handshake.
  bindClientIdentitySource(server.server);

  const toolsMode = resolveMcpToolsMode(process.env);
  // Handles for the deferred write/admin tools so `enable_writes` can flip them
  // on in-session (the SDK fires notifications/tools/list_changed on enable).
  const deferredHandles: Array<ReturnType<typeof server.registerTool>> = [];

  const tools = orderTools(plugins.flatMap((plugin) => plugin.tools ?? []));
  for (const tool of tools) {
    const handle = server.registerTool(
      tool.name,
      {
        title: tool.title ?? tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown) => {
        recordToolCall(tool.name);
        const result = await runWithCallCwd(args, () => tool.handler(args as Record<string, unknown>));
        notifyToolCompleted(tool.name, result, resolveClientId());
        const warnings = getWarnings(tool.name);

        // Inject warnings into the result object so the LLM sees them
        // inline with the tool response — no separate content blocks needed.
        let payload =
          warnings.length > 0 && typeof result === "object" && result !== null
            ? { ...result, _warnings: warnings }
            : result;
        // An update installed while this session runs, or a required compatibility update: said
        // once, inline, the way warnings are (never on stdout outside the protocol). Taken only
        // when this result can carry it.
        if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
          const notice = takeSessionNotice(process.env, resolveClientId());
          if (notice) payload = { ...payload, _pathrule_notice: notice };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      },
    );
    if (
      (toolsMode === "lazy" && DEFERRED_WRITE_TOOL_NAMES.has(tool.name)) ||
      (toolsMode === "core" && !CORE_TOOL_NAMES.has(tool.name))
    ) {
      handle.disable();
      deferredHandles.push(handle);
    }
  }
  // Tools that bridge to a running host register after the listed ones, in plugin order.
  let pluginToolCount = 0;
  for (const plugin of plugins) {
    if (!plugin.registerTools) continue;
    pluginToolCount += await plugin.registerTools(server, {
      workspaceRoot: options.workspaceRoot ?? process.cwd(),
    });
  }

  if (toolsMode === "lazy") registerEnableWritesTool(server, deferredHandles);
  if (toolsMode === "core") {
    registerEnableWritesTool(server, deferredHandles, {
      name: MORE_TOOLS_NAME,
      title: "Load Pathrule's remaining tools",
      description:
        "Load the rest of Pathrule's tools for this session: knowledge tree, map, node and list reads; " +
        "rule and skill deletes, skill writes, pattern removal; learning (record, review, history); " +
        "refresh tasks (list, brief, request, resolve); runtime events; setup. Call it ONCE, only " +
        "when a task needs one of them: get_context, read_*, resolve, write/update memory and rule, " +
        "remember_preference, import_pattern and log_activity are always listed without it.",
    });
  }

  const advertisedToolCount =
    (toolsMode === "all" ? tools.length : tools.length - deferredHandles.length + 1) + pluginToolCount;

  const transport = options.transport ?? new StdioServerTransport();
  await server.connect(transport);
  // A local session refreshes its workspace's hook index once at start, in the background: what the
  // hook observed last session is taken in, and a preference the person repeated is promoted, even
  // when this session never writes or calls get_context.
  if (!options.transport) void syncAtStart(options.workspaceRoot ?? process.cwd());
  log("info", "MCP server listening on stdio", {
    toolCount: advertisedToolCount,
    totalTools: tools.length,
    toolsMode,
    mode: "local",
  });
}

async function syncAtStart(cwd: string): Promise<void> {
  try {
    const { resolveWorkspaceTarget } = await import("./tools/helpers.js");
    const { indexedWorkspaceRoot, syncWorkspaceHookIndex } = await import("./lib/workspace-hook-index.js");
    const { isProjectContext } = await import("./local-runtime.js");
    const target = await resolveWorkspaceTarget({ cwd });
    if (!target.ok || isProjectContext(target.ctx)) return;
    const root = await indexedWorkspaceRoot(target.workspaceId);
    if (root) await syncWorkspaceHookIndex({ ctx: target.ctx, workspaceId: target.workspaceId, localRootPath: root });
  } catch (e) {
    log("warn", "start-of-session index sync failed", { error: e instanceof Error ? e.message : String(e) });
  }
}
