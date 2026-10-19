// SPDX-License-Identifier: Apache-2.0
// `pathrule telemetry`: what this install shares (nothing, in every build Pathrule distributes).
import { jsonEnvelope, statusLabel, type CliOutputMode } from "@pathrule/cli/output.js";
import type { CliJsonResult, CliRuntime } from "@pathrule/cli/plugin.js";

import {
  cliTelemetryStatus,
  setCliTelemetryEnabled,
  type CliTelemetryStatus,
} from "../telemetry.js";

const SUBCOMMANDS = ["status", "enable", "disable"] as const;
type TelemetrySubcommand = (typeof SUBCOMMANDS)[number];

function subcommand(args: string[]): TelemetrySubcommand | null {
  const name = args[0] ?? "status";
  return (SUBCOMMANDS as readonly string[]).includes(name) ? (name as TelemetrySubcommand) : null;
}

async function apply(
  sub: TelemetrySubcommand,
  env: NodeJS.ProcessEnv,
): Promise<CliTelemetryStatus> {
  // Without an analytics key there is nothing to switch, so nothing is saved either.
  if (sub !== "status" && (await cliTelemetryStatus(env)).managed_build) {
    await setCliTelemetryEnabled(sub === "enable" ? "true" : "false", env);
  }
  return cliTelemetryStatus(env);
}

function stateLine(status: CliTelemetryStatus): string {
  const { value, source } = status.enabled;
  if (source === "ci") return "off (CI)";
  if (source === "env") return "off (NO_TELEMETRY or DO_NOT_TRACK is set)";
  if (source === "config") return value ? "on (you turned it on)" : "off (you turned it off)";
  if (source === "notice_pending") return "off until the first-use notice has been shown";
  return value ? "on (the default)" : "off (the default until you turn it on)";
}

export function renderTelemetryStatus(status: CliTelemetryStatus, mode: CliOutputMode): string {
  // A build without an analytics key (every build Pathrule distributes) has nothing to send and
  // nothing to turn on; it says so instead of describing a stream that does not exist.
  if (!status.managed_build) {
    return [
      "Pathrule telemetry",
      `${statusLabel("info", mode)} Pathrule's CLI, MCP server and VS Code extension send no usage data.`,
      "Nothing about your commands, code, knowledge or account leaves this machine for analytics,",
      "and there is nothing to turn on. Pathrule Cloud counts its own use on its servers, only for",
      "accounts whose holder opted in on the account page.",
      "",
    ].join("\n");
  }
  const lines = [
    "Pathrule telemetry",
    `${statusLabel(status.enabled.value ? "ok" : "info", mode)} Telemetry: ${stateLine(status)}`,
    "What is sent: anonymous usage events (which commands and MCP tools succeed, the CLI version and",
    "OS, a random install id) to Pathrule's product analytics (PostHog, EU region). Never code, file",
    "paths, prompts, knowledge, your account, organization, workspace or email.",
    `Sent from this install: ${
      status.collecting
        ? "yes"
        : !status.managed_build
          ? "no, Pathrule's CLI and MCP server send no product telemetry"
          : !status.signed_in
            ? "no, only while you are signed in to Pathrule Cloud"
            : "no"
    }`,
  ];
  if (status.install_id) lines.push(`Install id: ${status.install_id}`);
  if (status.enabled.configurable) {
    lines.push(
      status.enabled.value
        ? "Turn it off: pathrule telemetry disable"
        : "Turn it on: pathrule telemetry enable",
    );
  }
  lines.push("Also off with NO_TELEMETRY=1 or DO_NOT_TRACK=1, and always in CI.", "");
  return lines.join("\n");
}

export async function renderTelemetry(
  args: string[],
  runtime: CliRuntime,
  mode: CliOutputMode,
): Promise<number> {
  const sub = subcommand(args);
  if (!sub) {
    runtime.stderr.write(
      `${statusLabel("error", mode)} Usage: pathrule telemetry [status|enable|disable]\n`,
    );
    return 64;
  }
  const status = await apply(sub, runtime.env);
  if (sub !== "status" && status.managed_build && !status.enabled.configurable) {
    runtime.stderr.write(
      `${statusLabel("warn", mode)} Saved, but telemetry stays off here: ${stateLine(status)}.\n`,
    );
  }
  runtime.stdout.write(renderTelemetryStatus(status, mode));
  return 0;
}

export async function runTelemetryJson(
  runtime: CliRuntime,
  command: string,
  args: string[],
): Promise<CliJsonResult> {
  const sub = subcommand(args);
  if (!sub) {
    return {
      exitCode: 64,
      envelope: jsonEnvelope({
        command,
        cwd: runtime.cwd,
        ok: false,
        error: {
          code: "invalid_telemetry_subcommand",
          message: "Usage: pathrule telemetry [status|enable|disable]",
        },
      }),
    };
  }
  const status = await apply(sub, runtime.env);
  return {
    exitCode: 0,
    envelope: jsonEnvelope({ command, cwd: runtime.cwd, ok: true, data: status }),
  };
}
