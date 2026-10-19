// SPDX-License-Identifier: Apache-2.0
// The integration engine's contract (./manager.ts): what a request asks for, what the engine needs
// from the program it runs in, and the plan a person previews before it is applied. The engine
// re-exports every type here, so callers keep importing them from ./manager.ts.

import type {
  IntegrationChannel,
  IntegrationMode,
  IntegrationProviderId,
  IntegrationRecord,
  IntegrationScope,
} from "@pathrule/protocol/integration-registry.js";

import type { LegacyHookFile } from "./legacy-hooks.js";
import type { PluginBundleInput } from "./plugin-bundle.js";

export interface IntegrationRequest {
  provider: IntegrationProviderId;
  scope: IntegrationScope;
  /** Absolute project root; required for project scope, and the workspace a Local setup prepares. */
  projectRoot: string | null;
  /**
   * What this setup prepares. `cloud`: Pathrule Cloud in this runtime. `local`: the project's Local
   * workspace, when the project is a Local folder. Neither changes a folder's edition or the device
   * default, and the MCP server it records names no edition: it serves each project from its own.
   */
  mode: IntegrationMode;
  channel: IntegrationChannel;
  /** Hook-triggered maintenance consent (stale index refresh, learning evidence drain). */
  maintenance: boolean;
  /**
   * Whether this integration gives the agent Pathrule's MCP server. A native plugin always bundles
   * it; the settings-hook channel without it is hook-only, and the hook then frames its protocol
   * without naming a single `pathrule_*` tool.
   */
  mcp: boolean;
  /**
   * `install`: Pathrule installs the provider plugin through the provider's plugin manager.
   * `attach`: the plugin is already installed (from a marketplace); record it and finish setup.
   */
  pluginSource: "install" | "attach";
  pluginVersion: string | null;
}

/** A provider CLI result. */
export interface ProviderCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** What the engine needs from the program it runs in (the CLI). */
export interface IntegrationHost {
  env: NodeJS.ProcessEnv;
  home: string;
  now(): Date;
  runtimeVersion: string;
  /** Plugin assets and pins for the marketplace this runtime materializes. */
  bundleInput(): PluginBundleInput;
  /** The provider CLI on PATH, or null. */
  providerBinary(provider: IntegrationProviderId): Promise<string | null>;
  runProvider(provider: IntegrationProviderId, args: string[]): Promise<ProviderCommandResult>;
  /**
   * Install the canonical hook and write the runtime manifest, whose MCP launch names no edition.
   * `cloud` also prepares Pathrule Cloud in this runtime.
   */
  ensureRuntime(input: { mode: IntegrationMode; maintenance: boolean }): Promise<{ manifestPath: string; hookPath: string }>;
  /**
   * The edition that serves `root` (core's resolveFolderMode). Null `mode` is a conflict, which
   * `conflict` describes. An integration reads it and never changes it.
   */
  folderEdition(root: string): Promise<{ mode: IntegrationMode | null; conflict: string | null }>;
  /**
   * Local: make `root` a workspace (idempotent) and build its hook index. Only `provider`'s files
   * are written into the project: setting up one agent never writes another agent's config.
   */
  ensureLocalWorkspace(root: string, provider: IntegrationProviderId): Promise<{ workspaceId: string; created: boolean }>;
  /** Cloud: what this machine's account state is. Never signs in. */
  cloudStatus(): Promise<{ ready: boolean; signedIn: boolean; detail: string; loginCommand: string }>;
  /** Write Pathrule's hook entries into a provider settings file (the settings-hook channel). */
  writeSettingsHooks(provider: IntegrationProviderId, path: string): Promise<{ changed: boolean }>;
  /**
   * Write (or remove) Pathrule's MCP entry in the provider's user config (the settings-hook
   * channel): the one entry every project uses, which names no edition.
   */
  installMcpEntry(provider: IntegrationProviderId): Promise<{ path: string; server: string }>;
  removeMcpEntry(provider: IntegrationProviderId): Promise<void>;
}

export type OperationKind =
  | "runtime"
  | "local-workspace"
  | "cloud-check"
  | "materialize-marketplace"
  | "provider-marketplace"
  | "provider-plugin"
  | "remove-legacy-hooks"
  | "settings-hooks"
  | "mcp-entry"
  | "registry";

export interface PlannedOperation {
  kind: OperationKind;
  /** One sentence a person reads in the preview. */
  summary: string;
  /** Files this operation may change. */
  paths: string[];
  /** Provider commands this operation runs, as typed. */
  commands: string[];
}

export interface IntegrationPlan {
  request: IntegrationRequest;
  operations: PlannedOperation[];
  warnings: string[];
  /** Set when the plan cannot run here; `operations` then says what would have run. */
  blocked: { code: string; message: string; manual?: string[] } | null;
  legacyHooks: LegacyHookFile[];
  existing: IntegrationRecord | null;
}
