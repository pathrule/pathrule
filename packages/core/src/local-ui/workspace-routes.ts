// SPDX-License-Identifier: Apache-2.0
// The workspace routes of the Local UI API (@pathrule/protocol/local-ui-api.ts) over any knowledge
// backend: the tree, memories, rules and skills, search and recent activity. `pathrule ui` serves them
// from the home's stores through the host (packages/cli/src/local/ui/api.ts) and Pathrule Cloud from
// its D1 Project backend, so the Local Console and the Cloud console show the same pages from the same
// answers. The host resolves and authorizes the workspace, names its errors and says what a write
// means for agents; everything else is decided here.
import type {
  Memory,
  Rule,
  RulePriority,
  RuleScope,
  Skill,
} from "@pathrule/protocol/content-types.js";
import type {
  ActivityRecentResponse,
  KnowledgeKind,
  KnowledgeListItem,
  KnowledgeListResponse,
  KnowledgePerson,
  KnowledgeReadResponse,
  KnowledgeRecord,
  KnowledgeSearchResponse,
  KnowledgeTopicsResponse,
  KnowledgeWriteResponse,
  TreeGetResponse,
} from "@pathrule/protocol/local-ui-api.js";
import type { KnowledgeBackend } from "../backend/knowledge-backend.js";
import { isActivityWindow, recentActivity } from "./activity-route.js";
import { parseKnowledgeSearch, preview, rankKnowledge, workspacePath } from "./knowledge-query.js";
import { knowledgeTopics, TopicsUnavailableError, type TopicNames } from "./topic-route.js";

// How a search reads and ranks, shared with `knowledge.searchAll` and Pathrule Cloud.
export { clampLimit, preview, scoreItem, workspacePath } from "./knowledge-query.js";

/** What the routes need from a store; the host's remote store and Cloud's Project backend both have it. */
export type WorkspaceRouteStore = Pick<
  KnowledgeBackend,
  | "getTree"
  | "workspaceOverview"
  | "getNodeForRule"
  | "getNodeForSkill"
  | "ensureNodeForPath"
  | "listMemories"
  | "listRules"
  | "listSkills"
  | "readMemory"
  | "readRule"
  | "readSkill"
  | "writeMemory"
  | "writeRule"
  | "writeSkill"
  | "updateMemory"
  | "updateRule"
  | "updateSkill"
  | "deleteMemory"
  | "deleteRule"
  | "deleteSkill"
  | "restoreMemory"
  | "restoreRule"
  | "restoreSkill"
  | "recentActivities"
  | "buildKnowledgeMapInput"
  | "knowledgeMapFingerprint"
>;

export type WorkspaceRoute =
  | "tree.get"
  | "knowledge.list"
  | "knowledge.read"
  | "knowledge.search"
  | "knowledge.create"
  | "knowledge.update"
  | "knowledge.delete"
  | "knowledge.restore"
  | "knowledge.topics"
  | "activity.recent";

export const WORKSPACE_ROUTES: readonly WorkspaceRoute[] = [
  "tree.get",
  "knowledge.list",
  "knowledge.read",
  "knowledge.search",
  "knowledge.create",
  "knowledge.update",
  "knowledge.delete",
  "knowledge.restore",
  "knowledge.topics",
  "activity.recent",
];

/** How the host refuses a request; each answers with its own error type and status. */
export interface WorkspaceRouteErrors {
  bad(message: string): Error;
  notFound(message: string): Error;
  conflict(message: string): Error;
}

/**
 * A workspace as the host resolved it. Local's carries the folder it is bound to, so the files an
 * activity reports under it can be shown relative to it; Cloud's does not know one.
 */
export type WorkspaceRouteTarget = { id: string; rootPath?: string | null };

export interface WorkspaceRouteDependencies<Target extends WorkspaceRouteTarget> {
  /** The workspace a request names, resolved and authorized by the host (404 or 403 otherwise). */
  workspace(value: unknown): Promise<Target>;
  store(target: Target): Promise<WorkspaceRouteStore>;
  /** The answer to a successful write: the host says when agents receive it. */
  written(
    target: Target,
    itemId: string,
    versionId: string | null,
  ): Promise<KnowledgeWriteResponse>;
  errors: WorkspaceRouteErrors;
  /** A host-specific store failure (an unreachable host), checked before the shared ones. */
  storeFailure?(err: unknown): void;
  /**
   * Display names for the ids items record as their author. Without it an id is its own name:
   * Local records its user's name itself.
   */
  people?(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** Where topic names are kept and which model makes them; null names none. */
  topicNames?(target: Target): TopicNames | null;
  /** The answer when the store builds no knowledge map. */
  unavailable?(message: string): Error;
}

const KINDS: readonly KnowledgeKind[] = ["memory", "rule", "skill"];
const SCOPES: readonly RuleScope[] = ["folder", "file_type", "project"];
const PRIORITIES: readonly RulePriority[] = ["high", "medium", "low"];
const MAX_TITLE_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 2_000;

// ── items and their paths ───────────────────────────────────────────────────

function normalizedNodePath(path: string | null | undefined): string | null {
  if (path === null || path === undefined) return null;
  return path === "" ? "/" : path;
}

export type AnyItem =
  | { kind: "memory"; item: Memory }
  | { kind: "rule"; item: Rule }
  | { kind: "skill"; item: Skill };

/** Where the items of one workspace live: node ids to paths, rule and skill ids to their paths. */
export interface PathIndex {
  nodes: Map<string, string>;
  rules: Map<string, string[]>;
  skills: Map<string, string[]>;
}

export async function pathIndex(
  store: WorkspaceRouteStore,
  workspaceId: string,
): Promise<PathIndex> {
  const [tree, overview] = await Promise.all([
    store.getTree(workspaceId),
    store.workspaceOverview(workspaceId),
  ]);
  const nodes = new Map<string, string>();
  for (const node of tree) nodes.set(node.id, normalizedNodePath(node.relativePath) ?? "/");
  const rules = new Map<string, string[]>();
  const skills = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, itemId: string, path: string) => {
    const list = map.get(itemId) ?? [];
    if (!list.includes(path)) list.push(path);
    map.set(itemId, list);
  };
  for (const node of overview) {
    const path = normalizedNodePath(node.relative_path) ?? "/";
    for (const rule of node.rules) add(rules, rule.id, path);
    for (const skill of node.skills) add(skills, skill.id, path);
  }
  for (const list of [...rules.values(), ...skills.values()]) list.sort();
  return { nodes, rules, skills };
}

/** The paths a rule or skill is attached to; the store's own answer when the overview lacks it. */
export async function attachedPaths(
  store: WorkspaceRouteStore,
  index: PathIndex,
  kind: "rule" | "skill",
  itemId: string,
): Promise<string[]> {
  const known = (kind === "rule" ? index.rules : index.skills).get(itemId);
  if (known && known.length > 0) return known;
  // An archived item, or one attached to a node the overview leaves out.
  const node =
    kind === "rule" ? await store.getNodeForRule(itemId) : await store.getNodeForSkill(itemId);
  const path = normalizedNodePath(node?.relativePath);
  return path ? [path] : [];
}

async function listItem(
  store: WorkspaceRouteStore,
  index: PathIndex,
  entry: AnyItem,
): Promise<KnowledgeListItem> {
  if (entry.kind === "memory") {
    const memory = entry.item;
    return {
      id: memory.id,
      kind: "memory",
      title: memory.title,
      preview: preview(memory.content),
      path: index.nodes.get(memory.nodeId) ?? null,
      updatedAt: memory.updatedAt,
      versionNumber: memory.versionNumber,
      ...(typeof memory.usageCount30d === "number" ? { usageCount30d: memory.usageCount30d } : {}),
      ...authorship(memory),
      paths: index.nodes.has(memory.nodeId) ? [index.nodes.get(memory.nodeId)!] : [],
      addedVia: memory.source === "claude" ? "agent" : "person",
    };
  }
  if (entry.kind === "rule") {
    const rule = entry.item;
    const paths = await attachedPaths(store, index, "rule", rule.id);
    return {
      id: rule.id,
      kind: "rule",
      title: rule.name,
      preview: preview(rule.content),
      path: paths[0] ?? null,
      updatedAt: rule.updatedAt,
      versionNumber: rule.versionNumber,
      priority: rule.priority,
      scopeType: rule.scopeType,
      ...(typeof rule.usageCount30d === "number" ? { usageCount30d: rule.usageCount30d } : {}),
      ...authorship(rule),
      paths,
      addedVia: null,
    };
  }
  const skill = entry.item;
  const paths = await attachedPaths(store, index, "skill", skill.id);
  return {
    id: skill.id,
    kind: "skill",
    title: skill.name,
    preview: preview(skill.content || skill.description || ""),
    path: paths[0] ?? null,
    updatedAt: skill.updatedAt,
    versionNumber: skill.versionNumber,
    tags: skill.tags ?? [],
    ...authorship(skill),
    paths,
    addedVia: null,
  };
}

/** Who added and last edited an item, as ids for now; `named` gives them names. */
function authorship(item: {
  createdBy: string | null;
  lastEditedBy: string | null;
  createdAt: string;
}): Pick<KnowledgeListItem, "createdBy" | "lastEditedBy" | "createdAt"> {
  const person = (id: string | null): KnowledgePerson | null => (id ? { id, name: id } : null);
  return {
    createdBy: person(item.createdBy),
    lastEditedBy: person(item.lastEditedBy),
    createdAt: item.createdAt,
  };
}

/** The items with their authors' display names, when the backend can tell them. */
export async function named(
  items: KnowledgeListItem[],
  people: ((ids: readonly string[]) => Promise<ReadonlyMap<string, string>>) | undefined,
): Promise<KnowledgeListItem[]> {
  if (!people) return items;
  const ids = new Set<string>();
  for (const item of items) {
    if (item.createdBy) ids.add(item.createdBy.id);
    if (item.lastEditedBy) ids.add(item.lastEditedBy.id);
  }
  if (ids.size === 0) return items;
  const names = await people([...ids]);
  const rename = (person: KnowledgePerson | null | undefined) =>
    person ? { id: person.id, name: names.get(person.id) ?? person.name } : (person ?? null);
  return items.map((item) => ({
    ...item,
    createdBy: rename(item.createdBy),
    lastEditedBy: rename(item.lastEditedBy),
  }));
}

export async function listEntries(
  store: WorkspaceRouteStore,
  workspaceId: string,
  kind: KnowledgeKind,
  status: "active" | "archived",
): Promise<AnyItem[]> {
  if (kind === "memory") {
    return (await store.listMemories({ workspaceId, status })).map((item) => ({
      kind: "memory" as const,
      item,
    }));
  }
  if (kind === "rule") {
    return (await store.listRules({ workspaceId, status })).map((item) => ({
      kind: "rule" as const,
      item,
    }));
  }
  return (await store.listSkills({ workspaceId, status })).map((item) => ({
    kind: "skill" as const,
    item,
  }));
}

export async function listItems(
  store: WorkspaceRouteStore,
  workspaceId: string,
  kinds: readonly KnowledgeKind[],
  status: "active" | "archived",
): Promise<KnowledgeListItem[]> {
  const [index, ...batches] = await Promise.all([
    pathIndex(store, workspaceId),
    ...kinds.map((kind) => listEntries(store, workspaceId, kind, status)),
  ]);
  const items = await Promise.all(
    (batches as AnyItem[][]).flat().map((entry) => listItem(store, index as PathIndex, entry)),
  );
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The active item of `kind` with `itemId` in `workspaceId`, or null. */
export async function readActive(
  store: WorkspaceRouteStore,
  workspaceId: string,
  kind: KnowledgeKind,
  itemId: string,
): Promise<AnyItem | null> {
  const entry: AnyItem | null =
    kind === "memory"
      ? wrap("memory", await store.readMemory(itemId))
      : kind === "rule"
        ? wrap("rule", await store.readRule(itemId))
        : wrap("skill", await store.readSkill(itemId));
  return entry && entry.item.workspaceId === workspaceId ? entry : null;
}

function wrap(kind: "memory", item: Memory | null): AnyItem | null;
function wrap(kind: "rule", item: Rule | null): AnyItem | null;
function wrap(kind: "skill", item: Skill | null): AnyItem | null;
function wrap(kind: KnowledgeKind, item: Memory | Rule | Skill | null): AnyItem | null {
  return item ? ({ kind, item } as AnyItem) : null;
}

// ── the routes ──────────────────────────────────────────────────────────────

export type WorkspaceRouteHandlers = Record<
  WorkspaceRoute,
  (body: Record<string, unknown>) => Promise<unknown>
>;

export function createWorkspaceRoutes<Target extends WorkspaceRouteTarget>(
  deps: WorkspaceRouteDependencies<Target>,
): WorkspaceRouteHandlers {
  const { bad, notFound, conflict } = deps.errors;

  /** The body's fields, refusing any the route does not take. */
  const fields = (body: Record<string, unknown>, allowed: readonly string[]) => {
    for (const key of Object.keys(body)) {
      if (!allowed.includes(key)) throw bad(`Unknown field "${key}".`);
    }
    return body;
  };
  const text = (
    value: unknown,
    name: string,
    options: { max?: number; allowEmpty?: boolean } = {},
  ): string => {
    if (typeof value !== "string") throw bad(`${name} must be a string.`);
    if (!options.allowEmpty && value.trim().length === 0) throw bad(`${name} must not be empty.`);
    if (options.max !== undefined && value.length > options.max) {
      throw bad(`${name} is longer than ${options.max} characters.`);
    }
    return value;
  };
  const optionalText = (
    value: unknown,
    name: string,
    options: { max?: number; allowEmpty?: boolean } = {},
  ): string | undefined => (value === undefined ? undefined : text(value, name, options));
  const oneOf = <T extends string>(value: unknown, name: string, allowed: readonly T[]): T => {
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      throw bad(`${name} must be one of ${allowed.join(", ")}.`);
    }
    return value as T;
  };
  const kindOf = (value: unknown): KnowledgeKind => oneOf(value, "kind", KINDS);
  const id = (value: unknown, name = "id"): string => text(value, name, { max: 128 });
  const integer = (value: unknown, name: string): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw bad(`${name} must be an integer.`);
    }
    return value;
  };
  const folder = (value: unknown): string => workspacePath(value, bad);

  /** A store error as the API's: a version conflict is 409, a missing item 404. */
  const storeFailure = (err: unknown): never => {
    deps.storeFailure?.(err);
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("content_version_conflict")) {
      throw conflict("This item changed since it was read. Read it again and reapply the edit.");
    }
    // The store's own wording: "memory <id> not found".
    if (/^(memory|rule|skill) \S+ not found$/.test(message)) throw notFound(message);
    throw err;
  };

  async function scoped(value: unknown) {
    const target = await deps.workspace(value);
    return { target, store: await deps.store(target) };
  }

  return {
    async "tree.get"(body): Promise<TreeGetResponse> {
      const { target, store } = await scoped(fields(body, ["workspaceId"]).workspaceId);
      return { nodes: await store.getTree(target.id) };
    },

    async "knowledge.list"(body): Promise<KnowledgeListResponse> {
      const input = fields(body, ["workspaceId", "kind", "status"]);
      const { target, store } = await scoped(input.workspaceId);
      const kind = kindOf(input.kind);
      const status =
        input.status === undefined
          ? "active"
          : oneOf(input.status, "status", ["active", "archived"] as const);
      return { items: await named(await listItems(store, target.id, [kind], status), deps.people) };
    },

    async "knowledge.read"(body): Promise<KnowledgeReadResponse> {
      const input = fields(body, ["workspaceId", "kind", "id"]);
      const { target, store } = await scoped(input.workspaceId);
      const kind = kindOf(input.kind);
      const itemId = id(input.id);
      // An archived item is readable too, so the console can show what a restore brings back.
      const entry =
        (await readActive(store, target.id, kind, itemId)) ??
        (await listEntries(store, target.id, kind, "archived")).find((e) => e.item.id === itemId) ??
        null;
      if (!entry) return { record: null };
      const index = await pathIndex(store, target.id);
      let record: KnowledgeRecord;
      if (entry.kind === "memory") {
        record = { ...entry, path: index.nodes.get(entry.item.nodeId) ?? null };
      } else {
        record = { ...entry, paths: await attachedPaths(store, index, entry.kind, entry.item.id) };
      }
      return { record };
    },

    // With `path` only items attached at that folder or below, and an empty query lists them all.
    async "knowledge.search"(body): Promise<KnowledgeSearchResponse> {
      const input = fields(body, ["workspaceId", "query", "path", "kinds", "limit"]);
      const { target, store } = await scoped(input.workspaceId);
      const search = parseKnowledgeSearch(input, bad, 100);
      const ranked = rankKnowledge(
        await listItems(store, target.id, search.kinds, "active"),
        search,
      );
      return { items: (await named(ranked.slice(0, search.limit), deps.people)) as typeof ranked };
    },

    async "knowledge.topics"(body): Promise<KnowledgeTopicsResponse> {
      const { target, store } = await scoped(fields(body, ["workspaceId"]).workspaceId);
      try {
        return await knowledgeTopics(store, target.id, deps.topicNames?.(target) ?? null);
      } catch (err) {
        if (err instanceof TopicsUnavailableError) {
          throw (deps.unavailable ?? notFound)(err.message);
        }
        throw err;
      }
    },

    async "knowledge.create"(body): Promise<KnowledgeWriteResponse> {
      const input = fields(body, [
        "workspaceId",
        "kind",
        "path",
        "title",
        "content",
        "scopeType",
        "priority",
        "description",
      ]);
      const { target, store } = await scoped(input.workspaceId);
      const kind = kindOf(input.kind);
      const path = folder(input.path);
      const title = text(input.title, "title", { max: MAX_TITLE_CHARS }).trim();
      const content = text(input.content, "content");
      if (kind !== "rule" && (input.scopeType !== undefined || input.priority !== undefined)) {
        throw bad("scopeType and priority apply to rules only.");
      }
      if (kind !== "skill" && input.description !== undefined) {
        throw bad("description applies to skills only.");
      }
      const scopeType =
        input.scopeType === undefined ? undefined : oneOf(input.scopeType, "scopeType", SCOPES);
      const priority =
        input.priority === undefined ? undefined : oneOf(input.priority, "priority", PRIORITIES);
      const description = optionalText(input.description, "description", {
        max: MAX_DESCRIPTION_CHARS,
        allowEmpty: true,
      });
      try {
        const node = await store.ensureNodeForPath(target.id, path);
        if (kind === "memory") {
          const memory = await store.writeMemory({
            workspaceId: target.id,
            nodeId: node.id,
            title,
            content,
            source: "manual",
          });
          return deps.written(target, memory.id, memory.versionId);
        }
        if (kind === "rule") {
          const rule = await store.writeRule({
            workspaceId: target.id,
            nodeId: node.id,
            name: title,
            content,
            scopeType: scopeType ?? "folder",
            ...(priority ? { priority } : {}),
          });
          return deps.written(target, rule.id, rule.versionId);
        }
        const skill = await store.writeSkill({
          workspaceId: target.id,
          nodeId: node.id,
          name: title,
          content,
          description: description?.trim() ? description : null,
          source: "manual",
        });
        return deps.written(target, skill.id, skill.versionId);
      } catch (err) {
        return storeFailure(err);
      }
    },

    async "knowledge.update"(body): Promise<KnowledgeWriteResponse> {
      const input = fields(body, [
        "workspaceId",
        "kind",
        "id",
        "expectedVersionId",
        "title",
        "content",
        "priority",
        "description",
      ]);
      const { target, store } = await scoped(input.workspaceId);
      const kind = kindOf(input.kind);
      const itemId = id(input.id);
      const expectedVersionId = id(input.expectedVersionId, "expectedVersionId");
      const title = optionalText(input.title, "title", { max: MAX_TITLE_CHARS })?.trim();
      const content = optionalText(input.content, "content");
      if (kind !== "rule" && input.priority !== undefined) {
        throw bad("priority applies to rules only.");
      }
      if (kind !== "skill" && input.description !== undefined) {
        throw bad("description applies to skills only.");
      }
      const priority =
        input.priority === undefined ? undefined : oneOf(input.priority, "priority", PRIORITIES);
      const description = optionalText(input.description, "description", {
        max: MAX_DESCRIPTION_CHARS,
        allowEmpty: true,
      });
      if (
        title === undefined &&
        content === undefined &&
        priority === undefined &&
        description === undefined
      ) {
        throw bad("Nothing to update: give a title, content, priority or description.");
      }
      if (!(await readActive(store, target.id, kind, itemId))) {
        throw notFound(`No active ${kind} has this id in this workspace.`);
      }
      try {
        if (kind === "memory") {
          const memory = await store.updateMemory({
            id: itemId,
            expectedVersionId,
            ...(title !== undefined ? { title } : {}),
            ...(content !== undefined ? { content } : {}),
          });
          return deps.written(target, memory.id, memory.versionId);
        }
        if (kind === "rule") {
          const rule = await store.updateRule({
            id: itemId,
            expectedVersionId,
            ...(title !== undefined ? { name: title } : {}),
            ...(content !== undefined ? { content } : {}),
            ...(priority !== undefined ? { priority } : {}),
          });
          return deps.written(target, rule.id, rule.versionId);
        }
        const skill = await store.updateSkill({
          id: itemId,
          expectedVersionId,
          ...(title !== undefined ? { name: title } : {}),
          ...(content !== undefined ? { content } : {}),
          ...(description !== undefined
            ? { description: description.trim() ? description : null }
            : {}),
        });
        return deps.written(target, skill.id, skill.versionId);
      } catch (err) {
        return storeFailure(err);
      }
    },

    async "knowledge.delete"(body): Promise<KnowledgeWriteResponse> {
      const input = fields(body, ["workspaceId", "kind", "id", "expectedVersionId"]);
      const { target, store } = await scoped(input.workspaceId);
      const kind = kindOf(input.kind);
      const itemId = id(input.id);
      const expectedVersionId =
        input.expectedVersionId === undefined
          ? undefined
          : id(input.expectedVersionId, "expectedVersionId");
      if (!(await readActive(store, target.id, kind, itemId))) {
        throw notFound(`No active ${kind} has this id in this workspace.`);
      }
      // Soft delete only: the item is archived and `knowledge.restore` brings it back.
      const request = {
        id: itemId,
        hard: false,
        ...(expectedVersionId ? { expectedVersionId } : {}),
      };
      let result: Awaited<ReturnType<WorkspaceRouteStore["deleteMemory"]>>;
      try {
        result =
          kind === "memory"
            ? await store.deleteMemory(request)
            : kind === "rule"
              ? await store.deleteRule(request)
              : await store.deleteSkill(request);
      } catch (err) {
        return storeFailure(err);
      }
      if (result.status === "conflict") {
        throw conflict("This item changed since it was read. Read it again before deleting it.");
      }
      if (result.status === "rejected") {
        if (result.reason === "not_found") throw notFound(`No active ${kind} has this id.`);
        throw bad(`The ${kind} was not deleted: ${result.reason}.`);
      }
      return deps.written(target, itemId, null);
    },

    async "knowledge.restore"(body): Promise<KnowledgeWriteResponse> {
      const input = fields(body, ["workspaceId", "kind", "id"]);
      const { target, store } = await scoped(input.workspaceId);
      const kind = kindOf(input.kind);
      const itemId = id(input.id);
      const archived = await listEntries(store, target.id, kind, "archived");
      if (!archived.some((entry) => entry.item.id === itemId)) {
        if (await readActive(store, target.id, kind, itemId)) {
          throw conflict(`This ${kind} is not deleted.`);
        }
        throw notFound(`No deleted ${kind} has this id in this workspace.`);
      }
      let result: Awaited<ReturnType<WorkspaceRouteStore["restoreMemory"]>>;
      try {
        result =
          kind === "memory"
            ? await store.restoreMemory(itemId)
            : kind === "rule"
              ? await store.restoreRule(itemId)
              : await store.restoreSkill(itemId);
      } catch (err) {
        return storeFailure(err);
      }
      if (result.status === "rejected") {
        if (result.reason === "not_deleted") throw conflict(`This ${kind} is not deleted.`);
        if (result.reason === "not_found") throw notFound(`No deleted ${kind} has this id.`);
        throw bad(`The ${kind} was not restored: ${result.reason}.`);
      }
      const restored = await readActive(store, target.id, kind, itemId);
      return deps.written(target, itemId, restored?.item.versionId ?? null);
    },

    // The last entries (30 unless asked, at most 200), or with `days` every entry of the window
    // (500 unless asked, at most 1,000); the shaping and the files' privacy are activity-route.ts's.
    async "activity.recent"(body): Promise<ActivityRecentResponse> {
      const input = fields(body, ["workspaceId", "limit", "days"]);
      const { target, store } = await scoped(input.workspaceId);
      const limit = integer(input.limit, "limit");
      const days = input.days;
      if (days !== undefined && !isActivityWindow(days)) throw bad("days must be 7, 30 or 90.");
      return recentActivity(
        store,
        target.id,
        { limit, days },
        { root: target.rootPath ?? null, people: deps.people },
      );
    },
  };
}
