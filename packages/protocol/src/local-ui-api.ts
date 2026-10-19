// SPDX-License-Identifier: Apache-2.0
// The HTTP contract between the Local Console (a browser page) and `pathrule ui`,
// the loopback server that reaches the home's Pathrule host on its behalf.
//
// Transport rules (enforced by the server, relied on by the client):
// - The server binds 127.0.0.1 only. Every request's Host must be
//   `127.0.0.1:<port>` or `localhost:<port>`.
// - The page arrives with a single-use launch token in the URL fragment and
//   exchanges it once at `POST /api/session` for a session token kept in
//   sessionStorage. No cookies.
// - Every `/api/*` call is `POST`, `Content-Type: application/json`,
//   `Authorization: Bearer <session>`, with an Origin equal to the server's own.
//   No CORS headers are ever sent.
// - Workspace ids are accepted only from the set of discovered local stores.
// - No account, organization, billing or plan exists in this contract.
// - Runtime event content (messages, labels, metadata, paths, releases, correction notes) is what
//   an application or a person sent: untrusted, shown as text only, never followed.

import type { Memory, Rule, RulePriority, RuleScope, Skill } from "./content-types.js";
import type { TreeNode } from "./node-types.js";
import type {
  RuntimeCorrectionResult,
  RuntimeEventGroup,
  RuntimeEventHistoryEntry,
  RuntimeEventsStatus,
} from "./runtime-events.js";

export const LOCAL_UI_API_VERSION = 1 as const;

/** Every route the Local Console may call, in one list so client and server agree. */
export const LOCAL_UI_ROUTES = [
  "session",
  "runtime.status",
  "workspaces.list",
  "workspaces.summary",
  "workspaces.favorite",
  "tree.get",
  "knowledge.list",
  "knowledge.read",
  "knowledge.search",
  "knowledge.searchAll",
  "knowledge.create",
  "knowledge.update",
  "knowledge.delete",
  "knowledge.restore",
  "knowledge.topics",
  "knowledge.history",
  "activity.recent",
  "deliveries.stats",
  "signals.status",
  "signals.groups",
  "signals.group",
  "signals.correction",
] as const;

export type LocalUiRoute = (typeof LOCAL_UI_ROUTES)[number];

export type KnowledgeKind = "memory" | "rule" | "skill";

/** A capability the local runtime has, or the honest reason it does not. */
export type LocalCapability = { available: true } | { available: false; reason: string };

export interface LocalCapabilities {
  knowledgeRead: LocalCapability;
  knowledgeWrite: LocalCapability;
  search: LocalCapability;
  /**
   * One search over every workspace at once (`knowledge.searchAll`): Local every workspace in the
   * home, Pathrule Cloud every workspace the person reads in the organization.
   */
  searchAll: LocalCapability;
  /** Embedding-backed search; needs a bring-your-own key in Local. */
  semanticSearch: LocalCapability;
  activity: LocalCapability;
  /**
   * Runtime events (Signals) the host stores for each local workspace (the SDK's
   * `pathruleLocal()` destination). Unavailable with a reason when the running host
   * predates them; the console renders that state, never sample data.
   */
  runtimeEvents: LocalCapability;
  /**
   * How often knowledge reached agent sessions (`deliveries.stats`). Each backend counts its own
   * deliveries: Local from this machine's session ledgers, Pathrule Cloud from what its clients
   * report for a Cloud workspace. Unavailable with a reason where nothing is recorded.
   */
  deliveryStats: LocalCapability;
  /**
   * Every workspace at a glance (`workspaces.summary`): item counts, latest activity, deliveries
   * and active Signals, for the Workspaces page.
   */
  workspaceSummary: LocalCapability;
  /**
   * Favorite workspaces (`workspaces.favorite`), kept by the backend that serves the console: this
   * machine's Pathrule home locally, the person's account in Pathrule Cloud. Never the browser.
   */
  favorites: LocalCapability;
  /**
   * Topics (`knowledge.topics`): the knowledge map's groups of linked and alike items, computed
   * by the backend without a model. Naming them needs a model; the answer says whether one named
   * them (`TopicNaming`).
   */
  knowledgeTopics: LocalCapability;
  /** Who changed an item and when (`knowledge.history`). Local keeps no history. */
  knowledgeHistory: LocalCapability;
}

export interface SessionRequest {
  launchToken: string;
}

export interface SessionResponse {
  sessionToken: string;
  /** ISO time after which the session must be renewed by relaunching `pathrule ui`. */
  expiresAt: string;
}

export interface RuntimeStatusResponse {
  edition: "local";
  /** Always "none": the Local Console never requires or shows an account. */
  account: "none";
  apiVersion: typeof LOCAL_UI_API_VERSION;
  cliVersion: string;
  host: {
    /** "client": a running host; "own": this server started one; "degraded": no host. */
    mode: "client" | "own" | "degraded";
    version: string | null;
    pid: number | null;
    plugins: string[];
  };
  /** Pathrule home, shown so a person can tell which home is being served. */
  home: string;
  /** The folder `pathrule ui` was started in, when it is inside a local workspace. */
  currentWorkspaceId: string | null;
  capabilities: LocalCapabilities;
}

export interface LocalWorkspaceSummary {
  id: string;
  name: string;
  /** Absolute folder the workspace is bound to. */
  rootPath: string;
  /** True for the workspace that covers the folder `pathrule ui` started in. */
  current: boolean;
}

export interface WorkspacesListResponse {
  workspaces: LocalWorkspaceSummary[];
}

export interface WorkspaceScoped {
  workspaceId: string;
}

/** How many UTC days, ending today, `workspaces.summary` reports deliveries for. */
export const WORKSPACE_SUMMARY_DAYS = 30;

/** One workspace at a glance. */
export interface WorkspaceActivitySummary {
  id: string;
  /** Active (not archived) items by kind. */
  items: Record<KnowledgeKind, number>;
  /**
   * The latest knowledge change, recorded agent activity or delivery (a delivery counts at the
   * start of its UTC day); null when the workspace has none of them.
   */
  lastActivityAt: string | null;
  /** Deliveries per UTC day over the last `WORKSPACE_SUMMARY_DAYS` days, oldest first. */
  deliveries: number[];
  /** All deliveries in the equally long window just before, for the change. */
  previousDeliveries: number;
  /** Active Signals groups, or null where this backend cannot tell. */
  activeSignals: number | null;
}

export interface WorkspacesSummaryResponse {
  /** One entry per workspace `workspaces.list` returns that could be read. */
  workspaces: WorkspaceActivitySummary[];
  /** Favorite workspace ids, oldest first: this machine's locally, the person's in the Cloud. */
  favorites: string[];
}

export interface WorkspaceFavoriteRequest extends WorkspaceScoped {
  favorite: boolean;
}

export interface WorkspaceFavoriteResponse {
  /** The favorites after the change, oldest first. */
  favorites: string[];
}

export interface TreeGetResponse {
  nodes: TreeNode[];
}

export interface KnowledgeListRequest extends WorkspaceScoped {
  kind: KnowledgeKind;
  /** "archived" lists soft-deleted items that can be restored. */
  status?: "active" | "archived";
}

/** A person as the backend knows them: Local's own user, a Pathrule Cloud member. */
export interface KnowledgePerson {
  id: string;
  /** A display name; "Deleted account" for a closed Cloud account. */
  name: string;
}

/** One row in a knowledge list. Bodies are previews; read for the full text. */
export interface KnowledgeListItem {
  id: string;
  kind: KnowledgeKind;
  title: string;
  preview: string;
  /** Primary owner path, e.g. "/src/features". Null when the node is unknown. */
  path: string | null;
  updatedAt: string;
  versionNumber: number;
  /** Rule metadata. */
  priority?: RulePriority;
  scopeType?: RuleScope;
  /** Skill metadata. */
  tags?: string[];
  /** Times delivered to agents in the store's usage window, when the store counts it. */
  usageCount30d?: number;
  /** Every path the item is attached to, the primary one first. */
  paths?: string[];
  /**
   * The account it was added under, even when an agent wrote it: the person who ran the agent.
   * Null when the backend does not know.
   */
  createdBy?: KnowledgePerson | null;
  lastEditedBy?: KnowledgePerson | null;
  createdAt?: string;
  /** How it was added: by an agent (MCP, a hook) or by a person (a console, the CLI). */
  addedVia?: "agent" | "person" | null;
}

export interface KnowledgeListResponse {
  items: KnowledgeListItem[];
}

export interface KnowledgeReadRequest extends WorkspaceScoped {
  kind: KnowledgeKind;
  id: string;
}

export type KnowledgeRecord =
  | { kind: "memory"; item: Memory; path: string | null }
  | { kind: "rule"; item: Rule; paths: string[] }
  | { kind: "skill"; item: Skill; paths: string[] };

export interface KnowledgeReadResponse {
  record: KnowledgeRecord | null;
}

/** The longest folder a search takes (`path`), in characters. */
export const KNOWLEDGE_SEARCH_PATH_MAX = 512;

export interface KnowledgeSearchRequest extends WorkspaceScoped {
  /** May be "" with `path`: then every active item in the folder, by path, then title, score 1. */
  query: string;
  /**
   * A workspace-relative folder ("/apps/api"): only items attached at it or below, by any of their
   * paths. "/" is every item. Starts with "/", at most `KNOWLEDGE_SEARCH_PATH_MAX` characters.
   */
  path?: string;
  kinds?: KnowledgeKind[];
  limit?: number;
}

export interface KnowledgeSearchResponse {
  items: Array<KnowledgeListItem & { score: number }>;
}

/** The most results `knowledge.searchAll` returns (20 unless asked). */
export const KNOWLEDGE_SEARCH_ALL_LIMIT_MAX = 50;
/** The most workspaces one `knowledge.searchAll` searches; any past them are left out (`truncated`). */
export const KNOWLEDGE_SEARCH_ALL_WORKSPACES_MAX = 50;

/**
 * One search over every workspace the person can read: Local every workspace in the home, Pathrule
 * Cloud every workspace the person reads in the organization the route names. `query` and `path`
 * mean what they mean for `knowledge.search`, and items score and rank as there.
 */
export interface KnowledgeSearchAllRequest {
  query: string;
  path?: string;
  kinds?: KnowledgeKind[];
  limit?: number;
}

export type KnowledgeSearchAllItem = KnowledgeListItem & {
  score: number;
  workspaceId: string;
  workspaceName: string;
};

export interface KnowledgeSearchAllResponse {
  /** Best first across workspaces, at most `limit`. */
  items: KnowledgeSearchAllItem[];
  /**
   * The search stopped at a bound and may have missed matches: more workspaces than
   * `KNOWLEDGE_SEARCH_ALL_WORKSPACES_MAX`, a workspace that could not be read, or (Pathrule Cloud)
   * more candidate items than one call ranks. A narrower query or folder finds them.
   */
  truncated: boolean;
}

export interface KnowledgeCreateRequest extends WorkspaceScoped {
  kind: KnowledgeKind;
  /** Workspace-relative folder path the item is owned by, e.g. "/" or "/src/api". */
  path: string;
  title: string;
  content: string;
  /** Rules only. */
  scopeType?: RuleScope;
  priority?: RulePriority;
  /** Skills only. */
  description?: string;
}

export interface KnowledgeUpdateRequest extends WorkspaceScoped {
  kind: KnowledgeKind;
  id: string;
  /** Optimistic concurrency: the version the edit was based on. */
  expectedVersionId: string;
  title?: string;
  content?: string;
  priority?: RulePriority;
  description?: string;
}

export interface KnowledgeDeleteRequest extends WorkspaceScoped {
  kind: KnowledgeKind;
  id: string;
  expectedVersionId?: string;
}

export interface KnowledgeRestoreRequest extends WorkspaceScoped {
  kind: KnowledgeKind;
  id: string;
}

/** A knowledge item by kind and id. */
export interface KnowledgeRef {
  kind: KnowledgeKind;
  id: string;
}

/** One topic: items the knowledge map groups by links and shared words, not by folder. */
export interface KnowledgeTopic {
  /** Stable while the topic keeps its anchor item (`rg_…`). */
  id: string;
  /** A model's short name for it, or null when no model named it: show `terms` instead. */
  name: string | null;
  /** The words that set it apart, most telling first (at most 3). */
  terms: string[];
  /** The folder most of it lives under. */
  homePath: string;
  items: KnowledgeRef[];
}

/** Whether the topics carry names, and why not. */
export type TopicNaming =
  | { status: "named"; model: string }
  /** Some names are still being made; ask again shortly. */
  | { status: "pending"; model: string }
  | { status: "off"; reason: string }
  | { status: "failed"; model: string; reason: string };

export interface KnowledgeTopicsResponse {
  /** "computing": the map is being built; ask again after `retryAfterMs`. */
  status: "ready" | "computing";
  retryAfterMs?: number;
  /** Largest first. */
  topics: KnowledgeTopic[];
  /** Root items with no topical edge: how the workspace works rather than what it is about. */
  conventions: KnowledgeRef[];
  naming: TopicNaming;
}

export interface KnowledgeHistoryRequest extends WorkspaceScoped {
  kind: KnowledgeKind;
  id: string;
}

export interface KnowledgeRevision {
  versionNumber: number;
  editedBy: KnowledgePerson | null;
  editedAt: string;
}

export interface KnowledgeHistoryResponse {
  /** Newest first, at most 20. */
  revisions: KnowledgeRevision[];
}

export interface KnowledgeWriteResponse {
  id: string;
  versionId: string | null;
  /** Whether the agents' hook index was refreshed after the write. */
  hookIndex: "synced" | "scheduled" | "failed";
}

/** The windows `activity.recent` answers for, in days ending now. */
export const ACTIVITY_WINDOWS = [7, 30, 90] as const;
export type ActivityWindow = (typeof ACTIVITY_WINDOWS)[number];

export interface ActivityRecentRequest extends WorkspaceScoped {
  limit?: number;
  /** Entries logged in the last `days` days only; with it `limit` may go up to 1,000. */
  days?: ActivityWindow;
}

/**
 * One entry an agent logged (`pathrule_log_activity`): what the agent says it did, not a
 * verified record. The fields past `createdAt` are optional: a backend fills what it keeps.
 */
export interface LocalActivityEntry {
  id: string;
  nodePath: string | null;
  domain: string | null;
  action: string | null;
  summary: string | null;
  createdAt: string;
  /** component, page, api, migration … as the agent classified it. */
  scope?: string | null;
  /** Lowercase keywords, at most 5. */
  subjects?: string[];
  /** Workspace-relative files the agent reported, at most 50. */
  files?: string[];
  /** The agent: claude-code, codex, cursor … */
  client?: string | null;
  /** The account the agent worked for (Cloud); null where the backend has one user (Local). */
  person?: KnowledgePerson | null;
}

export interface ActivityRecentResponse {
  entries: LocalActivityEntry[];
  /** More entries exist in the window than `limit` returned. */
  truncated?: boolean;
}

/** The windows `deliveries.stats` answers for, in days ending today (UTC). */
export const DELIVERY_STATS_WINDOWS = [7, 30, 90] as const;
export type DeliveryStatsWindow = (typeof DELIVERY_STATS_WINDOWS)[number];

export interface DeliveryStatsRequest extends WorkspaceScoped {
  days: DeliveryStatsWindow;
}

/** One UTC day of deliveries, by kind. A delivery is one item confirmed into one session. */
export interface DeliveryDay {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  memory: number;
  rule: number;
  skill: number;
}

/** One item's deliveries in the window and in the window before it. */
export interface DeliveryItemCount {
  kind: KnowledgeKind;
  id: string;
  count: number;
  previous: number;
}

export interface DeliveryStatsResponse {
  /** Every day of the window, oldest first, zero days included. */
  days: DeliveryDay[];
  /** All deliveries in the equally long window just before, for the change. */
  previousTotal: number;
  /** Items delivered in the window or the one before; any other item had none. */
  items: DeliveryItemCount[];
  /**
   * The earliest delivery in this window or the one before, or null when there is none: tells
   * "nothing recorded yet" from "quiet lately".
   */
  recordedSince: string | null;
}

export interface SignalsStatusResponse {
  status: RuntimeEventsStatus;
}

/** Every listed group of the workspace, declared points included, newest first. */
export interface SignalsGroupsResponse {
  groups: RuntimeEventGroup[];
  /** True when the workspace has more groups than one answer carries (`SIGNALS_GROUPS_MAX`). */
  truncated: boolean;
}

/** The most groups `signals.groups` returns; the store keeps at most 5,000 per workspace. */
export const SIGNALS_GROUPS_MAX = 1_000;

export interface SignalsGroupRequest extends WorkspaceScoped {
  groupId: string;
}

export interface SignalsGroupResponse {
  /** Null when the group does not exist or is no longer listed (retention). */
  group: RuntimeEventGroup | null;
  /** Corrections recorded and verification states reached, newest first (at most 50). */
  history: RuntimeEventHistoryEntry[];
}

/**
 * A person records that a fix shipped, so later releases verify it. A claim, never proof: the
 * group stays active until runtime evidence moves it.
 */
export interface SignalsCorrectionRequest extends WorkspaceScoped {
  groupId: string;
  /** The revision the person read; a changed group is refused (`revision_conflict`). */
  expectedRevision: number;
  /** One per attempt; repeating it changes nothing (`replayed`). */
  idempotencyKey: string;
  /** The release the fix was made against. Default: the group's latest release. */
  baselineRelease?: string;
  /** What was changed, at most 500 characters. */
  note?: string;
}

export type SignalsCorrectionResponse = RuntimeCorrectionResult;

/** Error body for any non-2xx answer. `code` is stable; `message` is for people. */
export interface LocalUiError {
  error: {
    code:
      | "bad_request"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "unavailable"
      | "payload_too_large"
      | "timeout"
      | "internal";
    message: string;
  };
}

/** Request and response shapes per route, for typed clients. */
export interface LocalUiRouteMap {
  session: { request: SessionRequest; response: SessionResponse };
  "runtime.status": { request: Record<string, never>; response: RuntimeStatusResponse };
  "workspaces.list": { request: Record<string, never>; response: WorkspacesListResponse };
  "workspaces.summary": { request: Record<string, never>; response: WorkspacesSummaryResponse };
  "workspaces.favorite": { request: WorkspaceFavoriteRequest; response: WorkspaceFavoriteResponse };
  "tree.get": { request: WorkspaceScoped; response: TreeGetResponse };
  "knowledge.list": { request: KnowledgeListRequest; response: KnowledgeListResponse };
  "knowledge.read": { request: KnowledgeReadRequest; response: KnowledgeReadResponse };
  "knowledge.search": { request: KnowledgeSearchRequest; response: KnowledgeSearchResponse };
  "knowledge.searchAll": {
    request: KnowledgeSearchAllRequest;
    response: KnowledgeSearchAllResponse;
  };
  "knowledge.create": { request: KnowledgeCreateRequest; response: KnowledgeWriteResponse };
  "knowledge.update": { request: KnowledgeUpdateRequest; response: KnowledgeWriteResponse };
  "knowledge.delete": { request: KnowledgeDeleteRequest; response: KnowledgeWriteResponse };
  "knowledge.restore": { request: KnowledgeRestoreRequest; response: KnowledgeWriteResponse };
  "knowledge.topics": { request: WorkspaceScoped; response: KnowledgeTopicsResponse };
  "knowledge.history": { request: KnowledgeHistoryRequest; response: KnowledgeHistoryResponse };
  "activity.recent": { request: ActivityRecentRequest; response: ActivityRecentResponse };
  "deliveries.stats": { request: DeliveryStatsRequest; response: DeliveryStatsResponse };
  "signals.status": { request: WorkspaceScoped; response: SignalsStatusResponse };
  "signals.groups": { request: WorkspaceScoped; response: SignalsGroupsResponse };
  "signals.group": { request: SignalsGroupRequest; response: SignalsGroupResponse };
  "signals.correction": { request: SignalsCorrectionRequest; response: SignalsCorrectionResponse };
}
