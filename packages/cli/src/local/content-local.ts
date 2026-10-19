// SPDX-License-Identifier: Apache-2.0
// Local (no-login) content browsing.
//
// Reads memory/rule/skill as CliContentItem / CliContentReadResult shapes from
// the local SQLite store, through the home's Pathrule host (./host-session.ts).
// Local items carry no deep-links
// (url = "", open_targets = []) — browsing is terminal + markdown, not a link
// into a web/desktop app.
//
// Reuses the pure list/search/read helpers from content-helpers so scoring,
// path filtering, and previews stay consistent.

import type { KnowledgeBackend } from "@pathrule/core";

import {
  type CliContentItem,
  type CliContentKind,
  type CliContentReadResult,
  clampLimit,
  normalizePathPrefix,
  pathMatches,
  preview,
  scoreItem,
} from "../content-helpers.js";
import { withCliHostSession } from "./host-session.js";

class LocalWorkspaceRequiredError extends Error {
  constructor() {
    super("No local Pathrule workspace covers this folder. Run: pathrule init --local");
    this.name = "LocalWorkspaceRequiredError";
  }
}

/** The store a content command reads when it is not the local one serving the folder. */
export interface ContentStore {
  backend: KnowledgeBackend;
  workspaceId: string;
}

/** Runs `fn` on `store`, or on the store of the local workspace that covers `cwd`. */
function withLocalStoreForCwd<T>(
  cwd: string,
  env: NodeJS.ProcessEnv,
  store: ContentStore | undefined,
  fn: (backend: KnowledgeBackend, workspaceId: string) => Promise<T>,
): Promise<T> {
  if (store) return fn(store.backend, store.workspaceId);
  return withCliHostSession(env, async (session) => {
    const match = session.resolveLocal(cwd);
    if (!match) throw new LocalWorkspaceRequiredError();
    return fn(await session.store(match.workspaceId), match.workspaceId);
  });
}

function toLocalItem(input: {
  kind: CliContentKind;
  id: string;
  title: string;
  body: string;
  path: string | null;
  nodeId: string | null;
  updatedAt: string | null;
}): CliContentItem {
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    path: input.path,
    node_id: input.nodeId,
    preview: preview(input.body),
    updated_at: input.updatedAt,
    // No deep-links in local mode — browsing is terminal + markdown.
    url: "",
    open_targets: [],
  };
}

async function collectLocalItems(
  kind: CliContentKind,
  backend: KnowledgeBackend,
  workspaceId: string,
): Promise<CliContentItem[]> {
  if (kind === "memory") {
    const rows = await backend.listMemories({ workspaceId });
    return Promise.all(
      rows.map(async (m) => {
        const node = m.nodeId ? await backend.getNode(m.nodeId) : null;
        return toLocalItem({
          kind,
          id: m.id,
          title: m.title,
          body: m.content,
          path: node?.relativePath ?? null,
          nodeId: node?.id ?? null,
          updatedAt: m.updatedAt,
        });
      }),
    );
  }
  if (kind === "rule") {
    const rows = await backend.listRules({ workspaceId });
    return Promise.all(
      rows.map(async (r) => {
        const node = await backend.getNodeForRule(r.id);
        return toLocalItem({
          kind,
          id: r.id,
          title: r.name,
          body: r.content,
          path: node?.relativePath ?? null,
          nodeId: node?.id ?? null,
          updatedAt: r.updatedAt,
        });
      }),
    );
  }
  const rows = await backend.listSkills({ workspaceId });
  return Promise.all(
    rows.map(async (s) => {
      const node = await backend.getNodeForSkill(s.id);
      return toLocalItem({
        kind,
        id: s.id,
        title: s.name,
        body: s.content || s.description || "",
        path: node?.relativePath ?? null,
        nodeId: node?.id ?? null,
        updatedAt: s.updatedAt,
      });
    }),
  );
}

export async function listLocalContent(
  kind: CliContentKind,
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: { path?: string | null; limit?: number } = {},
  store?: ContentStore,
): Promise<CliContentItem[]> {
  return withLocalStoreForCwd(cwd, env, store, async (backend, workspaceId) => {
    const limit = clampLimit(opts.limit);
    const prefix = normalizePathPrefix(opts.path);
    return (await collectLocalItems(kind, backend, workspaceId))
      .filter((item) => pathMatches(item.path, prefix))
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
      .slice(0, limit);
  });
}

export async function searchLocalContent(
  query: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: { types?: CliContentKind[]; path?: string | null; limit?: number } = {},
  store?: ContentStore,
): Promise<CliContentItem[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new Error("search_query_required");
  return withLocalStoreForCwd(cwd, env, store, async (backend, workspaceId) => {
    const types: CliContentKind[] = opts.types?.length ? opts.types : ["memory", "rule", "skill"];
    const prefix = normalizePathPrefix(opts.path);
    const batches = await Promise.all(
      types.map((kind) => collectLocalItems(kind, backend, workspaceId)),
    );
    return batches
      .flat()
      .filter((item) => pathMatches(item.path, prefix))
      .map((item) => ({ item, score: scoreItem(item, needle) }))
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || (b.item.updated_at ?? "").localeCompare(a.item.updated_at ?? ""),
      )
      .slice(0, clampLimit(opts.limit))
      .map((entry) => entry.item);
  });
}

export async function readLocalContent(
  kind: CliContentKind,
  selector: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  store?: ContentStore,
): Promise<CliContentReadResult> {
  return withLocalStoreForCwd(cwd, env, store, async (backend, workspaceId) => {
    const items = await collectLocalItems(kind, backend, workspaceId);
    const normalized = selector.toLowerCase();
    const match = items.find(
      (item) => item.id === selector || item.title.toLowerCase() === normalized,
    );
    if (!match) throw new Error(`${kind}_not_found`);
    const row =
      kind === "memory"
        ? await backend.readMemory(match.id)
        : kind === "rule"
          ? await backend.readRule(match.id)
          : await backend.readSkill(match.id);
    const content =
      row && typeof (row as { content?: unknown }).content === "string"
        ? (row as { content: string }).content
        : "";
    return { ...match, content };
  });
}
