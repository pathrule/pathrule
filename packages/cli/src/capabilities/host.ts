// SPDX-License-Identifier: Apache-2.0
/**
 * The capabilities of one run of the CLI. `main` prepares them before any command runs, and
 * `pathrule setup` adds the ones a newly chosen mode needs.
 *
 * - **Which:** Pathrule Cloud when anything on this machine uses it (the device default, a folder's
 *   choice, an attachment: `machineUsesCloud`); else the open CLI alone.
 * - **From where:** every capability is built into this CLI (./catalog.ts); preparing one loads its
 *   plugin and checks it against the plugins already accepted. Nothing is downloaded.
 * - **When Cloud cannot be loaded, a Cloud folder's commands refuse to run.** They would otherwise be
 *   served the local store in the account's place, which is other data. A Local folder's commands,
 *   the MCP server (which answers each Cloud folder's call with the same refusal) and `setup`,
 *   `doctor`, `status`, `config`, `help` and `version` still run, saying Cloud is not available.
 */
import type { Writable } from "node:stream";

import { CLI_VERSION } from "../cli-version.js";
import { checkCliPlugins, type CommandPlugin } from "../plugin.js";
import { machineUsesCloud } from "@pathrule/core/workspace/folder-mode.js";

import { capabilityById, type Capability, type CapabilityId } from "./catalog.js";
import { cloudNamed, folderEdition } from "./folder-edition.js";
import { capabilityHome, cliPackageDir } from "./home.js";
import {
  mapExistingInstall,
  readSelection,
  writeSelection,
  type CapabilitySelection,
} from "./selection.js";

export interface CapabilityProblem {
  id: CapabilityId;
  title: string;
  reason: string;
  /** `refuse`: commands that need it stop. `degraded`: the CLI runs without it and says so. */
  effect: "refuse" | "degraded";
}

/** One capability made ready: its built-in plugin, loaded. */
export interface CapabilityReady {
  id: CapabilityId;
  version: string;
  action: "loaded";
}

export interface CapabilityEvents {
  failed?(capability: Capability, reason: string): void;
}

export interface CapabilityHostOptions {
  env: NodeJS.ProcessEnv;
  version?: string;
  cliDir?: string;
  /** How a capability's plugin loads: its built-in loader unless a test gives another. */
  loadPlugin?: (capability: Capability) => Promise<CommandPlugin>;
}

export class CapabilityHost {
  readonly env: NodeJS.ProcessEnv;
  readonly version: string;
  readonly cliDir: string;
  /** This CLI copy's home: what its runtime-session leases name. */
  readonly home: string;
  selection: CapabilitySelection | null = null;
  /** The capabilities whose plugins this process loaded, in catalog order. */
  readonly loaded: CapabilityReady[] = [];
  readonly problems: CapabilityProblem[] = [];
  private readonly loadedPlugins: CommandPlugin[] = [];
  private readonly loadPlugin: (capability: Capability) => Promise<CommandPlugin>;

  constructor(options: CapabilityHostOptions) {
    this.env = options.env;
    this.loadPlugin = options.loadPlugin ?? ((capability) => capability.load());
    this.version = options.version ?? CLI_VERSION;
    this.cliDir = options.cliDir ?? cliPackageDir();
    this.home = capabilityHome(this.env, this.version, this.cliDir);
  }

  /** The stored selection, or the mapping of an install that predates onboarding (stored once). */
  async readSelection(): Promise<CapabilitySelection | null> {
    const stored = readSelection(this.env);
    if (stored) return (this.selection = stored);
    const mapped = await mapExistingInstall(this.env);
    if (!mapped) return (this.selection = null);
    try {
      return (this.selection = writeSelection(this.env, mapped));
    } catch {
      return (this.selection = { schema: 1, ...mapped, updatedAt: new Date().toISOString() });
    }
  }

  saveSelection(selection: Omit<CapabilitySelection, "schema" | "updatedAt">): CapabilitySelection {
    return (this.selection = writeSelection(this.env, selection));
  }

  /**
   * Loads the built-in plugin of each capability not loaded yet, in the order given, and checks it
   * against the plugins this process already accepted. A capability Cloud needs that fails makes
   * Cloud's failure a refusal; anything else degrades.
   */
  async obtain(
    ids: readonly CapabilityId[],
    events: CapabilityEvents = {},
  ): Promise<{ plugins: CommandPlugin[]; ready: CapabilityReady[]; failed: CapabilityProblem[] }> {
    const plugins: CommandPlugin[] = [];
    const ready: CapabilityReady[] = [];
    const failed: CapabilityProblem[] = [];
    const effect = ids.includes("cloud") ? "refuse" : "degraded";
    for (const id of ids) {
      if (this.loaded.some((c) => c.id === id)) continue;
      const capability = capabilityById(id);
      try {
        const plugin = await this.loadPlugin(capability);
        checkCliPlugins([...this.loadedPlugins, plugin]);
        const loaded: CapabilityReady = { id, version: this.version, action: "loaded" };
        plugins.push(plugin);
        ready.push(loaded);
        this.loaded.push(loaded);
        this.loadedPlugins.push(plugin);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failed.push({ id, title: capability.title, reason, effect });
        events.failed?.(capability, reason);
      }
    }
    return { plugins, ready, failed };
  }
}

let host: CapabilityHost | null = null;

/** This run's capability host: present in the npm CLI, absent in a composition with built-in plugins. */
export function capabilityHost(): CapabilityHost | null {
  return host;
}

export function installCapabilityHost(next: CapabilityHost | null): void {
  host = next;
}

/** The commands that run while a needed capability cannot be prepared: the ways to repair it. */
const REPAIR_COMMANDS = new Set(["setup", "doctor", "status", "config", "help", "version"]);

/** The first positional argument, the way the router reads it, plus `--version`/`--help`. */
export function commandOf(argv: readonly string[]): string {
  if (argv.includes("--version") || argv.includes("-v")) return "version";
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  return argv.find((arg) => !arg.startsWith("-")) ?? "help";
}

/**
 * Prepares the selected capabilities for this run and returns their plugins, or the reason the
 * command cannot run. Messages go to stderr: stdout belongs to the command (and to MCP's protocol).
 */
export async function prepareCapabilities(input: {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  stderr: Pick<Writable, "write">;
  host?: CapabilityHost;
  /** The folder the command runs in; the process's own by default. */
  cwd?: string;
}): Promise<
  | { ok: true; host: CapabilityHost; plugins: CommandPlugin[] }
  | { ok: false; host: CapabilityHost; message: string }
> {
  const current = input.host ?? new CapabilityHost({ env: input.env });
  installCapabilityHost(current);
  const command = commandOf(input.argv);
  if (command === "version") return { ok: true, host: current, plugins: [] };

  await current.readSelection();
  const wanted: CapabilityId[] = machineUsesCloud(input.env, { cloudAvailable: cloudNamed(input.env) })
    ? ["cloud"]
    : [];
  if (wanted.length === 0) return { ok: true, host: current, plugins: [] };

  const { plugins, failed } = await current.obtain(wanted);
  current.problems.push(...failed);

  const refused = failed.filter((p) => p.effect === "refuse");
  if (refused.length > 0 && !REPAIR_COMMANDS.has(command) && command !== "mcp") {
    const folder = folderEdition(input.cwd ?? process.cwd(), input.env);
    if (folder.mode !== "local") {
      const names = refused.map((p) => p.title).join(" and ");
      return {
        ok: false,
        host: current,
        message:
          `${names} could not be prepared for this CLI (${current.version}): ${refused.map((p) => p.reason).join("; ")}\n` +
          `  This folder uses Pathrule Cloud, and Pathrule does not run the local store in its place. ` +
          `Reinstall the CLI, or set this folder up without an account: \`pathrule setup --local\`.`,
      };
    }
  }
  for (const problem of failed) {
    input.stderr.write(
      problem.effect === "refuse"
        ? `pathrule: ${problem.title} is not available (${problem.reason}). Pathrule Local folders work; a Pathrule Cloud folder stops with this reason rather than use a Local store.\n`
        : `pathrule: ${problem.title} is not available (${problem.reason}). Pathrule runs without it; retry with \`pathrule setup --local\`.\n`,
    );
  }
  return { ok: true, host: current, plugins };
}

/** What the JSON envelope's `warnings` carries for this run. */
export function capabilityWarnings(): Array<{ code: string; message: string }> {
  return (host?.problems ?? []).map((problem) => ({
    code: problem.effect === "refuse" ? "capability_unavailable" : "capability_degraded",
    message: `${problem.title} is not available: ${problem.reason}`,
  }));
}

/** The doctor check for this run's capabilities, or null in a composition with built-in plugins. */
export function capabilityDoctorCheck(): {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
} | null {
  if (!host) return null;
  const refused = host.problems.filter((p) => p.effect === "refuse");
  const degraded = host.problems.filter((p) => p.effect === "degraded");
  if (refused.length > 0 || degraded.length > 0) {
    return {
      name: "capabilities",
      status: refused.length > 0 ? "fail" : "warn",
      detail: `${[...refused, ...degraded].map((p) => `${p.title} is not available: ${p.reason}`).join("; ")} — run \`pathrule setup\``,
    };
  }
  if (host.loaded.length === 0) {
    return {
      name: "capabilities",
      status: "pass",
      detail:
        host.selection?.setup === "local"
          ? "open source only (pathrule setup --local)"
          : "open CLI; no mode chosen yet (pathrule setup)",
    };
  }
  return {
    name: "capabilities",
    status: "pass",
    detail: `${host.loaded.map((c) => `${capabilityById(c.id).title} ${c.version}`).join(", ")}, built into this CLI`,
  };
}
