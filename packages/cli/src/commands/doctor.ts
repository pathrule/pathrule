// SPDX-License-Identifier: Apache-2.0
// `pathrule doctor`: read-only diagnostics of this machine and folder.
import { runCliDoctor, writeCliDoctorBundle, type CliDoctorCheck } from "../doctor.js";
import { cliErrorCode, jsonEnvelope, statusLabel, type CliOutputMode } from "../output.js";
import { cliAccount, cliPlugins, type CliCommand, type CliRuntime } from "../plugin.js";
import { personAtTerminal } from "../terminal/profile.js";

export const doctorCommand: CliCommand = {
  name: "doctor",
  help: { section: "diagnostics", rank: 20, summary: "Run read-only diagnostics" },
  jsonRank: 50,
  run: (ctx) => renderDoctor(ctx.args, ctx.runtime, ctx.mode),
  json: (ctx) => runDoctorJson(ctx.runtime, ctx.args),
};

async function runDoctorJson(runtime: CliRuntime, args: string[]) {
  try {
    if (args.includes("--bundle")) {
      const data = await writeCliDoctorBundle(runtime.env, runtime.cwd, {
        fetchImpl: runtime.fetch,
      });
      return {
        exitCode: data.ok ? 0 : 1,
        envelope: jsonEnvelope({
          command: "doctor --bundle",
          cwd: runtime.cwd,
          ok: data.ok,
          data: { path: data.path, report: data.report },
        }),
      };
    }
    const data = await runCliDoctor(runtime.env, runtime.cwd, { fetchImpl: runtime.fetch });
    for (const plugin of cliPlugins()) {
      await plugin.telemetry?.doctorFinished(runtime.env, data.managed_files);
    }
    return {
      exitCode: data.ok ? 0 : 1,
      envelope: jsonEnvelope({
        command: "doctor",
        cwd: runtime.cwd,
        ok: data.ok,
        data,
      }),
    };
  } catch (err) {
    return {
      exitCode: 1,
      envelope: jsonEnvelope({
        command: "doctor",
        cwd: runtime.cwd,
        ok: false,
        error: {
          code: cliErrorCode(err, "doctor_failed"),
          message: err instanceof Error ? err.message : String(err),
        },
      }),
    };
  }
}

async function renderDoctor(
  args: string[],
  runtime: CliRuntime,
  mode: CliOutputMode,
): Promise<number> {
  try {
    if (args.includes("--bundle")) {
      const bundle = await writeCliDoctorBundle(runtime.env, runtime.cwd, {
        fetchImpl: runtime.fetch,
      });
      runtime.stdout.write(`${statusLabel("ok", mode)} Support bundle written: ${bundle.path}\n`);
      return bundle.ok ? 0 : 1;
    }
    const report = await runCliDoctor(runtime.env, runtime.cwd, {
      fetchImpl: runtime.fetch,
      interactive: personAtTerminal(runtime, mode),
    });
    runtime.stdout.write("Pathrule doctor\n");
    renderDoctorGroup(
      "Account",
      report.checks.filter((check) => ["auth", "organization"].includes(check.name)),
      runtime,
      mode,
    );
    renderDoctorGroup(
      "Workspace",
      report.checks.filter((check) =>
        ["folder_edition", "workspace", "cwd_attach", "deliveries_report"].includes(check.name),
      ),
      runtime,
      mode,
    );
    renderDoctorGroup(
      "Managed files",
      report.checks.filter((check) => check.name === "managed_files"),
      runtime,
      mode,
    );
    renderDoctorGroup(
      "Updates and compatibility",
      report.checks.filter((check) => UPDATE_CHECKS.has(check.name)),
      runtime,
      mode,
    );
    if (report.managed_files.length > 0) {
      runtime.stdout.write("\nManaged file ownership\n");
      for (const file of report.managed_files) {
        const label = file.status === "current" || file.status === "older_version" ? "ok" : "warn";
        runtime.stdout.write(
          `${statusLabel(label, mode)} ${file.path}: ${file.owner} ${file.owner_version}\n`,
        );
      }
    }
    runtime.stdout.write("\nAgents\n");
    for (const item of report.mcp) {
      runtime.stdout.write(
        `${statusLabel(item.installed ? "ok" : "warn", mode)} ${item.client}: ${
          item.installed ? "installed" : "not installed"
        }\n`,
      );
    }
    const next = cliAccount()?.doctorNextStep(report.checks) ?? null;
    if (next) {
      runtime.stdout.write(`\nNext: ${next}\n`);
    }
    return report.ok ? 0 : 1;
  } catch (err) {
    runtime.stderr.write(
      `${statusLabel("error", mode)} ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

const UPDATE_CHECKS = new Set([
  "cli_version",
  "update_checks",
  "cloud_compatibility",
  "running_sessions",
  "plugin_claude_code",
  "plugin_codex",
]);

function renderDoctorGroup(
  title: string,
  checks: CliDoctorCheck[],
  runtime: CliRuntime,
  mode: CliOutputMode,
): void {
  if (checks.length === 0) return;
  runtime.stdout.write(`\n${title}\n`);
  for (const check of checks) {
    runtime.stdout.write(
      `${statusLabel(check.status === "pass" ? "ok" : check.status === "warn" ? "warn" : "error", mode)} ${check.name}${check.detail ? `: ${check.detail}` : ""}\n`,
    );
  }
}
