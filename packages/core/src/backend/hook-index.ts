// SPDX-License-Identifier: Apache-2.0

import { compiledDeliveryPlan, deliveredMemoryBody, sourcedAdvisoryLines } from "./compiled-delivery.js";
import { changedDecisionStubs } from "../knowledge-map/changed-decisions.js";
export { compiledDeliveryPlan, deliveredMemoryBody, type CompiledDeliveryInput } from "./compiled-delivery.js";
// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic hook-index assembly. Builds the full HookIndex the offline hook
 * supervisor reads: path_memories / path_rules / project_rules / recent_subjects
 * / session_digest / filename_index / skill_invocation_index / work_episode_index
 * + refresh counts. Shared by the SQLite-backed and in-memory backends. No
 * `better-sqlite3` import.
 *
 * `semantic_tags` are inferred (reusing shared `semanticTagsOrInfer`).
 *
 * `enforcement` / `block_pattern` are compiled from the rule's CONSTRAINT atoms via
 * the shared `compileRuleConstraints`, which is the SAME function the cloud path uses
 * to produce the stored compiled form. One implementation, so the same constraint
 * denies in every edition or in none; a deny that differs by edition is an indicator
 * that cannot separate two cases with opposite fixes. The legacy in-prose
 * `BLOCK_PATTERN:` marker is NOT read here, and no rule has ever carried one.
 *
 * `symbols`, `fail_patterns`, `promoted_rules_signature` and `experiments` still rely
 * on curated/feature-flagged data not available here and stay omitted. Stub shapes
 * match @pathrule/shared/hook-supervisor.
 */
import { extractFilenameTokensFromPrompt } from "../retrieval/matcher.js";
import type {
  AdvisoryStub,
  HookIndex,
  MemoryStub,
  RuleStub,
  SkillInvocationStub,
  SkillStub,
  WorkEpisodeStub,
} from "@pathrule/protocol/hook-index.js";
import type { RemedyAdvisory, SelectionAdvisory, ProcedureAdvisory, ContextAdvisory, RationaleAdvisory } from "@pathrule/agent-ir/delivery/agent-ir.js";
import { planCompiledDelivery } from "@pathrule/agent-ir/delivery/compiled-delivery.js";
import type { WorkEpisodeBrief } from "@pathrule/protocol/intelligence-types.js";
import { compileRuleConstraints } from "@pathrule/agent-ir/atoms/constraint.js";
import { compileRuleChecks } from "@pathrule/agent-ir/atoms/check.js";
import type { RuleAtom } from "@pathrule/agent-ir/atoms/atoms.js";
import { semanticTagsOrInfer } from "../retrieval/semantic-tags.js";
import { createHash } from "node:crypto";
import type { Warehouse } from "./inputs.js";

const PREVIEW_CHARS = 120;
const PER_BODY_BYTE_CAP = 3 * 1024;
const TOTAL_FILENAME_INDEX_BUDGET = 60 * 1024;
const SKILL_BODY_CAP = 6 * 1024;
const RECENT_SUBJECTS_LIMIT = 100;

/**
 * UTF-8 byte length. The body budgets above are byte caps, not character caps —
 * `String.length` counts UTF-16 code units, so multi-byte content (CJK, emoji,
 * accented text) would smuggle ~2-3x its intended byte size into the hook index
 * the supervisor reads on every tool call. Measure real bytes.
 */
function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export interface HookMemoryInput {
  id: string;
  title: string;
  content: string;
  /** The owner's path: where the memory lives, and what every stub of it names. */
  node_path: string;
  semantic_tags?: string[] | null;
  /**
   * Secondary context links (`relatedPaths`). The memory's stub is placed under each of them as
   * well, so a path below a link inherits it as it would an attachment. Absent or empty: the
   * owner's path only.
   */
  related_paths?: string[];
  /** When it last changed. A budget-bound native file keeps the most recently changed knowledge first. */
  updated_at?: string | null;
}

/**
 * Every path a memory's stub is placed under: its owner first, then its links, each once.
 * A link equal to the owner's path adds nothing.
 */
function memoryPlacements(m: HookMemoryInput): string[] {
  return [...new Set([m.node_path, ...(m.related_paths ?? [])])];
}
export interface HookRuleInput {
  id: string;
  name: string;
  content: string;
  scope_type: string;
  priority: string;
  /** Node paths this rule is attached to (via node_rules); empty for unattached. */
  node_paths: string[];
  semantic_tags?: string[] | null;
  /** Parsed CONSTRAINT atoms. Compiled here; the caller does not decide authority. */
  constraints?: RuleAtom[] | null;
}
export interface HookSkillInput {
  id: string;
  name: string;
  description: string | null;
  content: string;
  source: string;
  github_url: string | null;
  /** Node paths this skill is attached to (via node_skills). Used by the
   *  knowledge compiler to place the skill in its directory's native file;
   *  empty/absent → compiled at the workspace root. */
  node_paths?: string[];
  semantic_tags?: string[] | null;
}
export interface HookActivityDigestRow {
  domain: string | null;
  action: string | null;
  node_path: string | null;
  task_summary: string | null;
}
export interface HookIndexInput {
  workspaceId: string;
  generatedAt: string;
  memories: HookMemoryInput[];
  rules: HookRuleInput[];
  skills: HookSkillInput[];
  /** Subjects per recent activity (last ~100), ranked into recent_subjects. */
  recentActivitySubjects: string[][];
  /** Last-30-min activities, summarised into session_digest. */
  recentActivityDigest: HookActivityDigestRow[];
  /** Medium/high-confidence episodes (from clusterEpisodes). */
  workEpisodes: WorkEpisodeBrief[];
  pendingRefreshCount: number;
  inProgressRefreshCount: number;
  /**
   * Approved, deliverable REMEDY advisories with their resolved scope, already projected by the
   * engine-neutral Agent IR layer. Grouped here into path_advisories / project_advisories. Absent
   * or empty means the index carries no advisories and the hook stays silent about remedies.
   */
  advisories?: RemedyAdvisory[];
  selections?: SelectionAdvisory[];
  procedures?: ProcedureAdvisory[];
  contexts?: ContextAdvisory[];
  rationales?: RationaleAdvisory[];
  /**
   * Atom ref -> id of the memory it was compiled from, for memory-sourced atoms only. This is what lets
   * the completeness gate judge a memory's lines against the memory itself (see `compiledDeliveryPlan`).
   * An atom missing here has no source to judge and keeps its additive delivery.
   */
  advisorySources?: Record<string, string>;
  /**
   * Rendered agent protocol, for a workspace that delivers it through the hook
   * rather than the companion files. Omitted (or blank) leaves `protocol` off
   * the index entirely, which is what keeps the hook silent about it.
   */
  protocol?: string;
}

function truncatePreview(text: string, n: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, n);
}

/**
 * Change-detection key for delta injection: a stable sha256(content) prefix.
 * The delta gate re-injects a memory/rule/skill only when this differs from the
 * last-injected hash in the session ledger, so an unchanged item never re-enters
 * the agent context (cache-stability invariant).
 */
function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function normalizeSource(source: string): SkillInvocationStub["source"] {
  return source === "manual" || source === "template" || source === "github_ref"
    ? source
    : "manual";
}

/** Bodies of root memories delivered at session start, in characters; the rest are offered by title. */
export const PROJECT_KNOWLEDGE_BODY_BUDGET = 4000;
const PROJECT_KNOWLEDGE_MAX_TITLES = 20;

/**
 * The workspace-wide (root) memories as one SessionStart block, or null when there are none. Shortest
 * bodies first: the budget then carries as many distinct rules as it can, and a long one (often pasted
 * documentation) is offered by title instead of crowding the short ones out.
 */
export function buildProjectKnowledge(memories: readonly HookMemoryInput[], bodyOf: (m: HookMemoryInput) => string): string | null {
  const root = memories
    .filter((m) => m.node_path === "/" || m.node_path === "")
    .map((m) => ({ m, body: bodyOf(m).trim() }))
    .sort((a, b) => a.body.length - b.body.length || a.m.id.localeCompare(b.m.id));
  if (root.length === 0) return null;
  const lines = ["📌 Project-wide knowledge (applies to every task in this workspace):"];
  const titlesOnly: HookMemoryInput[] = [];
  let used = 0;
  for (const { m, body } of root) {
    if (used + body.length > PROJECT_KNOWLEDGE_BODY_BUDGET) { titlesOnly.push(m); continue; }
    used += body.length;
    lines.push("", `### ${m.title}`, body);
  }
  if (titlesOnly.length > 0) {
    lines.push("", "Also project-wide (pull a body with pathrule_read_memory if it matters):");
    for (const m of titlesOnly.slice(0, PROJECT_KNOWLEDGE_MAX_TITLES)) lines.push(`- ${m.title} (id: ${m.id})`);
  }
  return lines.join("\n");
}

function buildSessionDigest(
  digest: HookActivityDigestRow[],
  pending: number,
  inProgress: number,
): string | null {
  const parts: string[] = [];
  if (digest.length > 0) {
    const paths = [...new Set(digest.map((d) => d.node_path).filter((p): p is string => !!p))];
    const where = paths.length > 0 ? ` across ${paths.slice(0, 3).join(", ")}` : "";
    parts.push(`${digest.length} recent change${digest.length === 1 ? "" : "s"}${where}`);
  }
  if (pending > 0) parts.push(`${pending} pending refresh${pending === 1 ? "" : "es"}`);
  if (inProgress > 0) parts.push(`${inProgress} in progress`);
  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * Build the full-body warehouse: every memory/rule/skill keyed by id, no preview
 * truncation. This is the "data availability" layer — it does not enter the agent
 * context; delivery reads from it by id only for delta items. `content_hash` is
 * computed with the SAME function the index uses, so an item's warehouse hash and
 * index hash always agree — the delta gate relies on this.
 *
 * A memory the completeness gate cleared carries its compiled form as `body`, hashed
 * as delivered, plus `compiled_refs` so the hook can tell when the same lines already
 * reached the session through the advisory channel.
 */
// Keyed by member-written strings (ids, skill names, paths): without a prototype, a key such as
// "constructor" or "__proto__" is an ordinary entry instead of an inherited member.
function keyedBy<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function assembleWarehouse(input: HookIndexInput): Warehouse {
  const warehouse: Warehouse = keyedBy();
  const plan = compiledDeliveryPlan(input);
  for (const m of input.memories) {
    const body = deliveredMemoryBody(m, plan);
    warehouse[m.id] = { type: "memory", title: m.title, body, content_hash: contentHash(body) };
    const compiled = plan.compiled.get(m.id);
    if (compiled) warehouse[m.id]!.compiled_refs = compiled.refs;
  }
  for (const r of input.rules) {
    warehouse[r.id] = { type: "rule", title: r.name, body: r.content, content_hash: contentHash(r.content) };
  }
  for (const s of input.skills) {
    warehouse[s.id] = { type: "skill", title: s.name, body: s.content, content_hash: contentHash(s.content) };
  }
  return warehouse;
}

/** Assemble the full HookIndex (workspace_root left null — the CLI writer fills it). */
export function assembleHookIndex(input: HookIndexInput): HookIndex {
  const advisoryLines = sourcedAdvisoryLines(input);
  const plan = planCompiledDelivery(advisoryLines, input.memories);
  const bodyOf = new Map(input.memories.map((m) => [m.id, deliveredMemoryBody(m, plan)]));

  // ── memories → path_memories + filename_index (with body budget) ──
  const tokensByMemory = new Map<string, string[]>();
  for (const m of input.memories) {
    const tokens = extractFilenameTokensFromPrompt(m.title);
    if (tokens.length > 0) tokensByMemory.set(m.id, tokens);
  }
  // Body budget: only token-bearing memories ≤ per-body cap, smallest-first until total budget.
  // Sized on what the body slot carries, so a memory delivered as its compiled form costs that.
  // A linked memory's stub, body included, is written once per placement, so it costs that many
  // times; a memory with no links costs exactly what it did before links existed.
  const bodyEligible = input.memories
    .map((m) => {
      const bytes = byteLength(bodyOf.get(m.id) ?? m.content);
      return { m, bytes, cost: bytes * memoryPlacements(m).length };
    })
    .filter((e) => tokensByMemory.has(e.m.id) && e.bytes <= PER_BODY_BYTE_CAP)
    .sort((a, b) => a.cost - b.cost || a.m.id.localeCompare(b.m.id));
  const bodyIds = new Set<string>();
  let runningBytes = 0;
  for (const { m, cost } of bodyEligible) {
    runningBytes += cost;
    if (runningBytes > TOTAL_FILENAME_INDEX_BUDGET) break;
    bodyIds.add(m.id);
  }

  const pathMemories = keyedBy<MemoryStub[]>();
  const filenameIndex = keyedBy<string[]>();
  for (const m of [...input.memories].sort((a, b) => a.id.localeCompare(b.id))) {
    const tokens = tokensByMemory.get(m.id);
    const body = bodyOf.get(m.id) ?? m.content;
    const stub: MemoryStub = {
      id: m.id,
      title: m.title,
      // The preview stays the memory's own words: it is a name-tier hint, and the compiled form's
      // first line is the same marker for every compiled memory.
      preview: truncatePreview(m.content, PREVIEW_CHARS),
      node_path: m.node_path,
      // Hashed as delivered, matching assembleWarehouse, so the delta gate sees one version per memory.
      content_hash: contentHash(body),
      semantic_tags: semanticTagsOrInfer(m.semantic_tags, {
        text: `${m.title} ${m.content.slice(0, 1000)}`,
        path: m.node_path,
      }),
    };
    if (tokens) stub.filename_tokens = tokens;
    if (bodyIds.has(m.id)) stub.body = body;
    // The SAME stub under every placement: one id, one hash, the owner's node_path. Readers
    // deduplicate by id, so a path that inherits the memory twice (from its owner and from a
    // link) still delivers it once, and whichever copy a reader keeps says the same thing.
    for (const placement of memoryPlacements(m)) (pathMemories[placement] ??= []).push(stub);
    for (const t of tokens ?? []) (filenameIndex[t] ??= []).push(m.id);
  }
  for (const ids of Object.values(filenameIndex)) ids.sort();

  // ── rules → project_rules + path_rules ──
  const projectRules: RuleStub[] = [];
  const pathRules = keyedBy<RuleStub[]>();
  for (const r of [...input.rules].sort((a, b) => a.id.localeCompare(b.id))) {
    const base: RuleStub = {
      id: r.id,
      name: r.name,
      scope_type: r.scope_type as RuleStub["scope_type"],
      priority: r.priority as RuleStub["priority"],
      preview: truncatePreview(r.content, PREVIEW_CHARS),
      content_hash: contentHash(r.content),
      semantic_tags: semanticTagsOrInfer(r.semantic_tags, {
        text: `${r.name} ${r.content.slice(0, 1000)}`,
        path: null,
      }),
    };
    // Only a human-approved, active atom compiles.
    //
    // `enforcement` is ALWAYS emitted, defaulting to "advisory", because the cloud SQL
    // builder emits `COALESCE(r.enforcement, 'advisory')` unconditionally. Omitting the
    // key here made an unconstrained rule's stub differ between editions on a field a
    // deny gate reads. Measured, not assumed: cloud produced
    // {"block_pattern":null,"enforcement":"advisory"} where this produced
    // {"block_pattern":null,"enforcement":null}.
    //
    // Known remaining divergence, tracked as debt: a rule whose CLOUD `rules.enforcement`
    // column says 'strict' without carrying a constraint atom still differs, because
    // there is no such column in the local schema. That is the stored-column-versus-
    // compiled-value split, deliberately left alone here.
    // `r.content` is the grounding gate's second half: a compiler-verified atom only
    // compiles while the body it was proved against still contains its source excerpt.
    // Passing the rule's own stored content here is what makes the guarantee independent
    // of which mutation path last wrote it.
    const compiled = compileRuleConstraints(r.constraints, r.content);
    base.enforcement = compiled ? compiled.enforcement : "advisory";
    if (compiled?.block_pattern) base.block_pattern = compiled.block_pattern;
    if (compiled?.block_path) base.block_path = compiled.block_path;
    const check = compileRuleChecks(r.constraints);
    if (check) base.required_check = check;
    if (r.scope_type === "project") {
      projectRules.push(base);
    } else {
      for (const np of r.node_paths) {
        (pathRules[np] ??= []).push({ ...base, node_path: np });
      }
    }
  }

  // ── recent_subjects: rank by frequency, top 100 ──
  const subjectCounts = new Map<string, number>();
  for (const subs of input.recentActivitySubjects) {
    for (const s of subs) {
      if (s && s.length > 0) subjectCounts.set(s, (subjectCounts.get(s) ?? 0) + 1);
    }
  }
  const recentSubjects = [...subjectCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, RECENT_SUBJECTS_LIMIT)
    .map(([s]) => s);

  // ── skills → skill_invocation_index (keyed by normalized name) ──
  const skillIndex = keyedBy<SkillInvocationStub[]>();
  for (const s of input.skills) {
    const key = s.name.trim().toLowerCase();
    if (!key) continue;
    const stub: SkillInvocationStub = {
      id: s.id,
      name: s.name,
      source: normalizeSource(s.source),
      github_url: s.github_url,
      node_path: null,
      preview: truncatePreview(s.content, PREVIEW_CHARS),
      content_hash: contentHash(s.content),
      semantic_tags: semanticTagsOrInfer(s.semantic_tags, {
        // Stored metadata is typed by the writers; a non-string here must still not fail the whole index.
        text: `${s.name} ${typeof s.description === "string" ? s.description : ""} ${s.content.slice(0, 1000)}`,
        path: null,
      }),
    };
    if (s.content.length >= 1 && byteLength(s.content) <= SKILL_BODY_CAP) stub.body = s.content;
    (skillIndex[key] ??= []).push(stub);
  }

  // ── skills → path_skills (path-scoped stubs for relevance top-k) ──
  // Mirrors path_memories so the hook can find a routed path's skills and rank
  // them against the prompt; bodies live in the warehouse, vectors in embeddings.json.
  const pathSkills = keyedBy<SkillStub[]>();
  for (const s of input.skills) {
    const targets = s.node_paths && s.node_paths.length > 0 ? s.node_paths : ["/"];
    for (const np of targets) {
      (pathSkills[np] ??= []).push({
        id: s.id,
        name: s.name,
        node_path: np,
        preview: truncatePreview(s.content, PREVIEW_CHARS),
        content_hash: contentHash(s.content),
      });
    }
  }

  // ── work_episode_index ──
  const workEpisodeIndex: WorkEpisodeStub[] = input.workEpisodes.map((e) => ({
    id: e.id,
    title: truncatePreview(e.title, 120),
    summary: truncatePreview(e.summary, 260),
    subjects: e.subjects.slice(0, 6),
    paths: e.paths.slice(0, 8),
    activity_count: e.activity_count,
    started_at: e.started_at,
    ended_at: e.ended_at,
    confidence: e.confidence,
  }));

  // ── hot_paths: most-touched recent activity paths, top 8 ──
  const hotCounts = new Map<string, number>();
  for (const a of input.recentActivityDigest) {
    if (a.node_path && a.node_path !== "/") {
      hotCounts.set(a.node_path, (hotCounts.get(a.node_path) ?? 0) + 1);
    }
  }
  const hotPaths = [...hotCounts.entries()]
    .sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]))
    .slice(0, 8)
    .map(([path, count]) => ({ path, count }));

  // ── advisories (REMEDY) → path_advisories + project_advisories ──
  // Group approved advisories by their resolved scope. Input order is preserved (the backend sorts
  // strongest+most-recent first), so within a scope the strongest advisory renders first. A null
  // scope is workspace-global. Purely mechanical: no model, no re-ranking.
  // V31: REMEDY, then SELECTION, then PROCEDURE stubs merge into the SAME scope-keyed maps, so all
  // three advisory kinds deliver through the existing hook injection with no hook change, and the
  // per-scope order (remedy > selection > procedure) matches the Agent IR presentation precedence.
  // The completeness gate decides per source memory: a memory sent back to its source text keeps only
  // its typed guidance (`guidance`, as additive lines), and a cleared memory's lines carry its id as
  // `group` so they travel together.
  const pathAdvisories = keyedBy<AdvisoryStub[]>();
  const projectAdvisories: AdvisoryStub[] = [];
  for (const l of advisoryLines) {
    if (plan.withheldRefs.has(l.ref) && !l.guidance) continue;
    const stub: AdvisoryStub = { ref: l.ref, line: l.line };
    if (l.sourceMemoryId && plan.compiled.has(l.sourceMemoryId)) stub.group = l.sourceMemoryId;
    if (l.scope && l.scope.trim()) (pathAdvisories[l.scope] ??= []).push(stub);
    else projectAdvisories.push(stub);
  }

  const index: HookIndex = {
    schema_version: 2,
    workspace_id: input.workspaceId,
    workspace_root: "",
    generated_at: input.generatedAt,
    path_memories: pathMemories,
    path_rules: pathRules,
    project_rules: projectRules,
    recent_subjects: recentSubjects,
    session_digest: buildSessionDigest(
      input.recentActivityDigest,
      input.pendingRefreshCount,
      input.inProgressRefreshCount,
    ),
    pending_refresh_count: input.pendingRefreshCount,
    in_progress_refresh_count: input.inProgressRefreshCount,
  };
  const projectKnowledge = buildProjectKnowledge(input.memories, (m) => bodyOf.get(m.id) ?? m.content);
  if (projectKnowledge) index.project_knowledge = projectKnowledge;
  if (Object.keys(pathAdvisories).length > 0) index.path_advisories = pathAdvisories;
  if (projectAdvisories.length > 0) index.project_advisories = projectAdvisories;
  const changedDecisions = changedDecisionStubs(input.memories);
  if (changedDecisions.length > 0) index.changed_decisions = changedDecisions;
  if (Object.keys(filenameIndex).length > 0) index.filename_index = filenameIndex;
  if (Object.keys(skillIndex).length > 0) index.skill_invocation_index = skillIndex;
  if (Object.keys(pathSkills).length > 0) index.path_skills = pathSkills;
  if (workEpisodeIndex.length > 0) index.work_episode_index = workEpisodeIndex;
  if (hotPaths.length > 0) index.hot_paths = hotPaths;
  if (typeof input.protocol === "string" && input.protocol.trim().length > 0) {
    index.protocol = input.protocol;
  }
  return index;
}
