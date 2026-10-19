// SPDX-License-Identifier: Apache-2.0
/**
 * What the host asks of its plugins. The host is open and runs fully without any: it owns the local
 * stores, serves its RPC and answers with the open defaults. Pathrule Cloud reaches it as a
 * plugin, which a composition root (the CLI) passes to `startHost`; the host never discovers or
 * imports one itself.
 *
 * A plugin the host cannot run is refused and reported in `host.hello`, never run silently:
 * - built for another `HOST_PLUGIN_CONTRACT`;
 * - resolved a second copy of a package whose state the host shares, core or integrations (an
 *   engine installed into another copy of core's engine slot is an engine the host never sees);
 * - a name the host cannot give it: invalid, taken by another plugin, or one of the host's own
 *   method namespaces.
 *
 * Each composition decides what a missing plugin means for it.
 */
import { CORE_PACKAGE } from "@pathrule/core/package-instance.js";
import { INTEGRATIONS_PACKAGE } from "@pathrule/integrations/package-instance.js";
import { assertSharedPackages, type PackageInstance } from "@pathrule/protocol/package-instance.js";
// The contract version lives only in `protocol`: a plugin reads it from its own copy, never through
// this module, which would hand it the host's number.
import { HOST_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import type { LocalBackend } from "@pathrule/core/backend/local/local-backend.js";

import type { PersonalStoreBinding } from "@pathrule/core/engine/contracts.js";

import type { ResolvedTurnBackend, TurnContextAccount } from "./context/compile.js";
import type { HostMethodHandler } from "./methods.js";

/** The shared packages, as this host resolved them. A plugin must have resolved the same copies. */
export const HOST_SHARED_PACKAGES: readonly PackageInstance[] = [
  CORE_PACKAGE,
  INTEGRATIONS_PACKAGE,
];

/** The host's store owner, for a plugin that keeps a local copy of a workspace hosted elsewhere. */
export interface HostPluginStores {
  /** The store of `workspaceId`, opened on first use and closed when the host stops. */
  get(workspaceId: string): LocalBackend;
  /** Marks it as a mirror, which local discovery skips. */
  markMirror(workspaceId: string): void;
}

/**
 * What an account (Pathrule Cloud) gives the host: the backend of a folder no local store serves, who
 * is signed in, and what the account adds to a turn. The host asks it after its local stores.
 */
export interface HostAccountEdition<R extends ResolvedTurnBackend = ResolvedTurnBackend> {
  resolveBackend(cwd: string): Promise<R | null>;
  /** Who is signed in; it partitions the turn cache. */
  identity(): Promise<string>;
  turnContext: TurnContextAccount<R>;
  /**
   * The person's account id and belief store for a workspace, when the account binds one through an
   * explicit mapping; null or absent leaves the no-account person's local file. The host asks it
   * once per compiled turn, bounded, and treats a failure as absent.
   */
  personal?(input: { resolved: R; workspaceId: string }): Promise<PersonalStoreBinding | null>;
}

export interface HostPluginContext {
  readonly env: NodeJS.ProcessEnv;
  readonly stores: HostPluginStores;
  /**
   * Gives the host its account edition. One plugin at most provides one; a second activation that
   * tries fails. Only while `activate` runs.
   */
  provideAccount<R extends ResolvedTurnBackend>(edition: HostAccountEdition<R>): void;
  /**
   * Serves `<plugin name>.<method>` over the host's RPC. Only while `activate` runs; a plugin
   * whose activation fails serves none of the methods it registered.
   */
  registerMethod(method: string, handler: HostMethodHandler): void;
  /**
   * Keeps a host that stops when idle running until the returned function is called: for a plugin
   * with work of its own (Cloud's daemon job while an account is signed in). Any time, not only
   * during `activate`; it does nothing once the host stops.
   */
  keepAlive(reason: string): () => void;
  log(line: string): void;
}

export interface HostPlugin {
  /** Lowercase letters, digits and dashes; also the namespace of its methods. */
  readonly name: string;
  /**
   * The `HOST_PLUGIN_CONTRACT` the plugin was built against, imported from
   * `@pathrule/protocol/plugin-contracts.js` (its own copy).
   */
  readonly contract: number;
  /**
   * The copy of each shared package the plugin imports (the `*_PACKAGE` token of every one it uses
   * among those the host shares, as the plugin resolved it).
   */
  readonly sharedPackages: readonly PackageInstance[];
  /** Runs once, after the host claimed its home and before it serves requests. */
  activate?(context: HostPluginContext): void | Promise<void>;
  /**
   * Runs once when the host stops, after requests drained, for every plugin whose `activate` was
   * called, failed or not, so a partial activation can be undone.
   */
  deactivate?(): void | Promise<void>;
}

const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;

/** Why the host cannot run `plugin`, or null when it can. */
export function hostPluginRefusal(
  plugin: HostPlugin,
  context: { hostNamespaces: ReadonlySet<string>; takenNames: ReadonlySet<string> },
): string | null {
  if (!PLUGIN_NAME.test(plugin.name)) {
    return `"${plugin.name}" is not a plugin name (lowercase letters, digits and dashes)`;
  }
  if (context.hostNamespaces.has(plugin.name)) {
    return `"${plugin.name}" is a namespace of the host's own methods`;
  }
  if (context.takenNames.has(plugin.name)) {
    return `another plugin is already named "${plugin.name}"`;
  }
  if (plugin.contract !== HOST_PLUGIN_CONTRACT) {
    return `built for host plugin contract ${plugin.contract}; this host speaks ${HOST_PLUGIN_CONTRACT}`;
  }
  try {
    assertSharedPackages({
      seam: "host",
      plugin: plugin.name,
      host: HOST_SHARED_PACKAGES,
      resolved: plugin.sharedPackages,
    });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}
