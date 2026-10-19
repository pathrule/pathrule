// SPDX-License-Identifier: Apache-2.0
// Small helpers used by every tool wrapper — context resolution and the post-write
// companion re-render. Wrappers import these so the per-tool files stay focused on
// their specific args + cache decisions.

import type { ToolContext } from "@pathrule/core/tools/types.js";
import { isProjectContext, resolveOpenContext } from "../local-runtime.js";
import { forgetHookIndexSync } from "../lib/hook-index-sync.js";
import { indexedWorkspaceRoot, renderLocalClaudeRules, syncWorkspaceHookIndex } from "../lib/workspace-hook-index.js";

/**
 * Resolves the ToolContext for this call: the local store, or the Project account's store for a
 * workspace an account maps (`resolveOpenContext`).
 *
 * `clientId` is populated from the MCP transport handshake so downstream tools
 * can stamp telemetry without each LLM having to set `ai_client` by hand. null
 * when the handshake hasn't yet produced a recognisable name; callers default
 * to `claude-code` to preserve legacy behaviour.
 */
export async function resolveContext(workspaceId: string | null = null): Promise<ToolContext> {
  return resolveOpenContext(workspaceId);
}

/**
 * The step that binds a folder to a workspace, as the agent relays it to the
 * person: under an account the folder joins one of their workspaces, on the local
 * store it becomes a local workspace. It names the CLI and the VS Code command,
 * the surfaces every composition of this server has.
 */
export function bindFolderStep(account: boolean = false): string {
  return account
    ? "Run `pathrule attach` in this folder to bind it to one of your workspaces, or `pathrule init` to create one (in VS Code: Pathrule: Connect Existing Workspace)."
    : "Run `pathrule init --local` in this folder to create a local workspace (in VS Code: Pathrule: Set Up Workspace).";
}

/**
 * Resolve which workspace a write targets, from `workspace_id` OR `cwd`.
 *
 * `workspace_id` used to be required, and that is what a fresh workspace fails at:
 * the hook's cache directory for it does not exist yet, so UserPromptSubmit emits
 * `{}` with no session metadata, the agent has no id to pass, and it starts
 * guessing — a node id, a tree walk, anything uuid-shaped. Every one of those
 * guesses is a write into the wrong place or an error the agent cannot act on.
 *
 * So the id is now one of two ways in, and `cwd` is the other — the same contract
 * pathrule_log_activity has had all along. When BOTH arrive and disagree, the
 * caller's explicit id wins (a deliberate cross-workspace write is legitimate);
 * the disagreement is only used to make the error message name the right id when
 * the given one turns out not to be a workspace at all.
 */
export async function resolveWorkspaceTarget(args: {
  workspace_id?: string | null;
  cwd?: string | null;
}): Promise<
  | { ok: true; ctx: ToolContext; workspaceId: string }
  | { ok: false; error: { code: "invalid_args" | "not_found"; message: string } }
> {
  const given = args.workspace_id?.trim() || null;
  // Resolve the context WITHOUT the id first: passing an id that is not a workspace
  // makes resolveContext assert a subscription for a row that does not exist, which
  // reports as a billing problem instead of the addressing mistake it is.
  const ctx = await resolveContext(null);
  const cwd = args.cwd?.trim() || process.cwd();
  const match = (await ctx.backend?.resolveWorkspaceFromCwd(cwd).catch(() => null)) ?? null;

  if (!given) {
    if (!match) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message:
            `Could not resolve a workspace. cwd="${cwd}" does not sit inside any folder bound ` +
            `to one of your workspaces. Either pass workspace_id (pathrule_get_context returns ` +
            `it), pass an absolute cwd inside a bound folder, or bind this folder first. ` +
            bindFolderStep(),
        },
      };
    }
    return {
      ok: true,
      ctx: await resolveContext(match.workspaceId),
      workspaceId: match.workspaceId,
    };
  }

  return { ok: true, ctx: await resolveContext(given), workspaceId: given };
}

/**
 * After every successful write tool, bring a local workspace's Claude rules and hook index up to
 * date. Never throws — a rerender hiccup shouldn't undo a successful write. A Project account's
 * workspace is rendered by its own sync.
 */
export async function rerenderClaudeMdAfterWrite(ctx: ToolContext, workspaceId: string): Promise<void> {
  if (!ctx.backend) return; // backend is injected by resolveContext; nothing to render without it
  // The hook index no longer matches the store: the next get_context rewrites it.
  forgetHookIndexSync(workspaceId);
  if (!isProjectContext(ctx)) {
    // A local workspace rewrites its index now, from its own SQLite: the edit the agent makes next
    // is the one a just-written memory or atom is for, and nothing else would refresh it in time.
    const root = await indexedWorkspaceRoot(workspaceId);
    // Claude's path-scoped rules are instructions only while they hold what was decided: a write the
    // session makes is in force from the next prompt, as an edit to a CLAUDE.md is. Only a folder the
    // workspace already has is rendered again, so a write never adds an agent's files to the project.
    if (root) await renderLocalClaudeRules(ctx.backend, workspaceId, root);
    if (root) await syncWorkspaceHookIndex({ ctx, workspaceId, localRootPath: root });
  }
}
