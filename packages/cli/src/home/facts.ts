// SPDX-License-Identifier: Apache-2.0
// The facts the project home shows, and the rules that keep them honest.
//
// Every number on the home is a `Fact`: measured (with where it was read), unavailable here (and
// why), or not measured by Pathrule at all. A screen never turns a missing fact into a zero, a
// guess or a percentage. Two rules are pinned here because they are easy to get wrong:
//
// - **Context compression** is a ratio of two measurements of the SAME knowledge: the same items at
//   the same versions, the same scope, counted by the same tokenizer, in two representations. All
//   stored knowledge against the few items a request selected is selection, not compression, and
//   is refused (`contextCompression`).
// - **Delivery** is what receipts in the session delivery ledger confirm (the hook and the MCP
//   server append one only after content left them). Selection, relevance scores and delivery
//   events are not task benefit, and the home claims none.

export type Fact<T> =
  | { state: "measured"; value: T; source: string }
  | { state: "unavailable"; reason: string }
  | { state: "not_measured"; reason: string }
  /** Readable, but only by an action the person takes (it would start the local host). */
  | { state: "deferred"; reason: string }
  | { state: "loading" };

export const measured = <T>(value: T, source: string): Fact<T> => ({
  state: "measured",
  value,
  source,
});
export const unavailable = <T>(reason: string): Fact<T> => ({ state: "unavailable", reason });
export const notMeasured = <T>(reason: string): Fact<T> => ({ state: "not_measured", reason });
export const loading = <T>(): Fact<T> => ({ state: "loading" });
export const deferred = <T>(reason: string): Fact<T> => ({ state: "deferred", reason });

// ── Context compression ──────────────────────────────────────────────────────

/** One token count of one representation of a set of knowledge. */
export interface ContextMeasurement {
  /** What the count is of, e.g. `agent-ir` or `markdown`. */
  representation: string;
  tokens: number;
  /** The tokenizer that counted, by name and version (`o200k_base`). */
  tokenizer: string;
  /** What was measured: workspace, path and request, as one comparable string. */
  scope: string;
  /** A digest of the knowledge the representation encodes: item ids and versions, in order. */
  contentDigest: string;
}

export interface CompressionValue {
  baselineTokens: number;
  deliveredTokens: number;
  /** delivered / baseline. */
  ratio: number;
  /** 1 - ratio, as a percentage rounded to one decimal; negative when delivery is larger. */
  savedPercent: number;
  tokenizer: string;
  scope: string;
}

/**
 * The compression of `delivered` against `baseline`, or why there is none. It is a measurement only
 * when both count the same knowledge (same digest), in the same scope, with the same tokenizer, in
 * two different representations.
 */
export function contextCompression(
  baseline: ContextMeasurement | null,
  delivered: ContextMeasurement | null,
): Fact<CompressionValue> {
  if (!baseline || !delivered) {
    return notMeasured("no equivalent baseline (same knowledge, same tokenizer)");
  }
  if (baseline.tokenizer !== delivered.tokenizer) {
    return notMeasured(
      `Counted by different tokenizers (${baseline.tokenizer}, ${delivered.tokenizer}).`,
    );
  }
  if (baseline.scope !== delivered.scope) {
    return notMeasured("The baseline and the delivery measure different scopes.");
  }
  if (baseline.contentDigest !== delivered.contentDigest) {
    return notMeasured(
      "The baseline holds other knowledge than was delivered; that compares selection, not compression.",
    );
  }
  if (baseline.representation === delivered.representation) {
    return notMeasured("Both counts are of the same representation.");
  }
  if (!(baseline.tokens > 0) || !(delivered.tokens >= 0) || !Number.isFinite(delivered.tokens)) {
    return notMeasured("A token count is missing or not positive.");
  }
  const ratio = delivered.tokens / baseline.tokens;
  return measured(
    {
      baselineTokens: baseline.tokens,
      deliveredTokens: delivered.tokens,
      ratio,
      savedPercent: Math.round((1 - ratio) * 1000) / 10,
      tokenizer: baseline.tokenizer,
      scope: baseline.scope,
    },
    `${baseline.representation} vs ${delivered.representation}, ${baseline.tokenizer}`,
  );
}

// ── The home's facts ─────────────────────────────────────────────────────────

export interface WorkspaceFact {
  /** `local`: a local store serves this folder; `mirror`: a local copy of a Cloud workspace. */
  kind: "local" | "mirror" | "none";
  id: string | null;
  /** The workspace's name once the store has been read; the folder's name until then. */
  name: string | null;
  root: string | null;
  /** Where this folder is inside the workspace ("" at its root). */
  relativePath: string | null;
  /** The folder is a Git repository or already has `.pathrule`. */
  isProject: boolean;
  /** Why the folder's workspace could not be read, when it could not (kind is then `none`). */
  problem?: string;
}

export type IntelligenceMode = "cloud" | "local" | "unset";

export interface CapabilityFact {
  id: "cloud";
  title: string;
  state: "ready" | "unavailable";
  detail: string;
}

export interface IntelligenceFact {
  mode: IntelligenceMode;
  /** How the mode was chosen; `built-in` for a build whose plugins are compiled in. */
  chosenBy: "onboarding" | "flag" | "existing-install" | "built-in" | null;
  capabilities: CapabilityFact[];
  /** The mode the runtime manifest gives agents (their MCP launch); null before any setup. */
  agentsMode: "local" | "cloud" | null;
}

export interface AccountFact {
  /** Whether this mode has an account at all. */
  applicable: boolean;
  /**
   * `signed_in`: the account edition confirmed a session (only after the person asked);
   * `session_stored`: a session is stored and not checked (the home never checks on its own: a
   * check may refresh it over the network); `signed_out`: none, or it is no longer valid;
   * `unknown`: it could not be asked.
   */
  state: "signed_in" | "signed_out" | "session_stored" | "unknown";
  detail: string;
}

export interface AgentFact {
  id: string;
  name: string;
  support: "native-plugin" | "mcp-and-hooks-via-cli" | "not-yet";
  detected: boolean;
  connections: Array<{
    scope: "user" | "project";
    projectRoot: string | null;
    mode: "local" | "cloud";
    channel: string;
    status: "installed" | "partial";
  }>;
}

export interface IntegrationsFact {
  agents: AgentFact[];
  runtime: { version: string; mode: "local" | "cloud" | null; maintenance: boolean } | null;
}

export interface KnowledgeCounts {
  memories: { active: number; archived: number };
  rules: { active: number; archived: number };
  skills: { active: number; archived: number };
}

export const ATOM_KINDS = [
  "remedy",
  "selection",
  "procedure",
  "context",
  "rationale",
  "precedence",
] as const;
export type AtomKind = (typeof ATOM_KINDS)[number];

/** Agent IR knowledge atoms: approved by a person and deliverable, or proposed and awaiting review. */
export interface AtomCounts {
  approved: number;
  proposed: number;
  byKind: Record<AtomKind, { approved: number; proposed: number }>;
}

export interface SignalsSummary {
  groups: number;
  active: number;
  declared: number;
  lastSeen: string | null;
}

export interface ActivityItem {
  at: string;
  path: string | null;
  summary: string;
}

export interface DeliverySummary {
  /** Sessions whose latest context window holds at least one confirmed delivery. */
  sessions: number;
  /** Confirmed items in those windows. */
  items: number;
  byChannel: { hook: number; mcp: number };
  byKind: Record<string, number>;
  lastAt: string | null;
  /**
   * Confirmed items per hour over the last 24 hours, oldest first (24 buckets), from the receipts'
   * own times: the shape of delivery, not a rate.
   */
  hourly: number[];
  /** Ledgers read, and how many there are: the home reads the most recent ones only. */
  sessionsRead: number;
  sessionsTotal: number;
}

/** What one node of the workspace holds, directly (not its subtree). */
export interface PathCount {
  /** Workspace-relative, "/" for the root. */
  path: string;
  memories: number;
  rules: number;
  skills: number;
}

export interface ContextFacts {
  /** Tokens of knowledge delivered to agents. */
  deliveredTokens: Fact<number>;
  /** The size of the Agent IR representation of what was delivered. */
  agentIrTokens: Fact<number>;
  compression: Fact<CompressionValue>;
}

export interface HomeSnapshot {
  schema: 1;
  cliVersion: string;
  cwd: string;
  workspace: WorkspaceFact;
  intelligence: IntelligenceFact;
  account: AccountFact;
  integrations: IntegrationsFact;
  knowledge: Fact<KnowledgeCounts>;
  agentIr: Fact<AtomCounts>;
  signals: Fact<SignalsSummary>;
  activity: Fact<ActivityItem[]>;
  /** The nodes that hold knowledge, with what each holds directly. */
  paths: Fact<PathCount[]>;
  /** Refresh tasks waiting for an agent or a person (pending or in progress). */
  refreshes: Fact<number>;
  deliveries: Fact<DeliverySummary>;
  context: ContextFacts;
}

/**
 * What Pathrule measures about context size today: nothing. Delivery receipts name items and their
 * hashes, not tokens, and no tokenizer ships with the runtime. These stay `not_measured` until a
 * measurement exists; then they are read, never estimated.
 */
export function contextFacts(): ContextFacts {
  return {
    deliveredTokens: notMeasured("receipts record items, not tokens"),
    agentIrTokens: notMeasured("no size measurement is recorded"),
    compression: contextCompression(null, null),
  };
}

/** Whether nothing is set up yet: no mode chosen and no agent connected. The home then welcomes. */
export function isFirstRun(snapshot: Pick<HomeSnapshot, "intelligence" | "integrations">): boolean {
  return (
    snapshot.intelligence.mode === "unset" &&
    snapshot.integrations.agents.every((agent) => agent.connections.length === 0)
  );
}
