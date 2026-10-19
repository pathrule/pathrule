// SPDX-License-Identifier: Apache-2.0
// `pathrule ui`: the Local Console, the browser page for this home's local knowledge, served on
// 127.0.0.1 while the command runs. No account: it reaches the home's local stores through the
// Pathrule host, like every other local command.
//
//   pathrule ui [--port <n>] [--no-open] [--json]
//
// It prints a single-use launch link and opens it in the default browser (unless --no-open), then
// serves until Ctrl+C (SIGINT) or SIGTERM. A second `pathrule ui` in the same home asks the running
// one for a fresh link instead of starting another server. With --json it prints one envelope
// with the link once it is ready.
import { pathruleHome } from "@pathrule/core/storage/paths.js";

import { UI_ASSETS_BUILD_COMMAND } from "../local/ui/assets.js";
import { openInBrowser } from "../local/ui/open-url.js";
import { serveLocalUi, type LocalUiLaunch } from "../local/ui/serve.js";
import { LAUNCH_TOKEN_TTL_MS } from "../local/ui/tokens.js";
import { jsonEnvelope, renderJson, statusLabel } from "../output.js";
import type { CliCommand, CliCommandContext } from "../plugin.js";

const USAGE = "Usage: pathrule ui [--port <n>] [--no-open] [--json]";

export const uiCommand: CliCommand = {
  name: "ui",
  help: {
    section: "additional",
    rank: 10,
    summary: "Open the Local Console to browse and edit local knowledge",
    usage: [USAGE.slice("Usage: ".length)],
  },
  jsonRank: 207,
  quiet: true,
  writesOwnJson: true,
  run: async (ctx) => {
    const stop = processStopSignal();
    try {
      return await runUiCommand(ctx, { signal: stop.signal });
    } finally {
      stop.dispose();
    }
  },
};

class UiUsageError extends Error {
  readonly code = "invalid_ui_args";
}

/** `--port <n>` or `--port=<n>`: a port number (0 = any free port). Nothing else is taken. */
export function parseUiArgs(args: readonly string[]): { port: number } {
  let port = 0;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    let value: string | undefined;
    if (arg === "--port") {
      value = args[i + 1];
      i += 1;
    } else if (arg.startsWith("--port=")) {
      value = arg.slice("--port=".length);
    } else {
      throw new UiUsageError(`Unexpected argument "${arg}". ${USAGE}`);
    }
    if (value === undefined || !/^\d{1,5}$/.test(value) || Number(value) > 65_535) {
      throw new UiUsageError(`--port takes a port number from 0 to 65535. ${USAGE}`);
    }
    port = Number(value);
  }
  return { port };
}

/**
 * SIGINT and SIGTERM as an abort signal, for as long as the command runs. The listeners stay
 * registered until `dispose` (after the cleanup), so a runtime that exits when a signal finds no
 * listener (tsx in development) cannot cut the cleanup short. A second signal exits at once.
 */
function processStopSignal(): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    if (controller.signal.aborted) process.exit(signal === "SIGINT" ? 130 : 143);
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    },
  };
}

function explain(err: unknown, port: number): { code: string; message: string } {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EADDRINUSE") {
    return {
      code: "port_in_use",
      message: `Port ${port} is in use. Choose another with --port, or leave it out for any free port.`,
    };
  }
  if (code === "EACCES") {
    return { code: "port_not_allowed", message: `Port ${port} cannot be used by this user.` };
  }
  return { code: "ui_failed", message: err instanceof Error ? err.message : String(err) };
}

/** The command, with the signal that stops it (tests pass their own). */
export async function runUiCommand(
  ctx: CliCommandContext,
  options: { signal: AbortSignal },
): Promise<number> {
  const { runtime, mode } = ctx;
  const fail = (code: string, message: string, exitCode: number) => {
    if (mode.json) {
      runtime.stdout.write(
        renderJson(
          jsonEnvelope({ command: "ui", cwd: runtime.cwd, ok: false, error: { code, message } }),
        ),
      );
    } else {
      runtime.stderr.write(`${statusLabel("error", mode)} ${message}\n`);
    }
    return exitCode;
  };

  let port: number;
  try {
    port = parseUiArgs(ctx.args).port;
  } catch (err) {
    return fail("invalid_ui_args", err instanceof Error ? err.message : String(err), 64);
  }

  let serving: Awaited<ReturnType<typeof serveLocalUi>>;
  try {
    serving = await serveLocalUi({
      env: runtime.env,
      cwd: runtime.cwd,
      port,
      signal: options.signal,
      log: (line) => runtime.stderr.write(`[pathrule-ui] ${line}\n`),
    });
  } catch (err) {
    const failure = explain(err, port);
    return fail(failure.code, failure.message, 1);
  }

  const launch = serving.launch;
  report(ctx, launch);
  if (!mode.noOpen) {
    try {
      await (runtime.openUrl ?? openInBrowser)(launch.url);
    } catch {
      if (!mode.json) {
        runtime.stderr.write(
          `${statusLabel("warn", mode)} Could not open a browser. Open the link above.\n`,
        );
      }
    }
  }
  await serving.done;
  if (!launch.reused && !mode.json) {
    runtime.stdout.write(`${statusLabel("info", mode)} The Local Console stopped.\n`);
  }
  return 0;
}

function report(ctx: CliCommandContext, launch: LocalUiLaunch): void {
  const { runtime, mode } = ctx;
  if (mode.json) {
    runtime.stdout.write(
      renderJson(
        jsonEnvelope({
          command: "ui",
          cwd: runtime.cwd,
          ok: true,
          data: {
            url: launch.url,
            port: launch.port,
            pid: launch.pid,
            reused: launch.reused,
            ...(launch.reused ? {} : { assetsBuilt: launch.assetsDir !== null }),
          },
        }),
      ),
    );
    return;
  }
  const minutes = Math.round(LAUNCH_TOKEN_TTL_MS / 60_000);
  if (launch.reused) {
    runtime.stdout.write(
      `${statusLabel("ok", mode)} The Local Console is already running (pid ${launch.pid}): ${launch.url}\n` +
        `  The link works once, within ${minutes} minutes.\n`,
    );
    return;
  }
  runtime.stdout.write(
    `${statusLabel("ok", mode)} Pathrule Local Console: ${launch.url}\n` +
      `  The link works once, within ${minutes} minutes. Run \`pathrule ui\` again for a new one.\n` +
      `  Serving the local workspaces of ${pathruleHome(runtime.env)}. Press Ctrl+C to stop.\n`,
  );
  if (launch.assetsDir === null) {
    runtime.stdout.write(
      `${statusLabel("warn", mode)} The console's assets are not built; the page says how. Build them with: ${UI_ASSETS_BUILD_COMMAND}\n`,
    );
  }
}
