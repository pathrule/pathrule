// SPDX-License-Identifier: Apache-2.0
// End-to-end "rerender every enabled non-Claude client's files" helper.
// Lives here so both the CLI's post-write sync and the MCP server's
// `rerenderClaudeMdAfterWrite` can call the same code path without
// duplicating the gather → resolve enabled → render → write dance.
//
// Node-only: imports from `./disk-writer.js` which uses fs.

import type { KnowledgeBackend } from "@pathrule/core";
import { renderTeamContextBlock } from "./team-context-block.js";

import type { AgentTargetId } from "@pathrule/core/skills/agent-targets.js";
import { enginesInUse, requiredTargetsForEngines } from "../skills/disk-detection.js";
import type { ManagedFileOwner } from "@pathrule/core/storage/managed-file-ownership.js";

import {
  gatherLocalMultiClientInput,
  renderForClients,
  type ClientRenderResult,
} from "./orchestrator.js";
import { pluginHookProviders } from "../native/ownership.js";
import { writeMultiClientFiles, type DiskWriteResult } from "./disk-writer.js";
import { sweepPathruleOwnLeftovers } from "./legacy-sweep.js";
import {
  resolveWorkspaceProtocolChannel,
  rulesFilesEnabled,
  type WorkspaceProtocolChannel,
} from "./protocol-channel-fs.js";
import type { MultiClientInput } from "./types.js";

// Historically only non-Claude clients flowed through this pipeline (the root
// CLAUDE.md has its own bespoke writer). With Native Knowledge Compilation,
// `claude-code` joins for its KNOWLEDGE-ONLY renderer (per-directory CLAUDE.md
// + .claude/rules/pathrule-knowledge.md) — the root CLAUDE.md still never
// renders here.
const RENDER_TARGETS: AgentTargetId[] = ["claude-code", "cursor", "codex", "windsurf"];

/** A single changed content item, used to scope an incremental re-render. */
export interface ChangedEntity {
  kind: "memory" | "rule" | "skill";
  id: string;
}

/**
 * Filter the gathered input down to the directory that owns `entity` (plus the
 * root "/" node, so every client keeps its turn-zero root knowledge section),
 * and report whether the orphan sweep should run. Returns the input untouched
 * with `sweep: true` when there is no entity, no compiled knowledge, or the
 * entity matches no node — i.e. a full, sweeping render.
 */
export function scopeToEntity(
  input: MultiClientInput,
  entity: ChangedEntity | undefined,
): { input: MultiClientInput; sweep: boolean } {
  if (!entity || !input.knowledge || input.knowledge.length === 0) {
    return { input, sweep: true };
  }
  const idField =
    entity.kind === "memory" ? "memory_ids" : entity.kind === "rule" ? "rule_ids" : "skill_ids";
  const matchedDirs = new Set(
    input.knowledge.filter((n) => n[idField].includes(entity.id)).map((n) => n.dir_path),
  );
  if (matchedDirs.size === 0) {
    // Entity not in the compiled set (deleted / truncated) — full render.
    return { input, sweep: true };
  }
  // Always keep the root node so non-Claude clients retain their root section.
  matchedDirs.add("/");
  const knowledge = input.knowledge.filter((n) => matchedDirs.has(n.dir_path));
  return { input: { ...input, knowledge }, sweep: false };
}

export interface RerenderOutcome {
  ok: boolean;
  enabled: AgentTargetId[];
  results: ClientRenderResult[];
  disk: DiskWriteResult;
  /**
   * The protocol-channel decision this render used, returned so the caller hands
   * the SAME one to syncHookIndex. The two writers disagreeing is the only
   * failure mode that loses the protocol entirely, so the decision travels with
   * the render instead of being taken twice.
   */
  protocolChannel?: WorkspaceProtocolChannel;
  /**
   * The rendered team-context block, present only when this render was in
   * signature mode — i.e. exactly when the compiled file that used to carry it
   * was not written. Returned for the same reason as `protocolChannel`: the
   * caller hands it to syncHookIndex, so the file half and the index half of one
   * decision cannot disagree.
   */
  teamContext?: string;
  /**
   * What the one-time legacy sweep removed, and what it left for the user.
   * Present only on the sync that actually ran it (once per workspace per
   * process). Reported so a deletion in the user's tree is never silent.
   */
  legacySweep?: { removed: string[]; held: string[] };
  error?: string;
}

export interface RerenderLocalArgs {
  /** SQLite-backed LocalBackend — the only data source in local mode. */
  backend: KnowledgeBackend;
  workspaceId: string;
  /** Display title for the companion files (LocalBackend.getWorkspaceName). */
  workspaceName: string;
  workspaceRoot: string;
  /** Local principal id stamped into reads. */
  userId: string;
  runtimeOwner?: ManagedFileOwner;
  runtimeVersion?: string;
  /**
   * The agents this render serves (claude-code, codex, opencode). Omitted: the agents Pathrule was set
   * up for in this folder (`enginesInUse`).
   */
  activeEngines?: readonly string[];
  /**
   * Process env, read only for the signature-mode rollout switch. Omitted falls
   * back to `process.env`, which is what every real caller wants; tests pass it
   * explicitly so the switch is never ambient.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Resolve the protocol channel for this render, and return the decision.
   *
   * OFF by default, and that default is a safety property rather than caution.
   * The decision has two halves: this render writes the files, and the caller
   * must hand the same decision to `syncHookIndex`. A caller that renders with a
   * signature but never passes the protocol on produces a workspace where the
   * protocol reaches the agent through NO channel. So a caller opts in only once
   * it carries both halves.
   */
  resolveChannel?: boolean;
}

/**
 * Renders the per-directory compiled knowledge files (claude-code's CLAUDE.md +
 * .claude/rules/pathrule-knowledge.md, plus the other clients' files) entirely from
 * the backend — no login, no network. Enabled clients are resolved from disk
 * detection + the default fallback. Best-effort —
 * never throws; knowledge files are an enhancement, not load-bearing for sync.
 */
export async function rerenderMultiClientLocal(args: RerenderLocalArgs): Promise<RerenderOutcome> {
  const empty: DiskWriteResult = { written: 0, skipped: 0, removed: 0, backedUp: [], changed: [], errors: [] };
  try {
    // A caller that names its agents (a native integration) serves exactly
    // those: setting up one agent writes no other agent's files, whatever
    // else the folder holds. The writer sweeps only what it renders, so the
    // other agents' files are left as they are, not removed. A caller that
    // names none serves the agents Pathrule was set up for here
    // (`enginesInUse`): Claude Code, and Codex only with Pathrule's own Codex
    // wiring, never because the person keeps an AGENTS.md.
    const enabled = requiredTargetsForEngines(
      args.activeEngines ?? (await enginesInUse(args.workspaceRoot, args.env ?? process.env)),
    );
    const targets = enabled.filter((c) => RENDER_TARGETS.includes(c));
    if (targets.length === 0) {
      return { ok: true, enabled, results: [], disk: empty };
    }

    const input = await gatherLocalMultiClientInput({
      backend: args.backend,
      workspaceId: args.workspaceId,
      workspaceName: args.workspaceName,
      userId: args.userId,
    });
    const env = args.env ?? process.env;
    const pluginHooks = await pluginHookProviders(args.workspaceRoot, env);
    const protocolChannel = args.resolveChannel
      ? await resolveWorkspaceProtocolChannel({
          workspaceRoot: args.workspaceRoot,
          enabled: targets,
          // Codex's renderer writes its hook config in this same render.
          installing: targets.includes("codex") && !pluginHooks.includes("codex") ? ["codex"] : [],
          env: args.env,
        })
      : undefined;
    // Deliberately NOT gated on signature mode: these leftovers are the residue
    // of a fixed bug, not part of the new channel, and expecting the user to run
    // eject to clean up after us is a chore we invented for them.
    const sweep = await sweepPathruleOwnLeftovers(args.workspaceRoot);
    const results = renderForClients({ ...input, rulesFiles: rulesFilesEnabled(env) }, targets, {
      protocolOnHook: protocolChannel?.signatureClients,
      hooksOnPlugin: pluginHooks,
    });
    const disk = await writeMultiClientFiles({
      workspaceRoot: args.workspaceRoot,
      results,
      sweepFor: targets,
      runtimeOwner: args.runtimeOwner,
      runtimeVersion: args.runtimeVersion,
    });
    return {
      ok: true,
      enabled,
      results,
      disk,
      protocolChannel,
      teamContext:
        protocolChannel && protocolChannel.signatureClients.length > 0
          ? (renderTeamContextBlock(input.teamContext) ?? undefined)
          : undefined,
      legacySweep: sweep.ran ? { removed: sweep.removed, held: sweep.held } : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      enabled: [],
      results: [],
      disk: empty,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
