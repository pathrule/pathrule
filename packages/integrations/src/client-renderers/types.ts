// SPDX-License-Identifier: Apache-2.0
// Common contract for the per-client cloud-driven renderers. Each renderer
// is pure: same `MultiClientInput` produces the same bytes every time. The
// caller (./pipeline.ts, ./disk-writer.ts) does the disk I/O.

import type { CompiledKnowledgeNode } from "@pathrule/core";
import type { WorkspaceOverviewNode } from "@pathrule/core/tools/tree.js";
import type { TeamContextBlock } from "./team-context-block.js";
import type { CompanionPayloadMode } from "../context-delivery-policy.js";

// ─────────────────────────────────────────────────────────────────────────────
// Promoted Rules Bundle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single entry in the promoted rules bundle — one rule with
 * injection_strategy='claude_md_only', rendered into every per-client
 * instructions file once per session.
 */
export interface PromotedRuleBundleEntry {
  rule_id: string;
  name: string;
  display_summary: string;
  priority: "critical" | "high" | "medium" | "low";
  scope_type: "project" | "folder" | "file_type";
  promoted_at: string | null;
}

/**
 * The full bundle returned by pathrule_get_promoted_rules_bundle, plus
 * a sha256-based signature used as a verification handshake between the
 * server and the agent. The signature is embedded in the instructions file
 * as an HTML comment and returned by pathrule_get_context so the agent
 * can detect stale files.
 */
export interface PromotedRulesBundle {
  workspace_id: string;
  entries: PromotedRuleBundleEntry[];
  /** sha256 of the canonicalized entry list (rule_id + display_summary, sorted). */
  signature: string;
  rendered_at: string;
}

/**
 * Everything the per-client renderers actually read.
 *
 * `rootContext`, `recentActivities` and `hotPaths` used to live here. No
 * renderer ever read them (`renderProtocolBody` even marks its parameter
 * `_input`), yet both gather paths queried them on every rerender: a
 * `get_context` call plus an activities read, in the local AND the cloud
 * edition. They were removed rather than left optional, so nobody has to guess
 * again whether they matter. Recent activities and hot paths remain live inputs
 * for the ROUTER and the briefing, which are different contracts.
 */
export interface MultiClientInput {
  workspaceName: string;
  overview: WorkspaceOverviewNode[];
  /**
   * How much Pathrule writes into this client's instruction file. Set PER CLIENT
   * by the orchestrator (same mechanism as the slim-knowledge swap), because the
   * answer is a client capability: a client whose hook delivers the protocol
   * gets `signature`, a client that cannot run one keeps `slim` so it never
   * loses the protocol. Absent ⇒ `slim`, i.e. today's output.
   */
  companionMode?: CompanionPayloadMode;
  /**
   * The client's native plugin delivers Pathrule's hook, so the renderer writes no hook config of
   * its own: a plugin hook and a config entry would both run.
   */
  hooksOnPlugin?: boolean;
  /**
   * Claude Code's path-scoped rules folder (`.claude/rules/pathrule/`). Absent ⇒ written. False
   * (`PATHRULE_RULES_FILES=off`) writes none and sweeps an earlier one; the hook then carries the
   * project knowledge and the keep-current ask at session start.
   */
  rulesFiles?: boolean;
  /** Promoted rules bundle; undefined when feature flag is off or no promoted rules exist. */
  promotedRules?: PromotedRulesBundle;
  /**
   * Native Knowledge Compilation: per-directory knowledge sections (full
   * bodies, budgeted) from KnowledgeBackend.buildKnowledgePayload. When
   * present, renderers emit path-scoped knowledge files in each client's
   * native instruction format; when absent, companions stay protocol-only.
   */
  knowledge?: CompiledKnowledgeNode[];
  /**
   * The SLIM (router) projection of the same knowledge: memory/skill as a
   * title index, rules full. Clients with a prompt-time body channel (Claude)
   * render from this; the hook then delivers the prompt-relevant bodies. Absent
   * ⇒ slim clients fall back to `knowledge` (full).
   */
  knowledgeSlim?: CompiledKnowledgeNode[];
  /**
   * The BINDING projection: rules and the memories that read as rules, per directory. Claude in
   * signature mode renders it as path-scoped `.claude/rules/pathrule/*.md`, loaded as instructions
   * when work enters the area. Absent: nothing is written.
   */
  knowledgeBinding?: CompiledKnowledgeNode[];
  /**
   * The single personalization block (who the user is, who the reference is for
   * which area). Unlike the removed `rootContext` / `recentActivities`, a
   * renderer DOES read this: it is appended to the turn-zero file, last, so the
   * knowledge prefix above it stays byte-identical for the prompt cache.
   * Undefined in the local edition, which has no organization.
   */
  teamContext?: TeamContextBlock;
}

export interface RenderedFile {
  /** Workspace-root-relative path. */
  path: string;
  /** Full file body, ending in a single trailing newline. */
  body: string;
}

export type ClientRenderer = (input: MultiClientInput) => RenderedFile[];

/**
 * Files this renderer "owns" — the orchestrator deletes any of these that
 * the renderer no longer emits, so a tool that's enabled then disabled then
 * re-enabled lands back in a clean state. Paths returned here MUST be a
 * superset of every path the renderer's `render` function ever emits.
 */
export type ClientOwnedPaths = (input: MultiClientInput) => string[];

export interface ClientRendererSpec {
  /** Stable agent target id. */
  id: string;
  render: ClientRenderer;
  ownedPaths: ClientOwnedPaths;
}
