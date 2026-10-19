// SPDX-License-Identifier: Apache-2.0
//
// Shared tool-layer contracts used by the MCP server and any future in-app
// AI caller (e.g., a resurrected Edge-Function suggestion service).
//
// Handlers are pure functions: `(ctx, args) => ToolResult`. They read knowledge
// through the injected `backend` — no environment assumptions, no runtime
// fetches beyond the backend itself. The context is deliberately cloud-free so it
// stays in the open local closure; Pathrule Cloud serves its workspaces through a
// backend of its own behind the same contract.

import type { KnowledgeBackend } from "../index.js";

import type { AgentTargetId } from "../skills/agent-targets.js";

/**
 * Every tool runs in this context. Knowledge is read through the injected
 * `backend`.
 */
export interface ToolContext {
  /**
   * The injected KnowledgeBackend — the single data source for tool handlers.
   * Optional only at the type level so composition sites can attach it as they
   * build the context. LocalBackend supplies SQLite; Pathrule Cloud's Project
   * backend reaches the Cloud.
   */
  backend?: KnowledgeBackend;
  /** The caller's user id. Stamped into writes (last_edited_by). */
  userId: string;
  /**
   * Default workspace id for the call chain. Some tools accept an explicit
   * `workspace_id` arg and override this; others (`get_context`) use it as the
   * resolved workspace. null when not yet resolved (e.g., before cwd matching).
   */
  workspaceId: string | null;
  /**
   * M19f — Resolved AI client identity for the call chain. Populated by the
   * MCP server from the transport handshake (`client_info.name`) or the
   * `MCP_CLIENT_NAME` env var. null when running outside an MCP transport
   * (e.g. a direct tool call from the CLI or a test). Tools that
   * stamp telemetry (`activity_logs.ai_client`, `suggestion_refreshes.claimed_by`)
   * default to this value when the caller didn't override.
   */
  clientId?: AgentTargetId | null;
}

export type ToolErrorCode =
  | "offline"
  | "auth_required"
  | "not_found"
  | "permission_denied"
  | "subscription_required"
  | "conflict"
  | "duplicate"
  | "invalid_args"
  | "upstream_error";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  /** Optional machine-readable detail — e.g. current version id on conflict. */
  detail?: unknown;
}

/**
 * Non-fatal advisory attached to a successful tool result. Examples:
 *   • `similar_titles` — fuzzy near-duplicates surfaced by the dedup RPC after
 *     a memory/rule write succeeded. The caller decides whether to surface
 *     them to the user (UI banner) or to the agent (response field).
 */
export interface ToolWarning {
  code: "similar_titles";
  message?: string;
  detail?: unknown;
}

export type ToolResult<T> =
  | { ok: true; data: T; warnings?: ToolWarning[] }
  | { ok: false; error: ToolError };

export function okResult<T>(data: T, warnings?: ToolWarning[]): ToolResult<T> {
  return warnings && warnings.length > 0 ? { ok: true, data, warnings } : { ok: true, data };
}

export function errResult<T = never>(
  code: ToolErrorCode,
  message: string,
  detail?: unknown,
): ToolResult<T> {
  return { ok: false, error: { code, message, detail } };
}

/**
 * What a write into a read-only demo workspace answers. The backend decides whether a workspace
 * is a demo (`isDemoWorkspace`); the handlers only word the refusal.
 */
export const DEMO_READONLY_MESSAGE =
  "This workspace is a read-only demo and cannot be modified. Create or open a real workspace to make changes.";

/**
 * Postgres reports a unique-index violation as code 23505. Skills race-safe
 * gate is `skills_workspace_slug_unique`; map that specific collision to a
 * caller-friendly duplicate error so concurrent inserts don't leak a raw PG
 * error message back through the MCP surface.
 */
export function isSkillSlugUniqueViolation(err: { code?: string; message?: string }): boolean {
  if (err.code !== "23505") return false;
  return Boolean(err.message?.includes("skills_workspace_slug_unique"));
}

/**
 * Map a store's error into one of the tool error codes. The stores report PostgREST-shaped codes
 * (the SQLite backend keeps them: `PGRST116` for no row, `42501` for permission denied), so callers
 * never pattern-match on messages.
 */
export function mapStoreError(err: { code?: string; message: string }): ToolError {
  if (err.code === "PGRST116") {
    return { code: "not_found", message: err.message };
  }
  if (err.code === "42501" /* Postgres permission denied */) {
    return { code: "permission_denied", message: err.message };
  }
  return { code: "upstream_error", message: err.message };
}

/**
 * Maps a string error code returned by a SECURITY DEFINER RPC body
 * (`delete_*_rpc`, `restore_*_rpc`) to the canonical ToolError shape.
 * `conflict` is handled by the caller separately because it carries
 * `current_version_id` detail.
 */
export function mapRpcError(rpcError: string): ToolError {
  switch (rpcError) {
    case "not_authenticated":
      return { code: "auth_required", message: "Sign in required." };
    case "forbidden":
      return { code: "permission_denied", message: "You don't have permission for this action." };
    case "not_found":
      return { code: "not_found", message: "Item not found." };
    case "already_deleted":
      return { code: "invalid_args", message: "Item is already deleted." };
    case "not_deleted":
      return { code: "invalid_args", message: "Item is not deleted — nothing to restore." };
    default:
      return { code: "upstream_error", message: `RPC error: ${rpcError}` };
  }
}
