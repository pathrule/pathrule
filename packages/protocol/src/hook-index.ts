// SPDX-License-Identifier: Apache-2.0
// Hook Supervisor type definitions.
//
// Includes RuleInjectionStrategy, CandidateRule, SelectInjectedRulesInput/Output.
//
// Two sides of the hook protocol:
//   1. HookEventInput  — JSON that Claude Code pipes into the hook script's stdin
//   2. HookEventOutput — JSON the hook script writes to stdout; controls Claude
//
// And the cache shape:
//   3. HookIndex — the JSON file pre-computed at
//      ~/.pathrule/cache/<workspace_id>/hook-index.json that the shell script
//      reads on the hot path (no network, no database).

// ─────────────────────────────────────────────────────────────────────────────
// 1. Input — what Claude Code sends to the hook
// ─────────────────────────────────────────────────────────────────────────────

export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  // Claude Code fires this INSTEAD of PostToolUse when a tool fails. Measured
  // 2026-08-22: a Read of a missing file produces no PostToolUse at all, only a
  // PostToolUseFailure carrying {error: string, is_interrupt: boolean, duration_ms}
  // at the TOP level and no tool_response. Without this matcher registered the hook
  // never observes a single tool failure, which is why tool_failure_codes stayed
  // empty for the whole life of the friction pipe.
  | "PostToolUseFailure"
  | "UserPromptSubmit"
  | "SessionStart"
  | "SessionEnd"
  | "Stop"
  | "SubagentStop"
  | "Notification"
  | "PreCompact"
  | "PostCompact";

/** Fields common to every hook event. */
export interface HookEventCommon {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name: HookEventName;
  /** Present when a Stop hook fires recursively — short-circuit to avoid loops. */
  stop_hook_active?: boolean;
}

/** PreToolUse / PostToolUse events carry tool call details. */
export interface HookEventToolCall extends HookEventCommon {
  hook_event_name: "PreToolUse" | "PostToolUse";
  tool_name: string;
  /** Tool-specific args. For Read/Edit/Write: `file_path`. For Bash: `command`. */
  tool_input: Record<string, unknown>;
  /** PostToolUse only — result of tool execution. */
  tool_response?: {
    is_error?: boolean;
    content?: unknown;
    [k: string]: unknown;
  };
}

/** UserPromptSubmit carries the user's raw prompt text. */
export interface HookEventUserPrompt extends HookEventCommon {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

export type HookEventInput = HookEventToolCall | HookEventUserPrompt | HookEventCommon;

// ─────────────────────────────────────────────────────────────────────────────
// 2. Output — what the hook writes to stdout; controls Claude
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Output schema accepted by Claude Code on hook stdout (exit 0 required).
 *
 * Design rule for Pathrule: ALWAYS exit 0, never exit 2. Encode block
 * decisions inside the JSON (`decision: "deny"`) so we only have one output
 * path to reason about.
 */
export interface HookEventOutput {
  /** If false, Claude aborts the current turn. Rarely needed. */
  continue?: boolean;
  /** Block / allow / ask the current operation. "deny" blocks PreToolUse. */
  decision?: "block" | "allow" | "ask" | "deny" | "defer";
  /** Human-readable justification shown to Claude when blocking. */
  reason?: string;
  /** One-line message printed to user UI (not to Claude). */
  systemMessage?: string;
  /** Suppress stdout from being treated as added context. */
  suppressOutput?: boolean;
  hookSpecificOutput?: {
    hookEventName?: HookEventName;
    /**
     * Text injected into Claude's context. Up to ~10,000 chars — Pathrule
     * keeps injections well under 1,000 chars to avoid polluting context.
     */
    additionalContext?: string;
    permissionDecision?: "allow" | "deny" | "ask" | "defer";
    permissionDecisionReason?: string;
    /** For PreToolUse — rewrite the tool args before execution. */
    updatedInput?: Record<string, unknown>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical hook config (shared by Claude + Cursor adapters)
// ─────────────────────────────────────────────────────────────────────────────

export interface HookCommand {
  type?: "command";
  command: string;
  timeout?: number;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

export interface HookConfig {
  hooks: Partial<Record<HookEventName, HookMatcher[]>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Cache — hook-index.json
// ─────────────────────────────────────────────────────────────────────────────

export interface MemoryStub {
  id: string;
  title: string;
  /** First ~100 chars of memory.content — enough for Claude to decide whether to `read_memory` for full body. */
  preview: string;
  node_path: string;
  /**
   * Filename tokens extracted from the title at build time (e.g. ["loyalty.json"]).
   * Absent when the title contains no filename pattern.
   */
  filename_tokens?: string[];
  /**
   * Full memory body, populated ONLY for filename-indexed stubs whose content
   * fits the per-body cap (3KB). Absent otherwise (hook nudges Claude to call
   * pathrule_read_memory for the canonical version).
   */
  body?: string;
  /** sha256(content) prefix — change-detection key for delta injection. */
  content_hash?: string;
  /** Internal scoring tags derived at index build time. Not shown in the app UI. */
  semantic_tags?: string[];
}

export interface HookSemanticCandidate {
  id: string;
  title: string;
  node_path: string;
  confidence: "high" | "medium";
  reason?: string;
}

export interface RuleStub {
  id: string;
  name: string;
  scope_type: "folder" | "file_type" | "project";
  priority: "high" | "medium" | "low";
  /** When 'strict', hook can emit `decision: "deny"` on violation. */
  enforcement?: "strict" | "advisory";
  preview: string;
  node_path?: string;
  /**
   * Compiled from the rule's CONSTRAINT atoms (`rules.constraints`) at index build
   * time, and only for an atom that is both `authority: human` and `status: active`.
   * The hook tests this regex against tool_input (new_string / content / command)
   * and denies on match. Only populated when `enforcement === 'strict'`.
   *
   * `message` is the author's remedy, carried so a deny can say what to do instead.
   * Optional because the legacy `BLOCK_PATTERN:` marker path produced no message; the
   * hook reads only `source` and `flags`, so adding it changes no runtime behaviour.
   */
  block_pattern?: { source: string; flags: string; message?: string };
  /**
   * Compiled from a CONSTRAINT atom that narrows by PATH rather than by content. The hook
   * denies an Edit/Write whose file path falls inside `scope_path` (exact or descendant)
   * and, when given, carries one of `file_extensions`.
   *
   * Present alongside `block_pattern` it is an AND; present alone the constraint has no
   * content pattern at all, which is the right target for a rule about where a file may
   * live rather than what it may contain.
   */
  block_path?: { scope_path: string; file_extensions?: string[]; message?: string };
  /**
   * Compiled from the rule's CHECK atoms, and only for an atom that is both
   * `authority: human` and `status: active`. The hook marks the check pending when an
   * Edit/Write lands under `scope_path`, clears it when the evidence channel reports a
   * PASS for `fingerprint`, and blocks Stop while it is pending.
   *
   * `fingerprint` is the canonical form of `command` from
   * `verification-evidence.classifyVerificationCommand`, computed at authoring time and
   * carried as data because the cloud index builder is SQL and cannot run the classifier.
   */
  required_check?: { scope_path: string; command: string; fingerprint: string; message: string };
  /**
   * Explicit API / symbol markers the rule actually talks about.
   * Auto-extracted from markdown inline-code (`` `foo.bar` ``) at index build
   * time, capped at 8 per rule. If populated, the hook requires at least one
   * literal substring hit against the tool input before injecting — priority
   * independent. If empty/missing, falls back to keyword-token relevance.
   */
  symbols?: string[];
  /** sha256(content) prefix — change-detection key for delta injection. */
  content_hash?: string;
  /** Internal scoring tags derived at index build time. Not shown in the app UI. */
  semantic_tags?: string[];
}

// Path-scoped skill stub (mirrors MemoryStub) so the hook can find a
// routed path's skills and rank them against the prompt for top-k body delivery.
export interface SkillStub {
  id: string;
  name: string;
  node_path: string;
  preview: string;
  content_hash?: string;
}

export interface SkillInvocationStub {
  id: string;
  name: string;
  source: "manual" | "template" | "github_ref";
  github_url: string | null;
  node_path: string | null;
  preview: string;
  body?: string;
  /** sha256(content) prefix — change-detection key for delta injection. */
  content_hash?: string;
  /** Internal scoring tags derived from skill tags + content. Not shown in companion files. */
  semantic_tags?: string[];
}

export interface FailPatternStub {
  /** SHA-ish hash of the error signature — stable key for a recurring failure. */
  signature: string;
  /** Glob of paths where this failure repeats (e.g. "/apps/mobile/**\/*.tsx"). */
  path_glob: string;
  count: number;
  last_seen: string;
  /** Short text to surface to Claude in additionalContext ("Last 3 Edits here failed with X"). */
  warning_text: string;
}

/**
 * One failing tool call, as the hook appends it to `cache/<workspace_id>/fail-patterns.jsonl`. A local
 * scan reads the recent ones; which of them recur enough to become a `FailPatternStub` is the engine's
 * decision.
 */
export interface FailureEvent {
  ts: string;
  tool: string | null;
  /** Workspace-relative, or null when the call named no file. */
  file_path: string | null;
  /** A hash of the tool and the error's first 200 characters. */
  error_signature: string;
  /** The error's first 200 characters. */
  error_preview: string;
}

export interface WorkEpisodeStub {
  id: string;
  title: string;
  summary: string;
  subjects: string[];
  paths: string[];
  activity_count: number;
  started_at: string;
  ended_at: string;
  confidence: "low" | "medium" | "high";
}

/**
 * A REMEDY advisory as it sits in the hook index: a pre-rendered neutral markdown line plus the
 * atom fingerprint `ref`. The line is compiled once at index-build time by the engine-neutral Agent
 * IR renderer; the hook only selects by path, budgets, injects, and records `ref` to the local
 * delivery ledger. No knowledge content beyond the rendered line is stored, and `ref` is an opaque
 * hash, so nothing here is agent-identifying or cloud-bound.
 */
export interface AdvisoryStub {
  ref: string;
  line: string;
  /**
   * Id of the memory this line was compiled from, when the completeness gate cleared that memory's
   * compiled form. Lines sharing a group are delivered together or not at all. Absent for lines with
   * no source memory to judge against (a rule's atoms, or a memory no longer active).
   */
  group?: string;
}

/**
 * The index schema versions the hook reads. The hook carries a plain-JS twin
 * (`SUPPORTED_INDEX_SCHEMAS` in pathrule-hook.js), pinned by a contract test, and skips any other
 * version rather than half-reading it.
 */
export const SUPPORTED_HOOK_INDEX_SCHEMAS: readonly number[] = [1, 2];

export interface HookIndex {
  /** Schema version — bump when breaking changes. Shell script checks this. */
  schema_version: 1 | 2;
  workspace_id: string;
  workspace_root: string;
  generated_at: string;

  /** Map: node_path → memories tagged at that path. Lookup walks parent chain. */
  path_memories: Record<string, MemoryStub[]>;
  /** Path-scoped skills (mirrors path_memories) for relevance top-k. */
  path_skills?: Record<string, SkillStub[]>;
  /** Map: node_path → rules scoped to that path. */
  path_rules: Record<string, RuleStub[]>;

  /** Rules with scope_type='project' — relevant for every tool call. */
  project_rules: RuleStub[];

  /**
   * Map: scope node_path → approved REMEDY advisories learned under that path. The hook walks the
   * parent chain of the tool's path (same as path_rules) to collect applicable advisories, so a
   * remedy learned under /apps/web reaches an edit in /apps/web but never /apps/api. Each stub is a
   * pre-rendered advisory line plus the atom `ref` (fingerprint) for the local delivery ledger.
   * Advisories are ADVISORY: subordinate to rules and constraints, injected in their own labelled
   * section. Absent when the workspace has no deliverable remedies.
   */
  path_advisories?: Record<string, AdvisoryStub[]>;
  /** Approved remedies with workspace-global scope (source memory unplaced); apply to every path. */
  project_advisories?: AdvisoryStub[];

  /** Top subjects from activity logs (last 30 days, max 100) — used by Bloom-style pre-gate. */
  recent_subjects: string[];

  /** Short human-readable summary of last 30min activity. Null if no activity. */
  session_digest: string | null;

  /** Refresh queue counts are prompt-gated by the hook; not automatically injected. */
  pending_refresh_count?: number;
  in_progress_refresh_count?: number;

  /**
   * Native Knowledge Compilation: true when this workspace's knowledge has
   * been compiled into per-directory native instruction files (CLAUDE.md /
   * AGENTS.md / Cursor / Copilot). The hook then stops injecting memory
   * content on PreToolUse (the agent already sees it at turn zero) and keeps
   * only guard (strict deny) + live-delta duties.
   */
  knowledge_compiled?: boolean;
  /** Memory ids whose BODY is in the FULL compiled file — full clients skip these in delta injection. */
  compiled_memory_ids?: string[];

  /**
   * The agent protocol, delivered by the hook ONCE per session instead of being
   * compiled into the companion files.
   *
   * Present only for a workspace whose companion files are in signature mode.
   * Absent means the protocol still lives on disk and the hook says nothing, so
   * the field is the switch as well as the payload — one source of truth, no
   * env-var coordination between the renderer process and the hook process.
   *
   * The hook prepends it AFTER its own context cap, because the protocol is
   * framing rather than a ranked item: folding it into the budget would push
   * knowledge out of the first prompt of every session.
   */
  protocol?: string;

  /**
   * The same protocol for a session with no Pathrule MCP server: it names no `pathrule_*` tool, so
   * an agent is never told to call a tool it does not have. The hook delivers it instead of
   * `protocol` when its launcher says the integration ships no MCP server. Written beside
   * `protocol`, never alone.
   */
  protocol_without_mcp?: string;

  /**
   * One sentence shown with every prompt of a session that has the Pathrule MCP server: if the
   * message states or changes a decision, preference or constraint, save it before finishing.
   * Measured 2026-10-15: a protocol line seen once at session start was not followed ten turns later.
   */
  capture_reminder?: string;

  /**
   * The team context block, delivered on the same channel as the protocol and
   * for the same reason: in signature mode the compiled files that used to carry
   * it are not written at all.
   *
   * It used to ride the compiled file because "the hook channel is paid PER
   * TURN" — true of the prompt channel, and the reason this block was kept out
   * of it. SessionStart is not that channel: Claude Code merges its
   * additionalContext into the SYSTEM PROMPT once for the session, so a constant
   * block costs the same one-time price the compiled file charged, and the
   * prompt channel stays for what actually varies with the prompt.
   */
  team_context?: string;

  /**
   * The workspace-wide memories (attached at the root), rendered once for the session's SessionStart
   * framing: bodies while they fit a small budget, then titles with ids to pull. Knowledge that applies
   * to every task cannot wait for a prompt to share its words, which is the only way the prompt channel
   * finds it; a CLAUDE.md user has the same knowledge in context from the first turn.
   */
  project_knowledge?: string;

  /**
   * Memories compiled into Claude Code's path-scoped rules (`.claude/rules/pathrule/`), which Claude
   * loads as instructions when work enters their area, keyed by id to the fingerprint of their block.
   * The hook does not send one again only while the folder's manifest holds that same fingerprint: a
   * memory written or changed after the last render is an ordinary candidate until the files catch up.
   */
  instruction_memory_hashes?: Record<string, string>;

  /**
   * Where things are defined in the local checkout: `[name, "/file:line", words]` per symbol and an
   * IDF weight per word. Names and lines only, never code. The hook routes a prompt to the symbols its
   * words meet, so the agent opens the right file at the right line instead of searching for it.
   */
  code_map?: { symbols: Array<[string, string, string[]]>; idf: Record<string, number>; forms?: Record<string, string> };

  /**
   * Slim (router) projection ids. For clients with a prompt-time body
   * channel (Claude), the per-dir file carries memory/skill TITLES, not bodies;
   * the hook delivers the prompt-relevant bodies. `indexed_memory_ids` are the
   * title-only memories (their bodies are eligible for hook top-k injection),
   * and `compiled_rule_ids` are rules whose FULL body is already in that slim
   * file (so the hook must NOT re-inject them — rules are floored, turn-zero).
   * Empty/absent when no slim render exists.
   */
  indexed_memory_ids?: string[];
  compiled_rule_ids?: string[];

  /**
   * Navigation Engine: most-touched paths from recent activity (top ~8),
   * derived at index build time. A routing signal: "the team works here".
   */
  hot_paths?: Array<{ path: string; count: number }>;

  /**
   * Pathrule Cloud's semantic endpoint for the hook's prompt-time body ranking.
   *
   * The hook ranks memory bodies against the prompt, and to do that it needs a query vector it
   * cannot produce: it never touches the network, and embed-query.cjs requires the caller's OWN
   * embedding key (the BYO path, which is the local edition's deal).
   *
   * Present ONLY when a Cloud workspace's index was written: Cloud ranks over its own semantic
   * index, and the local edition writes no block here and keeps its keyword-overlap path. The
   * bearer token is NOT stored here: Cloud's ranking helper reads it from
   * ~/.pathrule/native-session.json at call time and sends it only to that session's own origin,
   * so a stale index cannot carry a stale session.
   */
  cloud_semantic?: { url: string; kind: "native" };

  /**
   * The edition this index serves its folder from: `cloud` or `local` (core workspace/folder-mode.ts).
   * The hook delivers an index only when its edition is the folder's; an index written before this
   * field reads as `cloud` when it carries `cloud_semantic`, else `local`.
   */
  mode?: "cloud" | "local";

  /**
   * The vector space of the vectors in `embeddings.json` beside this index:
   * `<provider>/<model>@<dims>#v<version>` (core's embeddingSpaceKey). embed-query.cjs
   * reports the space of the prompt vector it returns, and the hook ranks by cosine only
   * when the two are equal; otherwise it ranks by keywords (`fallback_space_mismatch`).
   * Equal dimensions are not enough: two models' vectors of one width are unrelated.
   * Absent when the writer's backend states no space.
   */
  embedding_space?: string;

  /** Populated when failures recur. */
  fail_patterns?: FailPatternStub[];

  /** Compact, local-only prior work candidates for `++history`. */
  work_episode_index?: WorkEpisodeStub[];

  /**
   * Reverse lookup from filename token (e.g. "loyalty.json") to
   * memory_ids whose titles mention that filename. Populated at build time
   * via the index builder's filename detection regex. Hook uses this at
   * UserPromptSubmit time to decide whether to inject a full body inline.
   */
  filename_index?: Record<string, string[]>;

  /**
   * Explicit ::skill-name invocation index. Keys are normalized skill names.
   * Values contain every matching workspace skill so duplicates fail closed.
   */
  skill_invocation_index?: Record<string, SkillInvocationStub[]>;

  /**
   * SHA-256 (16-char truncated) of the current promoted_rules bundle
   * rendered into the per-client instruction files. Attached to every hook
   * payload so the agent can verify CLAUDE.md freshness.
   * NULL when no rules are promoted.
   */
  promoted_rules_signature?: string | null;

  /**
   * Feature flags from the workspace config. The hook script reads
   * `experiments.rule_promotion_v1` to gate injection_strategy behavior.
   */
  experiments?: Record<string, boolean>;
  /**
   * Compiled USER preference entries: how the PERSON works, decided by the user-intelligence layer and
   * carried here so the hook can deliver it through the same channel as everything else. Absent when
   * the person has no deliverable preferences, which keeps the index unchanged for everyone else.
   */
  user_preferences?: Array<{ id: string; line: string; terms: string[]; always: boolean; min?: number; relaxes?: boolean; path?: string }>;
  /**
   * Folded risk terms (the risk gate's domain vocabulary). Present only alongside a preference marked `relaxes`, which
   * the hook drops for any prompt that hits one of these: a learned habit never lowers the bar on auth,
   * payments, migrations or crypto. Carried in the index so the hook and the host apply ONE list.
   */
  user_preference_risk_terms?: string[];
  /**
   * Oversight ("verify these changes yourself") and expertise-lease entries for this workspace, rendered
   * upstream (`turn-guidance.ts`). The hook prints each under its heading when one of its terms hits the
   * prompt by the risk rule, once per session. Absent when there is nothing to say.
   */
  guidance?: Array<{ id: string; heading: string; line: string; terms: string[] }>;
  /**
   * The account whose belief store compiled `user_preferences` and `guidance`. Absent: the accountless
   * person's own local file, delivered on this machine whoever is signed in. Present: those entries
   * are that account's, and the hook delivers them only while it is signed in here, as it does the
   * profile block.
   */
  personal_owner?: string;
  /**
   * Open knowledge gaps. The hook delivers at most one per tool event, once per session per
   * ref, and only on an Edit or Write inside `scope`. Absent when there are no open gaps or in-flow
   * delivery is off (`knowledgeGapDelivery`), which keeps the index byte-identical for everyone else.
   */
  knowledge_gaps?: KnowledgeGapStub[];
  /** Changed decisions held to the edits that write the superseded value; absent when there are none. */
  changed_decisions?: ChangedDecisionStub[];
  /**
   * The signed-in person's team and personal profiles (Team Intelligence), ranked by the account's
   * provider for a coding session without a request (surface "chat") and rendered, at most
   * `HOOK_PROFILE_BLOCK_MAX_CHARS`. The hook delivers the block once per session and version, beside
   * the protocol, and only while `owner` is signed in on this machine: personal entries are that
   * person's. Absent with no account, or when the provider has nothing to deliver.
   */
  intelligence_profiles?: HookIntelligenceProfiles;
}

/** The profile block as the hook index carries it. */
export interface HookIntelligenceProfiles {
  /** The account the block was selected for. */
  owner: string;
  /** Its item version (`intelligenceItemVersion("chat", block)`). */
  version: string;
  block: string;
  /** The entries in `block`, so `get_context` can leave them out for a client this hook serves. */
  ids: string[];
}

/** One open knowledge gap as the hook sees it. Pre-rendered; paths only, never content. */
export interface KnowledgeGapStub {
  /** Session ledger key: "gap_" + stableHash("gap:" + scope). */
  ref: string;
  /** Directory without a leading slash ("packages/cli/src"). */
  scope: string;
  /** At most 280 chars. */
  line: string;
}

/**
 * A changed decision held to the edit that writes the old value: a memory saying "use `X` instead of
 * `Y`" compiles to one of these, and the hook adds `line` once per session to a Write or Edit whose new
 * content carries `superseded` under `scope`. Built by core/knowledge-map/changed-decisions.ts.
 */
export interface ChangedDecisionStub {
  /** Session ledger key: "cd_" + a hash of the memory id and the superseded value. */
  ref: string;
  /** Directory without a leading slash; "" is the whole workspace. */
  scope: string;
  /** The old value, matched as a substring of what is written. */
  superseded: string;
  /** At most 360 chars: the two values, the memory's title and the decision's sentence. */
  line: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule injection strategy types
// ─────────────────────────────────────────────────────────────────────────────

/** Per-rule injection strategy stored in rules.injection_strategy. */
export type RuleInjectionStrategy = "per_call" | "session_once" | "claude_md_only";

/**
 * A rule candidate passed into selectInjectedRules(). Extends the
 * existing RuleStub with the injection_strategy column.
 */
export interface CandidateRule {
  rule_id: string;
  workspace_id: string;
  name: string;
  body: string;
  scope_type: "project" | "folder" | "file_type";
  priority: "critical" | "high" | "medium" | "low";
  injection_strategy: RuleInjectionStrategy;
}

/** Input to selectInjectedRules(). */
export interface SelectInjectedRulesInput {
  session_id: string;
  candidates: CandidateRule[];
  /** Feature flag: pathrule.experiments.rule_promotion_v1. When false, every rule behaves as per_call. */
  promotion_enabled: boolean;
}

/** Output from selectInjectedRules(). */
export interface SelectInjectedRulesOutput {
  injected: CandidateRule[];
  breakdown: {
    per_call: number;
    session_once: number;
    session_once_skipped: number;
    claude_md_only_skipped: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Localhost server contract (cold path)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Config a local supervisor exposes so the shell script can find the
 * cold-path server. Written to `~/.pathrule/cache/supervisor.json` at app
 * start. Bearer token is mirrored in keychain for the hook to pick up via
 * env (`PATHRULE_HOOK_TOKEN`).
 */
export interface SupervisorConfig {
  port: number;
  /** Opaque token — hook authenticates with `Authorization: Bearer <token>`. */
  token_env: "PATHRULE_HOOK_TOKEN";
  started_at: string;
}

/** Status surfaced via IPC for a Settings → Hooks panel. */
export interface HookSupervisorStatus {
  running: boolean;
  port: number | null;
  startedAt: string | null;
}
