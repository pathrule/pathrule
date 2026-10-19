// SPDX-License-Identifier: Apache-2.0
// The routes of the Local Console's API (@pathrule/protocol/local-ui-api.ts), answered from the
// home's local stores through the Pathrule host. Nothing here opens a store: every read and write is
// a call on the host session's remote store, and the host stamps writes with the local principal it
// resolved itself. A request never names a person, and fields a route does not take are refused.
//
// Every workspace-scoped route first checks the id against the home's local workspaces
// (`workspace.list`, which never lists a mirror of a hosted workspace): any other id is 404 before
// the host is asked to open anything. A successful write refreshes the agents' hook index for that
// workspace (./hook-index.ts) and says honestly whether it did.
import { pathruleHome } from "@pathrule/core/storage/paths.js";
import { createTopicNamer } from "@pathrule/core/knowledge-map/topic-names.js";
import {
  readTopicNames,
  topicModelConfig,
  writeTopicNames,
} from "@pathrule/core/storage/topic-model-settings.js";
import { connectHost, HostClientError } from "@pathrule/host/client.js";
import type { HostSession } from "@pathrule/host/session.js";
import type { HostLocalWorkspaceSummary } from "@pathrule/protocol/host-rpc.js";
import {
  RUNTIME_CORRECTION_NOTE_MAX,
  RUNTIME_EVENTS_MAX_LIMIT,
  type RuntimeEventGroup,
} from "@pathrule/protocol/runtime-events.js";
import { MAX_RELEASE_LENGTH } from "@pathrule/protocol/runtime-events-wire.js";
import { buildDeliveryStats, isDeliveryStatsWindow } from "@pathrule/protocol/delivery-stats.js";
import { readWorkspaceKnowledgeDeliveries } from "@pathrule/integrations/native/delivery-ledger.js";
import {
  LOCAL_UI_API_VERSION,
  SIGNALS_GROUPS_MAX,
  type DeliveryStatsResponse,
  type KnowledgeSearchAllResponse,
  type KnowledgeWriteResponse,
  type LocalCapabilities,
  type RuntimeStatusResponse,
  type SignalsCorrectionResponse,
  type SignalsGroupResponse,
  type SignalsGroupsResponse,
  type SignalsStatusResponse,
  type WorkspaceFavoriteResponse,
  type WorkspacesListResponse,
  type WorkspacesSummaryResponse,
} from "@pathrule/protocol/local-ui-api.js";

import {
  createWorkspaceRoutes,
  workspacePath as sharedWorkspacePath,
} from "@pathrule/core/local-ui/workspace-routes.js";
import { searchAllWorkspaces } from "@pathrule/core/local-ui/search-all-route.js";
import type { HookIndexRefresher } from "./hook-index.js";
import { LocalUiApiError, type LocalUiApi, type LocalUiApiRoute } from "./server.js";
import {
  FavoritesFullError,
  glanceWorkspace,
  glanceWorkspaces,
  readFavorites,
  setFavorite,
} from "./workspace-directory.js";

export const SEMANTIC_UNAVAILABLE_REASON = "Needs an embedding key (bring your own key).";
export const TOPIC_NAMES_OFF_REASON =
  "No model names topics on this machine. Connect one with `pathrule topics use`.";
export const HISTORY_UNAVAILABLE_REASON = "Pathrule Local keeps no history of edits.";
export const RUNTIME_EVENTS_HOST_TOO_OLD =
  "The running Pathrule host predates runtime events. Stop it with `pathrule host stop`, then run `pathrule ui` again.";
/** Who a correction recorded here names: the surface, never a person. */
export const LOCAL_CONSOLE_ACTOR = "Local Console";
const GROUP_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ATTEMPT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** How long the workspace listing is reused before the home is read again. */
const LISTING_TTL_MS = 3_000;

export interface LocalUiApiDependencies {
  session: HostSession;
  env: NodeJS.ProcessEnv;
  /** The folder `pathrule ui` started in. */
  cwd: string;
  cliVersion: string;
  hookIndex: HookIndexRefresher;
  now?: () => number;
}

const bad = (message: string) => new LocalUiApiError("bad_request", message);
const notFound = (message: string) => new LocalUiApiError("not_found", message);

// ── request validation ────────────────────────────────────────────────────────

/** The body's fields, refusing any the route does not take. */
function fields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw bad(`Unknown field "${key}".`);
  }
  return body;
}

function text(
  value: unknown,
  name: string,
  options: { max?: number; allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") throw bad(`${name} must be a string.`);
  if (!options.allowEmpty && value.trim().length === 0) throw bad(`${name} must not be empty.`);
  if (options.max !== undefined && value.length > options.max) {
    throw bad(`${name} is longer than ${options.max} characters.`);
  }
  return value;
}

function optionalText(
  value: unknown,
  name: string,
  options: { max?: number; allowEmpty?: boolean } = {},
): string | undefined {
  return value === undefined ? undefined : text(value, name, options);
}

function id(value: unknown, name = "id"): string {
  return text(value, name, { max: 128 });
}

function integer(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw bad(`${name} must be an integer.`);
  }
  return value;
}

/**
 * A workspace-relative folder path: starts with "/", no "." or ".." segment, no backslash, no
 * control character. Returned without repeated or trailing slashes ("/" for the root).
 */
export function workspacePath(value: unknown): string {
  return sharedWorkspacePath(value, bad);
}

// ── store answers ───────────────────────────────────────────────────────────

/** A host older than runtime events answers their methods with "the store has no method". */
function isMissingStoreMethod(err: unknown): boolean {
  return err instanceof Error && /the store has no method "/.test(err.message);
}

/** A runtime events call, with an older host's refusal as the API's `unavailable`. */
async function runtimeEvents<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (isMissingStoreMethod(err)) {
      throw new LocalUiApiError("unavailable", RUNTIME_EVENTS_HOST_TOO_OLD);
    }
    throw err;
  }
}

/** The host's own failures: an API error passes through, an unreachable host is `unavailable`. */
function hostFailure(err: unknown): void {
  if (err instanceof LocalUiApiError) throw err;
  if (err instanceof HostClientError && err.code === "unreachable") {
    const message = err instanceof Error ? err.message : String(err);
    throw new LocalUiApiError("unavailable", `The Pathrule host is not answering: ${message}`);
  }
}

/** A store error as the API's: a version conflict is 409, a missing item 404. */
function storeFailure(err: unknown): never {
  hostFailure(err);
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("content_version_conflict")) {
    throw new LocalUiApiError(
      "conflict",
      "This item changed since it was read. Read it again and reapply the edit.",
    );
  }
  // The store's own wording: "memory <id> not found".
  if (/^(memory|rule|skill) \S+ not found$/.test(message)) throw notFound(message);
  throw err;
}

// ── the API ─────────────────────────────────────────────────────────────────

export function createLocalUiApi(deps: LocalUiApiDependencies): LocalUiApi {
  const now = deps.now ?? Date.now;
  let listing: { at: number; workspaces: HostLocalWorkspaceSummary[] } | null = null;

  async function workspaces(fresh = false): Promise<HostLocalWorkspaceSummary[]> {
    if (!fresh && listing && now() - listing.at < LISTING_TTL_MS) return listing.workspaces;
    const listed = await deps.session.listWorkspaces();
    listing = { at: now(), workspaces: listed };
    return listed;
  }

  /** The workspace `value` names, when it is one of the home's local workspaces; 404 otherwise. */
  async function workspace(value: unknown): Promise<HostLocalWorkspaceSummary> {
    const workspaceId = id(value, "workspaceId");
    const found =
      (await workspaces()).find((w) => w.id === workspaceId) ??
      (await workspaces(true)).find((w) => w.id === workspaceId);
    if (!found) throw notFound("No local workspace has this id.");
    return found;
  }

  function currentWorkspaceId(listed: readonly HostLocalWorkspaceSummary[]): string | null {
    const match = deps.session.resolveLocal(deps.cwd);
    if (!match || match.mirror) return null;
    return listed.some((w) => w.id === match.workspaceId) ? match.workspaceId : null;
  }

  async function written(
    target: HostLocalWorkspaceSummary,
    itemId: string,
    versionId: string | null,
  ): Promise<KnowledgeWriteResponse> {
    const hookIndex = await deps.hookIndex.refresh({ id: target.id, rootPath: target.rootPath });
    return { id: itemId, versionId, hookIndex };
  }

  const workspaceRoutes = createWorkspaceRoutes<HostLocalWorkspaceSummary>({
    workspace,
    store: (target) => deps.session.store(target.id),
    written,
    errors: { bad, notFound, conflict: (message) => new LocalUiApiError("conflict", message) },
    storeFailure: hostFailure,
    // Topics are grouped on this machine; a model the person connected names them, if any.
    topicNames: () => {
      const config = topicModelConfig(deps.env);
      return {
        namer: config ? createTopicNamer(config) : null,
        offReason: TOPIC_NAMES_OFF_REASON,
        read: (workspaceId) => readTopicNames(workspaceId, deps.env),
        write: (workspaceId, cache) => writeTopicNames(workspaceId, cache, deps.env),
      };
    },
    unavailable: (message) => new LocalUiApiError("unavailable", message),
  });

  const routes: Record<LocalUiApiRoute, (body: Record<string, unknown>) => Promise<unknown>> = {
    async "runtime.status"(body): Promise<RuntimeStatusResponse> {
      fields(body, []);
      // Listing first: it goes through the session, which starts over on a host that went away.
      const listed = await workspaces(true);
      const mode = await deps.session.mode();
      let host: RuntimeStatusResponse["host"] = {
        mode,
        version: null,
        pid: null,
        plugins: [],
      };
      if (mode !== "degraded") {
        const client =
          (await deps.session.client()) ?? (await connectHost({ env: deps.env }).catch(() => null));
        const hello = await client?.call("host.hello", {}).catch(() => null);
        if (hello) {
          host = {
            mode,
            version: hello.version,
            pid: hello.pid,
            plugins: hello.plugins.filter((p) => p.state === "active").map((p) => p.name),
          };
        }
      }
      const current = currentWorkspaceId(listed);
      const probe = current ?? listed[0]?.id ?? null;
      const probeStore = probe ? await deps.session.store(probe) : null;
      const semantic = probeStore ? probeStore.capabilities().semantic === true : false;
      let runtimeEventsCapability: LocalCapabilities["runtimeEvents"] = { available: true };
      if (probeStore && probe) {
        try {
          await probeStore.runtimeEventStatus(probe);
        } catch (err) {
          if (!isMissingStoreMethod(err)) throw err;
          runtimeEventsCapability = { available: false, reason: RUNTIME_EVENTS_HOST_TOO_OLD };
        }
      }
      const capabilities: LocalCapabilities = {
        knowledgeRead: { available: true },
        knowledgeWrite: { available: true },
        search: { available: true },
        // Every workspace in this home, through the host like every other read.
        searchAll: { available: true },
        semanticSearch: semantic
          ? { available: true }
          : { available: false, reason: SEMANTIC_UNAVAILABLE_REASON },
        activity: { available: true },
        runtimeEvents: runtimeEventsCapability,
        // Counted from this machine's session ledgers; nothing to probe, no account needed.
        deliveryStats: { available: true },
        workspaceSummary: { available: true },
        knowledgeTopics: { available: true },
        knowledgeHistory: { available: false, reason: HISTORY_UNAVAILABLE_REASON },
        // Kept in the Pathrule home (./workspace-directory.ts): this machine's, no account.
        favorites: { available: true },
      };
      return {
        edition: "local",
        account: "none",
        apiVersion: LOCAL_UI_API_VERSION,
        cliVersion: deps.cliVersion,
        host,
        home: pathruleHome(deps.env),
        currentWorkspaceId: current,
        capabilities,
      };
    },

    async "workspaces.list"(body): Promise<WorkspacesListResponse> {
      fields(body, []);
      const listed = await workspaces(true);
      const current = currentWorkspaceId(listed);
      return {
        workspaces: listed.map((w) => ({
          id: w.id,
          name: w.name,
          rootPath: w.rootPath,
          current: w.id === current,
        })),
      };
    },

    async "workspaces.summary"(body): Promise<WorkspacesSummaryResponse> {
      fields(body, []);
      const listed = await workspaces(true);
      const at = now();
      const [summaries, favorites] = await Promise.all([
        glanceWorkspaces(
          listed.map((w) => w.id),
          async (workspaceId) =>
            glanceWorkspace(await deps.session.store(workspaceId), workspaceId, deps.env, at),
        ),
        readFavorites(deps.env),
      ]);
      const known = new Set(listed.map((w) => w.id));
      return { workspaces: summaries, favorites: favorites.filter((id) => known.has(id)) };
    },

    async "workspaces.favorite"(body): Promise<WorkspaceFavoriteResponse> {
      const input = fields(body, ["workspaceId", "favorite"]);
      const target = await workspace(input.workspaceId);
      if (typeof input.favorite !== "boolean") throw bad("favorite must be true or false.");
      const known = new Set((await workspaces()).map((w) => w.id));
      try {
        return { favorites: await setFavorite(deps.env, target.id, input.favorite, known) };
      } catch (err) {
        if (err instanceof FavoritesFullError) throw new LocalUiApiError("conflict", err.message);
        throw err;
      }
    },

    // The workspace routes (tree, knowledge, search, topics, activity) are shared with Pathrule Cloud.
    ...workspaceRoutes,

    // One search over every local workspace of the home, ranked as `knowledge.search` ranks.
    async "knowledge.searchAll"(body): Promise<KnowledgeSearchAllResponse> {
      const listed = await workspaces(true);
      return searchAllWorkspaces(body, {
        workspaces: listed,
        store: (workspaceId) => deps.session.store(workspaceId),
        bad,
      });
    },

    async "knowledge.history"(): Promise<never> {
      throw new LocalUiApiError("unavailable", HISTORY_UNAVAILABLE_REASON);
    },

    // Read from this machine's session ledgers, never from the host's stores: each backend counts
    // its own deliveries (Pathrule Cloud from what its clients report).
    async "deliveries.stats"(body): Promise<DeliveryStatsResponse> {
      const input = fields(body, ["workspaceId", "days"]);
      const target = await workspace(input.workspaceId);
      if (!isDeliveryStatsWindow(input.days)) throw bad("days must be 7, 30 or 90.");
      const now = (deps.now ?? Date.now)();
      const since = now - 2 * input.days * 86_400_000;
      const deliveries = await readWorkspaceKnowledgeDeliveries(target.id, since, deps.env);
      return buildDeliveryStats(deliveries, input.days, now);
    },

    async "signals.status"(body): Promise<SignalsStatusResponse> {
      const input = fields(body, ["workspaceId"]);
      const target = await workspace(input.workspaceId);
      const store = await deps.session.store(target.id);
      return { status: await runtimeEvents(() => store.runtimeEventStatus(target.id)) };
    },

    async "signals.groups"(body): Promise<SignalsGroupsResponse> {
      const input = fields(body, ["workspaceId"]);
      const target = await workspace(input.workspaceId);
      const store = await deps.session.store(target.id);
      const groups: RuntimeEventGroup[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await runtimeEvents(() =>
          store.listRuntimeEventGroups(target.id, { limit: RUNTIME_EVENTS_MAX_LIMIT, cursor }),
        );
        if ("error" in page) throw new Error(`runtime events could not be read: ${page.error}`);
        groups.push(...page.items);
        if (!page.nextCursor) return { groups, truncated: false };
        if (groups.length >= SIGNALS_GROUPS_MAX) {
          return { groups: groups.slice(0, SIGNALS_GROUPS_MAX), truncated: true };
        }
        cursor = page.nextCursor;
      }
    },

    async "signals.group"(body): Promise<SignalsGroupResponse> {
      const input = fields(body, ["workspaceId", "groupId"]);
      const target = await workspace(input.workspaceId);
      const groupId = id(input.groupId, "groupId");
      if (!GROUP_ID.test(groupId)) throw bad("groupId is not a runtime event group id.");
      const store = await deps.session.store(target.id);
      const page = await runtimeEvents(() =>
        store.listRuntimeEventGroups(target.id, { groupId, limit: 1 }),
      );
      if ("error" in page) throw new Error(`runtime events could not be read: ${page.error}`);
      return { group: page.items[0] ?? null, history: page.history ?? [] };
    },

    async "signals.correction"(body): Promise<SignalsCorrectionResponse> {
      const input = fields(body, [
        "workspaceId",
        "groupId",
        "expectedRevision",
        "idempotencyKey",
        "baselineRelease",
        "note",
      ]);
      const target = await workspace(input.workspaceId);
      const groupId = id(input.groupId, "groupId");
      if (!GROUP_ID.test(groupId)) throw bad("groupId is not a runtime event group id.");
      const expectedRevision = integer(input.expectedRevision, "expectedRevision");
      if (expectedRevision === undefined || expectedRevision < 1) {
        throw bad("expectedRevision must be the group's revision as read.");
      }
      const idempotencyKey = id(input.idempotencyKey, "idempotencyKey");
      if (!ATTEMPT_ID.test(idempotencyKey)) {
        throw bad("idempotencyKey may hold letters, digits and . _ : - only.");
      }
      const baselineRelease = optionalText(input.baselineRelease, "baselineRelease", {
        max: MAX_RELEASE_LENGTH,
      });
      const note = optionalText(input.note, "note", {
        max: RUNTIME_CORRECTION_NOTE_MAX,
        allowEmpty: true,
      });
      const store = await deps.session.store(target.id);
      return runtimeEvents(() =>
        store.recordRuntimeCorrection(target.id, {
          groupId,
          expectedRevision,
          idempotencyKey,
          baselineRelease: baselineRelease?.trim() ? baselineRelease.trim() : undefined,
          note: note?.trim() ? note.trim() : undefined,
          actor: LOCAL_CONSOLE_ACTOR,
        }),
      );
    },
  };

  return {
    async handle(route, body) {
      const answer = routes[route];
      if (!answer) throw notFound(`No route "${route}".`);
      try {
        return await answer(body);
      } catch (err) {
        storeFailure(err);
      }
    },
  };
}
