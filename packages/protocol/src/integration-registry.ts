// SPDX-License-Identifier: Apache-2.0
/**
 * The integration registry: which AI coding agents Pathrule is wired into on this machine, through
 * which channel, and exactly which resources each integration owns.
 *
 * `<PATHRULE_HOME>/integrations/registry.json`. Every distribution path (the CLI's `pathrule
 * integrations`, the npx installer, a plugin's own setup) reads and writes this one file, so an
 * integration made by one path is updated, repaired and removed by any other. Removal deletes only
 * what a record lists; anything not listed belongs to the person or to another tool.
 */

export const INTEGRATION_REGISTRY_FILE = "registry.json";
export const INTEGRATION_REGISTRY_DIR = "integrations";
export const INTEGRATION_REGISTRY_SCHEMA = 1;

/** The providers with a native integration. Detection may know more; these can be installed. */
export type IntegrationProviderId = "claude-code" | "codex" | "cursor" | "gemini" | "opencode";
export type IntegrationScope = "user" | "project";
export type IntegrationMode = "local" | "cloud";
/**
 * How Pathrule reaches the agent:
 * - `native-plugin`: the provider's own plugin system (hooks, MCP and skills through a plugin);
 * - `settings-hook`: hook entries written into the provider's settings (the legacy channel);
 * - `mcp-only`: an MCP server entry and nothing that runs on lifecycle events.
 */
export type IntegrationChannel = "native-plugin" | "settings-hook" | "mcp-only";
/**
 * What the integration carries. `full` is hooks, MCP and skills; `directory` is what a public plugin
 * directory accepts (a remote MCP server and skills, no lifecycle hooks, no local process).
 */
export type IntegrationEdition = "full" | "directory";

export type IntegrationResource =
  /** A provider plugin installed through the provider's own plugin manager. */
  | {
      kind: "provider-plugin";
      provider: IntegrationProviderId;
      plugin: string;
      marketplace: string;
      scope: IntegrationScope;
    }
  /** A marketplace source Pathrule registered with the provider. */
  | { kind: "provider-marketplace"; provider: IntegrationProviderId; name: string; source: string }
  /** A directory or file Pathrule created and owns entirely. */
  | { kind: "owned-path"; path: string }
  /** Pathrule's hook entries inside a provider settings file the person also owns. */
  | { kind: "hook-entries"; path: string }
  /** Pathrule's MCP server entry inside a provider config file. */
  | { kind: "mcp-entry"; path: string; server: string };

export interface IntegrationRecord {
  /** `<provider>:<scope>` for user scope, `<provider>:project:<root>` for a project. */
  id: string;
  provider: IntegrationProviderId;
  scope: IntegrationScope;
  /** Absolute project root for project scope; null for user scope. */
  project_root: string | null;
  mode: IntegrationMode;
  channel: IntegrationChannel;
  edition: IntegrationEdition;
  /** Whether the MCP server ships with this integration (the hook frames its protocol by it). */
  mcp: boolean;
  plugin_version: string | null;
  runtime_version: string;
  installed_at: string;
  updated_at: string;
  /** `partial` while an apply has not finished; a repair completes or rolls it back. */
  status: "installed" | "partial";
  resources: IntegrationResource[];
}

export interface IntegrationRegistry {
  schema_version: typeof INTEGRATION_REGISTRY_SCHEMA;
  integrations: IntegrationRecord[];
}

export function integrationRecordId(
  provider: IntegrationProviderId,
  scope: IntegrationScope,
  projectRoot: string | null,
): string {
  return scope === "user" ? `${provider}:user` : `${provider}:project:${projectRoot ?? ""}`;
}

export function emptyIntegrationRegistry(): IntegrationRegistry {
  return { schema_version: INTEGRATION_REGISTRY_SCHEMA, integrations: [] };
}

const PROVIDERS = new Set<IntegrationProviderId>(["claude-code", "codex", "cursor", "gemini", "opencode"]);
const CHANNELS = new Set<IntegrationChannel>(["native-plugin", "settings-hook", "mcp-only"]);

function parseResource(value: unknown): IntegrationResource | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  switch (r.kind) {
    case "provider-plugin":
      return PROVIDERS.has(r.provider as IntegrationProviderId) &&
        typeof r.plugin === "string" &&
        typeof r.marketplace === "string" &&
        (r.scope === "user" || r.scope === "project")
        ? {
            kind: "provider-plugin",
            provider: r.provider as IntegrationProviderId,
            plugin: r.plugin,
            marketplace: r.marketplace,
            scope: r.scope,
          }
        : null;
    case "provider-marketplace":
      return PROVIDERS.has(r.provider as IntegrationProviderId) &&
        typeof r.name === "string" &&
        typeof r.source === "string"
        ? { kind: "provider-marketplace", provider: r.provider as IntegrationProviderId, name: r.name, source: r.source }
        : null;
    case "owned-path":
      return typeof r.path === "string" ? { kind: "owned-path", path: r.path } : null;
    case "hook-entries":
      return typeof r.path === "string" ? { kind: "hook-entries", path: r.path } : null;
    case "mcp-entry":
      return typeof r.path === "string" && typeof r.server === "string"
        ? { kind: "mcp-entry", path: r.path, server: r.server }
        : null;
    default:
      return null;
  }
}

function parseRecord(value: unknown): IntegrationRecord | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (!PROVIDERS.has(r.provider as IntegrationProviderId)) return null;
  if (r.scope !== "user" && r.scope !== "project") return null;
  if (r.mode !== "local" && r.mode !== "cloud") return null;
  if (!CHANNELS.has(r.channel as IntegrationChannel)) return null;
  if (r.edition !== "full" && r.edition !== "directory") return null;
  const projectRoot = typeof r.project_root === "string" ? r.project_root : null;
  if (r.scope === "project" && !projectRoot) return null;
  const resources = Array.isArray(r.resources)
    ? r.resources.map(parseResource).filter((x): x is IntegrationResource => x !== null)
    : [];
  const provider = r.provider as IntegrationProviderId;
  return {
    id: integrationRecordId(provider, r.scope, projectRoot),
    provider,
    scope: r.scope,
    project_root: r.scope === "project" ? projectRoot : null,
    mode: r.mode,
    channel: r.channel as IntegrationChannel,
    edition: r.edition,
    mcp: r.mcp !== false,
    plugin_version: typeof r.plugin_version === "string" ? r.plugin_version : null,
    runtime_version: typeof r.runtime_version === "string" ? r.runtime_version : "",
    installed_at: typeof r.installed_at === "string" ? r.installed_at : "",
    updated_at: typeof r.updated_at === "string" ? r.updated_at : "",
    status: r.status === "partial" ? "partial" : "installed",
    resources,
  };
}

/** Parse a registry read from disk. A malformed record is dropped; a malformed file is empty. */
export function parseIntegrationRegistry(raw: unknown): IntegrationRegistry {
  if (!raw || typeof raw !== "object") return emptyIntegrationRegistry();
  const r = raw as { schema_version?: unknown; integrations?: unknown };
  if (r.schema_version !== INTEGRATION_REGISTRY_SCHEMA || !Array.isArray(r.integrations)) {
    return emptyIntegrationRegistry();
  }
  const byId = new Map<string, IntegrationRecord>();
  for (const value of r.integrations) {
    const record = parseRecord(value);
    if (record) byId.set(record.id, record);
  }
  return { schema_version: INTEGRATION_REGISTRY_SCHEMA, integrations: [...byId.values()] };
}

/**
 * The integration that serves `cwd` for a provider: a project record whose root contains `cwd`
 * (longest root wins) before the user record. `contains` decides path containment so the caller's
 * platform rules (case, separators) apply.
 */
export function integrationFor(
  registry: IntegrationRegistry,
  provider: IntegrationProviderId,
  cwd: string,
  contains: (root: string, path: string) => boolean,
): IntegrationRecord | null {
  let best: IntegrationRecord | null = null;
  for (const record of registry.integrations) {
    if (record.provider !== provider || record.scope !== "project" || !record.project_root) continue;
    if (!contains(record.project_root, cwd)) continue;
    if (!best || (best.project_root?.length ?? 0) < record.project_root.length) best = record;
  }
  if (best) return best;
  return registry.integrations.find((r) => r.provider === provider && r.scope === "user") ?? null;
}
