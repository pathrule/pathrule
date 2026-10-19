// SPDX-License-Identifier: Apache-2.0
/**
 * Which Pathrule MCP server this is, and whether it still fits what is around it: the version the
 * CLI started it as, the contracts it speaks, the agent plugin that launched it, and what the last
 * verified release manifest on disk says about all of them.
 *
 * It never touches the network and never restarts anything. The server reports this in
 * `pathrule_ping` and, only when something needs the person, one line in its `instructions`, so an
 * agent can tell them which component is outdated, how to update it and whether a restart is
 * needed. A Cloud release that still accepts the server's contracts produces nothing here.
 */
import { cachedReleaseManifest } from "@pathrule/core/release/release-feed.js";
import { PATHRULE_CONTRACTS } from "@pathrule/protocol/compatibility.js";
import {
  assessComponent,
  assessServiceContracts,
  compareVersions,
  type ReleaseComponentId,
  type ReleaseDistributionId,
  type ReleaseManifest,
} from "@pathrule/protocol/release-manifest.js";

/** Before a CLI says which version it runs (a harness, the standalone dev bin). */
const UNKNOWN_VERSION = "0.0.0-dev";

let version = UNKNOWN_VERSION;
let installedVersion: () => string | null = () => null;
/** The channel this copy was installed from; null when something else updates it (an editor). */
let distribution: ReleaseDistributionId | null = "npm";

export function setMcpServerVersion(next: {
  version?: string;
  installedVersion?: () => string | null;
  distribution?: ReleaseDistributionId | null;
}): void {
  if (next.version) version = next.version;
  if (next.installedVersion) installedVersion = next.installedVersion;
  if (next.distribution !== undefined) distribution = next.distribution;
}

export function mcpServerVersion(): string {
  return version;
}

export interface McpCompatibilityIssue {
  /** The component that must change. */
  component: "mcp-server" | "agent-plugin";
  kind: "restart_required" | "update_required" | "update_available";
  message: string;
  /** What to do, in one line. */
  action: string;
}

export interface McpCompatibilityReport {
  server: { name: "pathrule"; version: string; contracts: Readonly<Record<string, number>> };
  plugin: { version: string; host: string | null } | null;
  /** The version installed on disk, when it is not the one this server runs. */
  installed_version: string | null;
  restart_required: boolean;
  issues: McpCompatibilityIssue[];
  /** When the release manifest this is based on was verified; null without one. */
  manifest_checked_at: string | null;
}

const PLUGIN_COMPONENTS: Record<
  string,
  {
    component: ReleaseComponentId;
    distribution: "claude-marketplace" | "codex-marketplace";
    update: string;
  }
> = {
  "claude-code": {
    component: "claude-code-plugin",
    distribution: "claude-marketplace",
    update:
      "update the Pathrule plugin in Claude Code (/plugin), then run /reload-plugins or start a new session",
  },
  codex: {
    component: "codex-plugin",
    distribution: "codex-marketplace",
    update: "update the Pathrule plugin in Codex, then start a new session",
  },
};

/** The report for this server, from the environment its launcher set and the manifest on disk. */
export function mcpCompatibilityReport(input: {
  env: NodeJS.ProcessEnv;
  clientId: string | null;
  manifest?: { manifest: ReleaseManifest; checkedAt: string } | null;
  now?: Date;
}): McpCompatibilityReport {
  const { env } = input;
  const issues: McpCompatibilityIssue[] = [];
  const onDisk = safe(installedVersion);
  const restart =
    onDisk !== null && onDisk !== version && (compareVersions(onDisk, version) ?? 0) > 0;
  if (restart) {
    issues.push({
      component: "mcp-server",
      kind: "restart_required",
      message: `Pathrule ${onDisk} is installed, but this session's MCP server still runs ${version}.`,
      action: "Restart this agent session to activate the new version.",
    });
  }

  const verified =
    input.manifest === undefined ? cachedReleaseManifest(env, { now: input.now }) : input.manifest;
  const manifest = verified?.manifest ?? null;
  if (manifest && !restart) {
    const cloud = assessServiceContracts(manifest, "cloud", PATHRULE_CONTRACTS);
    const cli = distribution
      ? assessComponent(manifest, {
          component: "cli",
          distribution,
          track: "latest",
          installedVersion: version,
        })
      : null;
    if ((!cloud.ok && cloud.reason === "client_outdated") || cli?.status === "update_required") {
      issues.push({
        component: "mcp-server",
        kind: "update_required",
        message:
          "Your Pathrule MCP server is outdated. Update it to continue using the latest Cloud capabilities.",
        action: "Run `pathrule update` in a terminal, then restart this agent session.",
      });
    } else if (cli?.status === "update_available" && cli.latest) {
      issues.push({
        component: "mcp-server",
        kind: "update_available",
        message: `Pathrule ${cli.latest.version} is available. This MCP server runs ${version}.`,
        action:
          "Run `pathrule update` in a terminal; the new version starts with the next agent session.",
      });
    }
  }

  const pluginVersion = env.PATHRULE_PLUGIN_VERSION?.trim() || null;
  const host = input.clientId;
  const plugin = pluginVersion && host ? PLUGIN_COMPONENTS[host] : undefined;
  if (manifest && pluginVersion && plugin) {
    const assessed = assessComponent(manifest, {
      component: plugin.component,
      distribution: plugin.distribution,
      track: "latest",
      installedVersion: pluginVersion,
    });
    if (assessed.status === "update_required") {
      issues.push({
        component: "agent-plugin",
        kind: "update_required",
        message: `The Pathrule plugin (${pluginVersion}) is older than the minimum this release needs (${assessed.compatibility.ok ? "" : assessed.compatibility.minimum}).`,
        action: `To keep it working, ${plugin.update}.`,
      });
    } else if (assessed.status === "update_available" && assessed.latest) {
      // Optional: in pathrule_ping only. A host that updates plugins by itself needs nothing.
      issues.push({
        component: "agent-plugin",
        kind: "update_available",
        message: `The Pathrule plugin ${assessed.latest.version} is available (this session runs ${pluginVersion}).`,
        action: `If the host does not update it by itself, ${plugin.update}.`,
      });
    }
  }

  return {
    server: { name: "pathrule", version, contracts: PATHRULE_CONTRACTS },
    plugin: pluginVersion ? { version: pluginVersion, host } : null,
    installed_version: restart ? onDisk : null,
    restart_required: restart,
    issues,
    manifest_checked_at: verified?.checkedAt ?? null,
  };
}

/**
 * One line for the server's `instructions`, only for an issue the person must act on (a required
 * update or a restart); null otherwise, so the instructions stay the same from session to session.
 */
export function compatibilityInstruction(report: McpCompatibilityReport): string | null {
  const urgent = report.issues.filter((issue) => issue.kind !== "update_available");
  if (urgent.length === 0) return null;
  return `Tell the user, once: ${urgent.map((issue) => `${issue.message} ${issue.action}`).join(" ")}`;
}

function safe(read: () => string | null): string | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** How often a session looks at the disk for something to tell its user. */
const NOTICE_LOOK_EVERY_MS = 60_000;
const delivered = new Set<string>();
let lastLook = Number.NEGATIVE_INFINITY;

function issueKey(issue: McpCompatibilityIssue): string {
  return `${issue.component}:${issue.kind}`;
}

/** Issues the initialize instructions already carried are not repeated in a tool result. */
export function markNoticesDelivered(report: McpCompatibilityReport): void {
  for (const issue of report.issues) delivered.add(issueKey(issue));
}

/**
 * A notice for this session's next tool result, at most once per issue for the life of the
 * server: Pathrule updated on disk while the session runs (restart to activate it), or a required
 * compatibility update. Looks at the disk at most once a minute, never at the network, so a tool
 * call is not slower for it. Optional updates stay in `pathrule_ping`.
 */
export function takeSessionNotice(
  env: NodeJS.ProcessEnv,
  clientId: string | null,
  now: number = Date.now(),
): string | null {
  if (now - lastLook < NOTICE_LOOK_EVERY_MS) return null;
  lastLook = now;
  let report: McpCompatibilityReport;
  try {
    report = mcpCompatibilityReport({ env, clientId });
  } catch {
    return null;
  }
  for (const issue of report.issues) {
    if (issue.kind === "update_available" || delivered.has(issueKey(issue))) continue;
    delivered.add(issueKey(issue));
    return `Tell the user once: ${issue.message} ${issue.action}`;
  }
  return null;
}

/** Tests: forget what was delivered and when the disk was last read. */
export function resetSessionNotices(): void {
  delivered.clear();
  lastLook = Number.NEGATIVE_INFINITY;
}
