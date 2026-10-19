// SPDX-License-Identifier: Apache-2.0
/**
 * Rewrite one workspace's offline hook index with everything the hook reads from it: the protocol
 * (when the companion files are in signature mode), the team block, the person's entries, the
 * account's semantic endpoint, and the knowledge itself.
 *
 * get_context ran this inline. A write needs it too: in a local workspace nothing else rewrites the
 * index after a write except the next get_context (which agents are told not to call reflexively)
 * or a background maintenance run, so an atom an agent just captured missed the very next edit it
 * was meant for. syncHookIndex REWRITES the file, so every writer must pass all of these parts, or
 * one writer silently erases what another stamped.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveLocalPrincipal, type KnowledgeBackend } from "@pathrule/core";
import type { StatementExtraction, StatementPrompt } from "@pathrule/core/maintenance/model-statements.js";
import { learnFromUserWords } from "@pathrule/core/maintenance/stated-decisions.js";
import { learnFromEndedTurns } from "@pathrule/core/maintenance/turn-lessons.js";
import { rerenderMultiClientLocal } from "@pathrule/integrations/client-renderers/pipeline.js";
import { errorMessage } from "@pathrule/protocol/failure-class.js";
import type { ToolContext } from "@pathrule/core/tools/types.js";
import { localRuntimePaths } from "@pathrule/core/storage/paths.js";
import { readCloudFolderBindings } from "@pathrule/core/workspace/folder-mode.js";
import { syncHookIndex } from "@pathrule/integrations/index-writers/hook-index-writer.js";
import { HOOK_CAPABLE_CLIENTS } from "@pathrule/integrations/client-renderers/protocol-channel.js";
import { resolveWorkspaceProtocolChannel } from "@pathrule/integrations/client-renderers/protocol-channel-fs.js";
import { renderTeamContextBlock } from "@pathrule/integrations/client-renderers/team-context-block.js";
import { getLocalBackend, isProjectContext, projectSemanticEndpoint } from "../local-runtime.js";
import { mcpPersonalAccount } from "../plugin.js";
import { mcpServerVersion } from "../server-version.js";
import { hookIndexPersonEntries } from "../tools/intelligence-sections.js";

export async function syncWorkspaceHookIndex(input: {
  ctx: ToolContext;
  workspaceId: string;
  localRootPath: string;
}): Promise<void> {
  const { ctx, workspaceId, localRootPath } = input;
  const backend = ctx.backend;
  if (!backend) return;
  try {
    // A local workspace first takes in what the hook observed (deliveries, file changes, tool events),
    // so activity and outcome evidence do not wait for an agent to call log_activity.
    if (!isProjectContext(ctx)) {
      const cacheDir = join(localRuntimePaths(process.env).home, "cache", workspaceId);
      const store = await getLocalBackend(workspaceId);
      await store.ingestObservationsFromDisk(workspaceId, join(cacheDir, "knowledge-observations.jsonl")).catch(() => undefined);
      // What ended turns' own commands taught, and what the person stated as lasting in their prompts:
      // saved at the root, so the rules folder is written again.
      const learned = (await learnFromEndedTurns(store, workspaceId, cacheDir).catch(() => 0)) + (await learnFromUserWords(store, workspaceId, cacheDir).catch(() => 0));
      if (learned > 0) await renderLocalClaudeRules(backend, workspaceId, localRootPath);
    } else {
      // A Cloud workspace: the same drains, writing through the Project backend's public writes, so a
      // Cloud folder keeps its command lessons and stated decisions with no Local store. A typed prompt
      // the marker table read nothing in goes to the Cloud's model tier, which only copies; the drain saves.
      const cacheDir = join(localRuntimePaths(process.env).home, "cache", workspaceId);
      const tier = backend as KnowledgeBackend & { extractStatements?: (prompts: StatementPrompt[]) => Promise<StatementExtraction> };
      const onSilent = tier.extractStatements ? async (prompts: StatementPrompt[]) => (await tier.extractStatements!(prompts.slice(0, 20))).statements : undefined;
      const lessons = await learnFromEndedTurns(backend, workspaceId, cacheDir).catch(() => 0);
      const learned = lessons + (await learnFromUserWords(backend, workspaceId, cacheDir, new Date().toISOString(), onSilent ? { onSilent } : {}).catch(() => 0));
      if (learned > 0) await renderLocalClaudeRules(backend, workspaceId, localRootPath);
    }
    const channel = await resolveWorkspaceProtocolChannel({ workspaceRoot: localRootPath, enabled: HOOK_CAPABLE_CLIENTS }).catch(() => ({
      protocol: undefined,
    }));
    // The team block travels with the protocol: in signature mode nothing on disk carries it any
    // more.
    const team = channel.protocol !== undefined ? renderTeamContextBlock(undefined) : null;
    const { personal, intelligenceProfiles } = await hookIndexPersonEntries({
      ctx,
      person: mcpPersonalAccount(),
      workspaceId,
      localRootPath,
    });
    const result = await syncHookIndex({
      backend,
      workspaceId,
      workspaceRoot: localRootPath,
      env: process.env,
      protocol: channel.protocol,
      teamContext: team ?? undefined,
      ...personal,
      intelligenceProfiles,
      // A Project account's semantic endpoint; local mode passes nothing and keeps its BYO-key path.
      cloud: projectSemanticEndpoint(ctx),
      // The edition that served this call. No local atom store is offered: a Cloud index never reads
      // one, and a Local store compiles its own atoms into its payload.
      mode: isProjectContext(ctx) ? "cloud" : "local",
    });
    // syncHookIndex REPORTS failure, it does not throw it; stderr is safe (stdout carries MCP).
    if (!result.ok) {
      console.error(`[pathrule] hook-index sync reported failure for workspace ${workspaceId}:`, result.error ?? "no payload returned");
    }
  } catch (error: unknown) {
    console.error(`[pathrule] hook-index sync threw for workspace ${workspaceId}:`, errorMessage(error, "unknown error"));
  }
}

/**
 * Claude's path-scoped rules are instructions only while they hold what was decided: a change is in
 * force from the next prompt, as an edit to a CLAUDE.md is. Only a folder the workspace already has is
 * rendered again, so nothing adds an agent's files to the project.
 */
export async function renderLocalClaudeRules(backend: KnowledgeBackend, workspaceId: string, root: string): Promise<void> {
  if (!existsSync(join(root, ".claude", "rules", "pathrule"))) return;
  const outcome = await rerenderMultiClientLocal({
    backend,
    workspaceId,
    workspaceName: await workspaceName(backend, workspaceId),
    workspaceRoot: root,
    userId: resolveLocalPrincipal(process.env),
    runtimeOwner: "mcp",
    // A version, or the ledger records nothing and eject cannot find what this render added.
    runtimeVersion: mcpServerVersion(),
    activeEngines: ["claude-code"],
    resolveChannel: true,
  });
  if (!outcome.ok) console.error(`[pathrule] rule files not rendered for workspace ${workspaceId}:`, outcome.error ?? "unknown error");
}

/**
 * The name the rules files carry, from the backend that served the call: a Local store names its
 * workspace, and a Cloud workspace is named as it was attached on this machine. Never read by opening
 * a store under the id, which for a Cloud workspace would create one holding nothing of its own.
 */
async function workspaceName(backend: KnowledgeBackend, workspaceId: string): Promise<string> {
  const named = backend as KnowledgeBackend & { getWorkspaceName?: (id: string) => string | null | Promise<string | null> };
  const own = typeof named.getWorkspaceName === "function" ? await named.getWorkspaceName(workspaceId) : null;
  return own ?? readCloudFolderBindings(process.env).find((b) => b.workspaceId === workspaceId)?.name ?? workspaceId;
}

/** The root an existing hook index was written for, or null when this workspace has no index. */
export async function indexedWorkspaceRoot(workspaceId: string): Promise<string | null> {
  try {
    const index = JSON.parse(await readFile(join(localRuntimePaths(process.env).home, "cache", workspaceId, "hook-index.json"), "utf8")) as {
      workspace_id?: string;
      workspace_root?: string;
    };
    return index.workspace_id === workspaceId && typeof index.workspace_root === "string" && index.workspace_root ? index.workspace_root : null;
  } catch {
    return null;
  }
}
