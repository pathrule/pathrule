// SPDX-License-Identifier: Apache-2.0
// `pathrule install`, `uninstall` and `eject`: what Pathrule writes into AI-client configs and the
// repository, and how it takes it out again.
import { installCliMcpTargets, uninstallCliTargets } from "../install-local.js";
import { jsonEnvelope, statusLabel, type CliOutputMode } from "../output.js";
import { cliAccount, type CliCommand, type CliRuntime } from "../plugin.js";

export const installCommand: CliCommand = {
  name: "install",
  help: {
    section: "workspace-setup",
    rank: 30,
    summary: "Install Pathrule MCP config for AI clients",
    usage: [
      "pathrule install [claude|codex|cursor|windsurf|copilot|all]",
      "For Claude Code and Codex with hooks and skills, prefer: pathrule integrations add <agent>",
    ],
  },
  jsonRank: 150,
  run: (ctx) => renderInstall(ctx.args[0], ctx.runtime, ctx.mode),
  json: (ctx) => runInstallJson(ctx.runtime, ctx.args[0]),
};

export const uninstallCommand: CliCommand = {
  name: "uninstall",
  help: {
    section: "workspace-setup",
    rank: 40,
    summary: "Remove Pathrule MCP config for AI clients",
    usage: ["pathrule uninstall [claude|codex|cursor|windsurf|copilot|all]"],
  },
  jsonRank: 160,
  run: (ctx) => renderUninstall(ctx.args[0], ctx.runtime, ctx.mode),
  json: (ctx) => runUninstallJson(ctx.runtime, ctx.args[0]),
};

/** `eject` has no `--json` form: it answers `unknown_command`, as it always has. */
export const ejectCommand: CliCommand = {
  name: "eject",
  jsonRank: 170,
  run: (ctx) => renderEject(ctx.runtime, ctx.mode, ctx.flags.apply === true),
};

async function runInstallJson(runtime: CliRuntime, target: string | undefined) {
  try {
    const data = await installCliMcpTargets(target, runtime.env);
    return {
      exitCode: data.every((item) => item.ok) ? 0 : 1,
      envelope: jsonEnvelope({
        command: "install",
        cwd: runtime.cwd,
        ok: data.every((item) => item.ok),
        data,
      }),
    };
  } catch (err) {
    return {
      exitCode: err instanceof Error && err.message === "invalid_install_target" ? 64 : 1,
      envelope: jsonEnvelope({
        command: "install",
        cwd: runtime.cwd,
        ok: false,
        error: {
          code: err instanceof Error ? err.message : "install_failed",
          message: err instanceof Error ? err.message : String(err),
        },
      }),
    };
  }
}

async function runUninstallJson(runtime: CliRuntime, target: string | undefined) {
  try {
    const data = await uninstallCliTargets(target, runtime.env);
    return {
      exitCode: data.every((item) => item.ok) ? 0 : 1,
      envelope: jsonEnvelope({
        command: "uninstall",
        cwd: runtime.cwd,
        ok: data.every((item) => item.ok),
        data,
      }),
    };
  } catch (err) {
    return {
      exitCode: err instanceof Error && err.message === "invalid_install_target" ? 64 : 1,
      envelope: jsonEnvelope({
        command: "uninstall",
        cwd: runtime.cwd,
        ok: false,
        error: {
          code: err instanceof Error ? err.message : "uninstall_failed",
          message: err instanceof Error ? err.message : String(err),
        },
      }),
    };
  }
}

async function renderInstall(
  target: string | undefined,
  runtime: CliRuntime,
  mode: CliOutputMode,
): Promise<number> {
  try {
    const results = await installCliMcpTargets(target, runtime.env);
    for (const result of results) {
      runtime.stdout.write(
        `${statusLabel(result.ok ? "ok" : "error", mode)} ${result.client}: ${result.status} (${result.config_path})\n`,
      );
    }
    const ok = results.every((result) => result.ok);
    if (ok) {
      await cliAccount()?.afterInstall(runtime, mode);
    }
    return ok ? 0 : 1;
  } catch (err) {
    runtime.stderr.write(
      `${statusLabel("error", mode)} ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return err instanceof Error && err.message === "invalid_install_target" ? 64 : 1;
  }
}

async function renderUninstall(
  target: string | undefined,
  runtime: CliRuntime,
  mode: CliOutputMode,
): Promise<number> {
  try {
    const results = await uninstallCliTargets(target, runtime.env);
    for (const result of results) {
      runtime.stdout.write(
        `${statusLabel(result.ok ? "ok" : "error", mode)} ${result.client}: ${result.status} (${result.config_path})\n`,
      );
    }
    return results.every((result) => result.ok) ? 0 : 1;
  } catch (err) {
    runtime.stderr.write(
      `${statusLabel("error", mode)} ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return err instanceof Error && err.message === "invalid_install_target" ? 64 : 1;
  }
}

/**
 * `pathrule eject` — take Pathrule out of this repo.
 *
 * Plan by default, apply only with `--apply`. That asymmetry is deliberate: this
 * command deletes and rewrites files in the user's working tree, and a
 * destructive default is how a trust feature becomes a support ticket. The plan
 * is also the honest answer to "what did Pathrule put in my repo".
 */
async function renderEject(
  runtime: CliRuntime,
  mode: CliOutputMode,
  apply: boolean,
): Promise<number> {
  try {
    const { planEject, applyEject } = await import("@pathrule/integrations/eject.js");
    const plan = await planEject(runtime.cwd);

    // A file whose Pathrule part cannot be told apart from the person's text is never changed: said, so
    // they can look at it themselves.
    for (const u of plan.unclear) {
      runtime.stdout.write(`${statusLabel("warn", mode)} ${u.path} left as it is: ${u.reason}\n`);
    }
    if (plan.actions.length === 0) {
      runtime.stdout.write(
        `${statusLabel("ok", mode)} nothing to eject: Pathrule owns no file here\n`,
      );
      return 0;
    }

    for (const action of plan.actions) {
      const target = action.target ? ` -> ${action.target}` : "";
      runtime.stdout.write(`  ${action.kind}: ${action.path}${target}  (${action.reason})\n`);
    }
    for (const gone of plan.missing) {
      runtime.stdout.write(`  already gone: ${gone}\n`);
    }

    if (!apply) {
      runtime.stdout.write(
        `${statusLabel("ok", mode)} ${plan.actions.length} change(s) planned. Re-run with --apply to carry them out.\n`,
      );
      return 0;
    }

    const result = await applyEject(runtime.cwd, plan);
    for (const r of result.results) {
      if (r.outcome === "done") continue;
      runtime.stdout.write(
        `${statusLabel(r.outcome === "failed" ? "error" : "warn", mode)} ${r.action.path}: ${r.outcome}${r.note ? ` (${r.note})` : ""}\n`,
      );
    }
    runtime.stdout.write(
      `${statusLabel(result.failed === 0 ? "ok" : "error", mode)} ejected: ${result.done} done, ${result.skipped} skipped, ${result.failed} failed\n`,
    );
    return result.failed === 0 ? 0 : 1;
  } catch (err) {
    runtime.stderr.write(
      `${statusLabel("error", mode)} ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}
