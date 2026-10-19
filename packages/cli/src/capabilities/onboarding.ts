// SPDX-License-Identifier: Apache-2.0
/**
 * Loading Pathrule Cloud into this run when a command needs it and the machine did not use it yet:
 * `pathrule setup --cloud` in a first Cloud folder, and an approved Cloud integration
 * (`pathrule integrations`). Which edition a folder uses is settled elsewhere
 * (./folder-setup.ts); this only makes the chosen edition's code ready.
 *
 * Every capability is built into the CLI (./catalog.ts): loading one downloads nothing.
 */
import { statusLabel, type CliOutputMode } from "../output.js";
import { addCliPlugins, type CliRuntime } from "../plugin.js";
import { MODE_CAPABILITIES, type Capability, type SetupMode } from "./catalog.js";
import {
  capabilityHost,
  type CapabilityHost,
  type CapabilityProblem,
  type CapabilityReady,
} from "./host.js";

/**
 * Loads what a mode needs from this CLI, saying so in the terminal when it cannot. Loading adds the
 * plugins to this process, so the rest of the command runs with them.
 */
export async function prepareMode(
  host: CapabilityHost,
  mode: SetupMode,
  runtime: CliRuntime,
  output: CliOutputMode,
): Promise<{ ok: boolean; ready: CapabilityReady[]; failed: CapabilityProblem[] }> {
  const say = (text: string) => {
    if (!output.json) runtime.stdout.write(text);
  };
  const { plugins, failed } = await host.obtain(MODE_CAPABILITIES[mode], {
    failed: (c: Capability, reason: string) =>
      say(
        `${statusLabel(mode === "cloud" ? "error" : "warn", output)} ${c.title} could not be loaded: ${reason}\n`,
      ),
  });
  addCliPlugins(plugins);
  const all = [...host.loaded.filter((c) => MODE_CAPABILITIES[mode].includes(c.id))];
  return { ok: failed.length === 0, ready: all, failed };
}

/**
 * Prepare the capabilities a mode needs in this run: what an approved integration setup
 * (`pathrule integrations`) does before it records a Cloud integration. Null when this run has no
 * capability host (a composition with its plugins built in): nothing to prepare. It changes no
 * folder's edition and not the device default.
 */
export async function prepareCapabilitiesFor(
  mode: SetupMode,
  runtime: CliRuntime,
  output: CliOutputMode,
): Promise<{ ok: boolean; failed: CapabilityProblem[] } | null> {
  const host = capabilityHost();
  if (!host) return null;
  const prepared = await prepareMode(host, mode, runtime, output);
  return { ok: prepared.ok, failed: prepared.failed };
}
