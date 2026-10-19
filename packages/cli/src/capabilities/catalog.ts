// SPDX-License-Identifier: Apache-2.0
/**
 * The capabilities a mode adds to the CLI, and the mode that adds each one.
 *
 * Every capability is open source and built into this CLI: choosing the mode that needs one
 * (`pathrule setup --cloud`) loads its plugin from the CLI itself. Nothing is downloaded, so npm,
 * Homebrew, the standalone tarball and the VS Code extension offer the same modes.
 */
import type { CommandPlugin } from "../plugin.js";

export type CapabilityId = "cloud";

/** The modes `pathrule setup` offers. */
export type SetupMode = "cloud" | "local";

export interface Capability {
  readonly id: CapabilityId;
  /** The name the person sees. */
  readonly title: string;
  /** Its CLI plugin, built into this CLI. */
  readonly load: () => Promise<CommandPlugin>;
}

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "cloud",
    title: "Pathrule Cloud",
    load: async () => (await import("@pathrule/cloud/cli/plugin.js")).cloudCliPlugin(),
  },
];

/**
 * What each mode loads. Local (`pathrule setup --local`) loads nothing: no account and no network
 * service.
 */
export const MODE_CAPABILITIES: Readonly<Record<SetupMode, readonly CapabilityId[]>> = {
  cloud: ["cloud"],
  local: [],
};

export function capabilityById(id: CapabilityId): Capability {
  const found = CAPABILITIES.find((c) => c.id === id);
  if (!found) throw new Error(`Unknown capability: ${id}`);
  return found;
}

/** The ids in catalog order, each once, unknown ones dropped. */
export function orderedCapabilities(ids: Iterable<string>): CapabilityId[] {
  const wanted = new Set(ids);
  return CAPABILITIES.filter((c) => wanted.has(c.id)).map((c) => c.id);
}
