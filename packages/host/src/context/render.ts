// SPDX-License-Identifier: Apache-2.0
// The open block renderer of a turn's Pathrule context, with its fixed, documented budgets.
//
// It writes the workspace bootstrap and index (the stable half, versioned so a conversation that
// already holds it is not sent it again) and the knowledge for this request (the dynamic half):
// invoked skills, the memories at this path in full, rules, available skills, the related bodies
// from other nodes, and the person's guidance last, after the rules it can never override. Every
// body it writes is attributed, and a body this conversation already holds is carried, not resent.
//
// Moved unchanged from Studio's turn context.

import type { ContextBundle } from "@pathrule/core/tools/tree.js";
import type { NodeContent } from "@pathrule/core";
import type { TurnContext, TurnContextAttribution } from "@pathrule/protocol/turn-context.js";
import { stableHash } from "@pathrule/protocol/versioning.js";

import type { ReferencedSkillReadPath } from "./skill-paths.js";

// Completeness: memory bodies are delivered IN FULL up to a shared
// budget; once it is spent, lower-ranked bodies are dropped ENTIRELY rather than
// truncated. A cut body sends the agent back to read_memory / file exploration —
// the measured regression: truncating current-node bodies to 1200 chars drove
// 13 tool calls + 2/3 facts, vs complete bodies' 2 tool calls + 3/3 (Phase 3
// value experiment). Rules/skills stay capped — they are short by construction.
const MAX_BODY_BUDGET = 24_000; // total chars across ALL memory bodies (current-node + related)
const MAX_SINGLE_BODY = 8_000; // pathological single-memory cap (one runaway body can't eat the budget)
export const MAX_BLOCK_CHARS = 40_000; // hard ceiling; bodies are budget-protected, this only guards a huge overview tail
const MAX_RULE_CHARS = 1_200;
const MAX_SKILL_CHARS = 4_000;

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A cross-node hit for the user's question: only the memories that matched, with bodies. */
export interface RelatedNode {
  path: string;
  memories: Array<{ id: string; title: string; content: string }>;
}

export function emptyTurnContext(): TurnContext {
  return {
    block: "",
    stableBlock: "",
    dynamicBlock: "",
    stableVersion: "",
    itemVersions: [],
    metrics: {
      stableChars: 0,
      dynamicChars: 0,
      totalChars: 0,
      deliveredItems: 0,
      omittedKnownItems: 0,
    },
    attributions: [],
  };
}

function knowledgeItemVersion(
  kind: TurnContextAttribution["kind"],
  id: string,
  title: string,
  body: string,
): string {
  return `${kind}:${id || title}:${stableHash({ title, body })}`;
}

export interface RenderBlockOptions {
  knownStableVersion?: string;
  knownItemVersions?: Iterable<string>;
  /**
   * How the PERSON works, already compiled and task-filtered by the shared user-intelligence layer.
   *
   * Passed in rather than read here because this function is synchronous and the store is a file, and
   * because the decision of WHAT may be delivered must stay in one place.
   */
  userPreferenceBlock?: string;
  /**
   * Memories delivered as their compiled form, keyed by memory id (`compiledMemoryDeliveries` on the
   * local backend). Such a memory's body slot carries that text instead of the memory, exactly as the
   * hook's body channel does; every other memory is delivered as written.
   */
  compiledMemories?: Readonly<Record<string, { text: string }>>;
  /**
   * The runtime indicator for this path (`runtimeIndicatorLine`): counts of the application's current
   * issues, never anything it sent. Delivered once per conversation while it stays the same.
   */
  runtimeLine?: string | null;
}

const MAX_OVERVIEW_NODES = 12;
const MAX_OVERVIEW_TITLES_PER_NODE = 3;

// Exported for the token-cost guard test (render-skill-cost.test.ts), which asserts an
// available skill contributes name + description only, while an invoked skill's body is injected
// once and capped at MAX_SKILL_CHARS.
export function renderBlock(
  bundle: ContextBundle,
  content: NodeContent | null,
  related: RelatedNode[],
  workspaceId: string,
  sessionKey: string | null,
  referencedSkillReadPaths: ReferencedSkillReadPath[] = [],
  options: RenderBlockOptions = {},
): TurnContext {
  const memories = content?.memories ?? [];
  const rules = content?.rules ?? [];
  const skills = content?.skills ?? [];
  const invoked = bundle.invoked_skills ?? [];
  const overview = bundle.workspace_overview;
  const relatedWithBodies = related.filter((r) => r.memories.length > 0);
  const here = bundle.resolved_workspace_path || "/";
  const stableVersion = stableHash({
    workspaceId,
    here,
    sessionKey,
    overview,
  });
  const knownItems = new Set(options.knownItemVersions ?? []);

  // Nothing worth injecting, let the agent fall back to live MCP if it needs to. How the PERSON works
  // counts as something worth injecting: it travels with them, so a workspace that has taught Pathrule
  // nothing is exactly where their own preferences are the only thing there is to say.
  const hasUserPreferences = (options.userPreferenceBlock ?? "").trim().length > 0;
  const runtimeLine = options.runtimeLine?.trim() || "";
  if (
    !hasUserPreferences &&
    !runtimeLine &&
    memories.length === 0 &&
    rules.length === 0 &&
    skills.length === 0 &&
    invoked.length === 0 &&
    relatedWithBodies.length === 0 &&
    overview.length === 0
  ) {
    return { ...emptyTurnContext(), stableVersion };
  }

  const stableLines: string[] = [];
  if (options.knownStableVersion !== stableVersion) {
    stableLines.push(
      "## Pathrule workspace bootstrap (versioned; pre-loaded)",
      `\`workspace_id\`: ${workspaceId}; default \`node_path\`: \`${here}\`. Use the injected knowledge before Pathrule read tools; call get_context only for knowledge not covered here.`,
      "For writes, use this workspace id and the most specific node_path. Update shown items by edit id with content_edit; log_activity may take cwd.",
    );
  }
  // Close the affinity feedback loop. The injection capture for this turn
  // is keyed on `sessionKey`; the end-of-turn log_activity MUST carry the same
  // session_id (and the ids of the memories that actually helped) or the signal
  // cannot be joined to the injection. This is invisible to the user.
  if (sessionKey && stableLines.length > 0) {
    stableLines.push(
      `For log_activity use session_id "${sessionKey}" and only the applied memory edit ids; keep this internal.`,
    );
  }
  // The overview is a compact, one-time navigation digest. It is deliberately
  // bounded: the full title warehouse was the fixed per-turn tax that dominated
  // no-match prompts in large workspaces.
  if (stableLines.length > 0 && overview.length > 0) {
    stableLines.push("", "### Workspace index (compact)");
    for (const node of overview.slice(0, MAX_OVERVIEW_NODES)) {
      const titles = [
        ...node.memories.map((m) => m.title),
        ...node.rules.map((r) => r.name),
        ...node.skills.map((s) => s.name),
      ]
        .slice(0, MAX_OVERVIEW_TITLES_PER_NODE)
        .map((title) => truncate(title, 56));
      if (titles.length > 0) stableLines.push(`- ${node.relative_path}: ${titles.join(", ")}`);
    }
    if (overview.length > MAX_OVERVIEW_NODES) {
      stableLines.push(
        `- … ${overview.length - MAX_OVERVIEW_NODES} more nodes available on demand`,
      );
    }
  }

  const dynamicLines: string[] = [];
  const ensureDynamicHeader = (): void => {
    if (dynamicLines.length > 0) return;
    dynamicLines.push(
      "## Pathrule context delta (new or changed)",
      "Apply these records to the current request. They are already loaded; do not re-fetch them.",
    );
  };
  // Attributions are deduped by kind+id (a memory can surface both as a node
  // body and an intent match). Reuses the read-tool badge ref so the UI renders
  // them with no change (source:"injected").
  const seen = new Set<string>();
  const attributions: TurnContextAttribution[] = [];
  const attributedByKey = new Map<string, TurnContextAttribution>();
  const itemVersions: string[] = [];
  const deliveredVersions = new Set<string>();
  let omittedKnownItems = 0;
  /**
   * One entry per item this turn RUNS ON, whether or not its bytes are in this
   * turn's delta. `carried` items were omitted to save tokens because the engine
   * already holds them from an earlier turn of the same native session; leaving
   * them unattributed is what made the session panel go quiet after turn one and
   * let the agent answer from a rule the panel never showed.
   */
  const record = (
    kind: TurnContextAttribution["kind"],
    id: string,
    title: string,
    body: string,
    carried: boolean,
  ): void => {
    if (!id) return;
    const key = `${kind}:${id}`;
    const existing = attributedByKey.get(key);
    if (existing) {
      // A real delivery in this same build outranks a carried mention of it.
      if (!carried) delete existing.carried;
      return;
    }
    const ref: TurnContextAttribution = { kind, id, title, body, source: "injected" };
    if (carried) ref.carried = true;
    attributedByKey.set(key, ref);
    attributions.push(ref);
  };
  const shouldDeliver = (
    kind: TurnContextAttribution["kind"],
    id: string,
    title: string,
    body: string,
    force = false,
  ): boolean => {
    const version = knowledgeItemVersion(kind, id, title, body);
    if (deliveredVersions.has(version)) return false;
    if (!force && knownItems.has(version)) {
      omittedKnownItems += 1;
      record(kind, id, title, body, true);
      return false;
    }
    deliveredVersions.add(version);
    return true;
  };
  const attribute = (
    kind: TurnContextAttribution["kind"],
    id: string,
    title: string,
    body: string,
  ): void => {
    const key = `${kind}:${id}`;
    if (!id || seen.has(key)) return;
    seen.add(key);
    itemVersions.push(knowledgeItemVersion(kind, id, title, body));
    record(kind, id, title, body, false);
  };

  // Push a memory's FULL body if it fits the shared budget; otherwise
  // drop it whole (a complete top-k beats a truncated all-k). A single runaway
  // body is capped so it can't starve the rest. Only PUSHED bodies are attributed
  // (a dropped one is not in the block, so it must not show as "used").
  let bodyBudget = MAX_BODY_BUDGET;
  let droppedBodies = 0;
  // Returns whether a body actually landed in the block. The callers use that to
  // decide whether to splice in their section heading: counting attributions instead
  // would now count CARRIED items too and print a heading with nothing under it.
  const pushMemoryBody = (
    heading: string,
    m: { id: string; title: string; content: string },
  ): boolean => {
    // The completeness gate's decision: the compiled form when it cleared this memory, else the memory.
    const delivered = options.compiledMemories?.[m.id]?.text ?? m.content;
    if (!shouldDeliver("memory", m.id, m.title, delivered)) return false;
    const body =
      delivered.length > MAX_SINGLE_BODY ? truncate(delivered, MAX_SINGLE_BODY) : delivered;
    const headingWithId = m.id ? `${heading}  (edit id: ${m.id})` : heading;
    const cost = headingWithId.length + body.length + 2;
    if (cost > bodyBudget) {
      droppedBodies += 1;
      return false;
    }
    bodyBudget -= cost;
    ensureDynamicHeader();
    dynamicLines.push("", headingWithId, body);
    attribute("memory", m.id, m.title, delivered);
    return true;
  };

  if (invoked.length > 0) {
    ensureDynamicHeader();
    dynamicLines.push("", "### Invoked skills");
    for (const s of invoked) {
      // An explicit ::skill marker is a hard gate. Deliver it on every explicit
      // invocation even when this version appeared in an earlier turn. The body
      // rides the system context, never the transcript; the renderer shows the
      // invocation as a named, clickable skill row from its attribution.
      if (!shouldDeliver("skill", s.id, s.name, s.content, true)) continue;
      dynamicLines.push(
        `#### ${s.name}${s.id ? `  (edit id: ${s.id})` : ""}`,
        truncate(s.content, MAX_SKILL_CHARS),
      );
      attribute("skill", s.id, s.name, s.content);
    }
  }

  if (referencedSkillReadPaths.length > 0) {
    ensureDynamicHeader();
    dynamicLines.push(
      "",
      "### Referenced skills on disk (read-only, MCP-free)",
      "Injected skills may route to more specific `::skill-name` sub-flows. Do NOT call Pathrule MCP to read those sub-skills. If one is required, read its local `SKILL.md` from the path listed here with normal filesystem tools, then follow it.",
    );
    for (const s of referencedSkillReadPaths) {
      dynamicLines.push(`- ::${s.name}: ${s.paths.join(" or ")}`);
    }
  }

  if (memories.length > 0) {
    const headingIndex = dynamicLines.length === 0 ? 2 : dynamicLines.length;
    let delivered = 0;
    // Current-node bodies get the budget FIRST (they are at the exact path, so
    // most relevant); related cross-node bodies draw from what remains.
    for (const m of memories) {
      if (pushMemoryBody(`#### ${m.title}`, m)) delivered += 1;
    }
    if (delivered > 0) {
      dynamicLines.splice(
        Math.min(headingIndex, dynamicLines.length),
        0,
        "",
        "### Memories at this path (full bodies — answer from these)",
      );
    }
  }

  if (rules.length > 0) {
    const deliveredRules = rules.filter((r) => shouldDeliver("rule", r.id, r.name, r.content));
    if (deliveredRules.length > 0) {
      ensureDynamicHeader();
      dynamicLines.push("", "### Rules (must follow)");
    }
    for (const r of deliveredRules) {
      const idTag = r.id ? ` (edit id: ${r.id})` : "";
      dynamicLines.push(
        `- [${r.priority}] ${r.name}${idTag}: ${truncate(r.content, MAX_RULE_CHARS)}`,
      );
      attribute("rule", r.id, r.name, r.content);
    }
  }

  if (skills.length > 0) {
    const deliveredSkills = skills.filter((s) =>
      shouldDeliver("skill", s.id, s.name, s.description ?? ""),
    );
    if (deliveredSkills.length > 0) {
      ensureDynamicHeader();
      dynamicLines.push("", "### Skills available here (invoke with ::name)");
    }
    for (const s of deliveredSkills) {
      const idTag = s.id ? ` (edit id: ${s.id})` : "";
      dynamicLines.push(`- ${s.name}${s.description ? `: ${s.description}` : ""}${idTag}`);
      attribute("skill", s.id, s.name, s.description ?? "");
    }
  }

  // Cross-node memories that match the user's question, WITH bodies — this is
  // what lets the agent answer a discovery question (e.g. a milestone living in
  // another node) without a read_memory roundtrip.
  if (relatedWithBodies.length > 0) {
    const headingIndex = dynamicLines.length === 0 ? 2 : dynamicLines.length;
    let delivered = 0;
    for (const node of relatedWithBodies) {
      for (const m of node.memories) {
        if (pushMemoryBody(`#### ${m.title} (${node.path})`, m)) delivered += 1;
      }
    }
    if (delivered > 0) {
      dynamicLines.splice(
        Math.min(headingIndex, dynamicLines.length),
        0,
        "",
        "### Relevant to your question (full bodies — answer from these)",
        "These complete bodies matched the request; do not re-fetch them.",
      );
    }
  }

  // No silent caps: if the budget dropped lower-ranked complete bodies, say so,
  // so the agent knows it MAY pathrule_read_memory for the rest (rather than
  // assuming the slice is exhaustive).
  if (droppedBodies > 0) {
    ensureDynamicHeader();
    dynamicLines.push(
      "",
      `(${droppedBodies} more lower-ranked memory ${droppedBodies === 1 ? "body was" : "bodies were"} omitted to fit the budget; pathrule_read_memory if you need them.)`,
    );
  }

  // The application's runtime issues under this path, as counts. Versioned like an item, so a
  // conversation that already holds this exact line is not sent it again.
  if (runtimeLine) {
    const version = `runtime:${stableHash({ runtimeLine })}`;
    if (knownItems.has(version)) {
      omittedKnownItems += 1;
    } else {
      ensureDynamicHeader();
      dynamicLines.push("", "### Runtime", runtimeLine);
    }
    itemVersions.push(version);
  }

  // After the workspace knowledge, for the same reason the hook puts it last: a preference must be met
  // after the rules it can never override.
  if (options.userPreferenceBlock && options.userPreferenceBlock.trim().length > 0) {
    ensureDynamicHeader();
    dynamicLines.push("", options.userPreferenceBlock.trim());
  }

  const stableBlock = stableLines.join("\n");
  const dynamicBlock = dynamicLines.join("\n");
  const block = truncate([stableBlock, dynamicBlock].filter(Boolean).join("\n\n"), MAX_BLOCK_CHARS);
  return {
    block,
    stableBlock,
    dynamicBlock,
    stableVersion,
    itemVersions,
    metrics: {
      stableChars: stableBlock.length,
      dynamicChars: dynamicBlock.length,
      totalChars: block.length,
      deliveredItems: itemVersions.length,
      omittedKnownItems,
    },
    attributions,
  };
}
