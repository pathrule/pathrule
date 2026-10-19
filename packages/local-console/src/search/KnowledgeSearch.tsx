// SPDX-License-Identifier: Apache-2.0
// ⌘K search in both consoles, `pathrule ui` and Pathrule Cloud's: the workspace's memories, rules and
// skills first (knowledge.search over the Local UI API), then pages, workspaces and actions. A query that
// starts with "/" asks the backend for what is attached to that folder. ⌘⇧K, or the scope menu, searches
// every workspace with one call (knowledge.searchAll) where the backend offers it. Recently opened items
// are kept in this browser only. The host supplies its API, its addresses and its pages and actions; the
// search is the same everywhere, and it is the consoles' only search.
import type { KnowledgeKind, KnowledgeListItem } from "@pathrule/protocol/local-ui-api.js";
import {
  Button,
  CopyButton,
  Icon,
  MenuRadio,
  SearchPalette,
  type IconComponent,
  type SearchGroup,
  type SearchResult,
} from "@pathrule/ui";
import { Box, ChevronDown, Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { LocalApi } from "../api/client.js";
import { useConsoleMessages } from "../messages.js";
import "./search.css";

type Filter = "all" | KnowledgeKind | "pages" | "workspaces";
const KINDS: readonly KnowledgeKind[] = ["memory", "rule", "skill"];
const KIND_COLOR = { memory: "viz-1", rule: "viz-2", skill: "viz-3" } as const;
const KIND_LETTER = { memory: "M", rule: "R", skill: "S" } as const;
const RECENT_MAX = 5;

export interface SearchTarget {
  id: string;
  title: string;
  icon: IconComponent;
  /** Where it goes; actions without one run `onSelect`. */
  href?: string;
  onSelect?: () => void;
}

/** Where things live in the host console. */
export interface SearchAddresses {
  knowledge: (workspaceId: string, kind: KnowledgeKind, id: string) => string;
  workspace: (workspaceId: string) => string;
  newMemory: (workspaceId: string) => string;
}

export interface KnowledgeSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opened with ⌘⇧K: every workspace. */
  everywhere: boolean;
  api: LocalApi;
  workspaces: ReadonlyArray<{ id: string; name: string }>;
  workspace: { id: string; name: string } | null;
  /** The backend answers knowledge.searchAll. */
  canSearchAll: boolean;
  /** This browser's key for recently opened items; null keeps none. */
  recentKey: string | null;
  addresses: SearchAddresses;
  navigate: (href: string) => void;
  pages: readonly SearchTarget[];
  actions: readonly SearchTarget[];
}

type Hit = KnowledgeListItem & { score?: number; workspaceId: string; workspaceName: string };

interface Recent {
  kind: KnowledgeKind;
  id: string;
  title: string;
  path: string | null;
  workspaceId: string;
  at: number;
}

function readRecent(key: string | null): Recent[] {
  if (!key) return [];
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]") as Recent[];
    return Array.isArray(value) ? value.slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
function keepRecent(key: string | null, item: Recent): void {
  if (!key) return;
  try {
    const rest = readRecent(key).filter((r) => !(r.id === item.id && r.kind === item.kind));
    localStorage.setItem(key, JSON.stringify([item, ...rest].slice(0, RECENT_MAX)));
  } catch {
    // Without storage there is simply no recent list.
  }
}

function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return current;
}

export function KnowledgeSearch({
  open,
  onOpenChange,
  everywhere,
  api,
  workspaces: list,
  workspace,
  canSearchAll,
  recentKey,
  addresses,
  navigate,
  pages,
  actions,
}: KnowledgeSearchProps) {
  const m = useConsoleMessages();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [scope, setScope] = useState<"workspace" | "all">("workspace");
  const [recent, setRecent] = useState<Recent[]>([]);
  const [hits, setHits] = useState<{ items: Hit[]; loading: boolean; failed: boolean }>({
    items: [],
    loading: false,
    failed: false,
  });
  const allowAll = canSearchAll && list.length > 1;

  useEffect(() => {
    if (open) {
      setScope((everywhere && allowAll) || !workspace ? "all" : "workspace");
      setRecent(readRecent(recentKey));
    } else {
      setQuery("");
      setFilter("all");
    }
  }, [open, everywhere, allowAll, workspace, recentKey]);

  const term = useDebounced(query.trim(), 180);
  useEffect(() => {
    if (
      !open ||
      term.length < 2 ||
      (scope === "workspace" && !workspace) ||
      (scope === "all" && !canSearchAll)
    ) {
      setHits({ items: [], loading: false, failed: false });
      return;
    }
    const controller = new AbortController();
    setHits((current) => ({ ...current, loading: true, failed: false }));
    // A folder ("/apps/api") is matched by path on the backend; anything else is a text search.
    const folder = term.startsWith("/");
    const request = { query: folder ? "" : term, ...(folder ? { path: term } : {}) };
    const search: Promise<Hit[]> =
      scope === "all"
        ? api
            .call("knowledge.searchAll", { ...request, limit: 30 }, controller.signal)
            .then((result) => result.items)
        : api
            .call(
              "knowledge.search",
              { workspaceId: workspace!.id, ...request, limit: 20 },
              controller.signal,
            )
            .then((result) =>
              result.items.map((item) => ({
                ...item,
                workspaceId: workspace!.id,
                workspaceName: workspace!.name,
              })),
            );
    search.then(
      (items) => {
        if (!controller.signal.aborted) setHits({ items, loading: false, failed: false });
      },
      () => {
        if (!controller.signal.aborted) setHits({ items: [], loading: false, failed: true });
      },
    );
    return () => controller.abort();
  }, [open, term, scope, workspace, api, canSearchAll]);

  const scopeName = scope === "all" ? m.t("search.everyWorkspace") : (workspace?.name ?? "");
  const words = query.trim().toLowerCase();
  const matches = (title: string) => !words || title.toLowerCase().includes(words);
  const absolute = (href: string) => `${window.location.origin}${href}`;

  const knowledgeResult = (hit: Hit): SearchResult => {
    const href = addresses.knowledge(hit.workspaceId, hit.kind, hit.id);
    const kind = m.t(`search.kinds.${hit.kind}`);
    const updated = m.relative(hit.updatedAt);
    return {
      id: `k:${hit.workspaceId}:${hit.kind}:${hit.id}`,
      title: hit.title,
      glyph: { letter: KIND_LETTER[hit.kind], color: KIND_COLOR[hit.kind] },
      path: hit.path ?? undefined,
      detail: [
        kind,
        hit.kind === "rule" && hit.priority ? m.t(`search.priority.${hit.priority}`) : null,
        scope === "all" ? hit.workspaceName : null,
      ]
        .filter(Boolean)
        .join(" · "),
      href: absolute(href),
      onSelect: () => {
        keepRecent(recentKey, {
          kind: hit.kind,
          id: hit.id,
          title: hit.title,
          path: hit.path,
          workspaceId: hit.workspaceId,
          at: Date.now(),
        });
        navigate(href);
      },
      preview: {
        kind: { label: kind, color: KIND_COLOR[hit.kind] },
        path: hit.path ?? undefined,
        title: hit.title,
        text: hit.preview,
        facts: [
          {
            label: m.t("search.updated"),
            value: hit.lastEditedBy?.name
              ? m.t("search.updatedBy", { when: updated, name: hit.lastEditedBy.name })
              : updated,
          },
          ...(hit.usageCount30d !== undefined
            ? [
                {
                  label: m.t("search.delivered"),
                  value: m.plural("search.deliveredCount", hit.usageCount30d),
                },
              ]
            : []),
          ...(scope === "all"
            ? [{ label: m.t("search.workspace"), value: hit.workspaceName }]
            : []),
        ],
        actions: (
          <>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                onOpenChange(false);
                navigate(href);
              }}
            >
              {m.t("search.open")}
            </Button>
            <CopyButton
              value={absolute(href)}
              label={m.t("search.copyLink")}
              text={m.t("search.copyLink")}
            />
          </>
        ),
      },
    };
  };
  const target = (t: SearchTarget, prefix: string): SearchResult => ({
    id: `${prefix}:${t.id}`,
    title: t.title,
    glyph: { icon: t.icon },
    href: t.href ? absolute(t.href) : undefined,
    onSelect: () => (t.href ? navigate(t.href) : t.onSelect?.()),
  });

  const knowledge = hits.items.filter((hit) => filter === "all" || filter === hit.kind);
  const pageRows = pages.filter((p) => matches(p.title));
  // A few workspaces beside the knowledge; their own filter shows more.
  const workspaceMatches = words ? list.filter((w) => matches(w.name)) : [];
  const workspaceRows = workspaceMatches.slice(0, filter === "workspaces" ? 20 : 5);
  const actionRows = actions.filter((a) => matches(a.title));
  const recentRows = recent.filter((r) => filter === "all" || filter === r.kind);

  const groups: SearchGroup[] = !words
    ? [
        {
          id: "recent",
          heading: m.t("search.recent"),
          results: recentRows.map((r) => ({
            id: `r:${r.workspaceId}:${r.kind}:${r.id}`,
            title: r.title,
            glyph: { letter: KIND_LETTER[r.kind], color: KIND_COLOR[r.kind] },
            path: r.path ?? undefined,
            detail: m.t("search.opened", { when: m.relative(new Date(r.at).toISOString()) }),
            href: absolute(addresses.knowledge(r.workspaceId, r.kind, r.id)),
            onSelect: () => navigate(addresses.knowledge(r.workspaceId, r.kind, r.id)),
          })),
        },
        ...(filter === "all" || filter === "pages"
          ? [
              {
                id: "pages",
                heading: m.t("search.goTo"),
                results: pages.map((p) => target(p, "p")),
              },
            ]
          : []),
        ...(filter === "all"
          ? [
              {
                id: "actions",
                heading: m.t("search.actions"),
                results: actions.map((a) => target(a, "a")),
              },
            ]
          : []),
      ]
    : [
        ...(filter === "all" || KINDS.includes(filter as KnowledgeKind)
          ? [
              {
                id: "knowledge",
                heading:
                  scope === "all"
                    ? m.t("search.knowledgeEverywhere")
                    : m.t("search.knowledgeIn", { scope: scopeName }),
                meta: knowledge.length ? m.number(knowledge.length) : undefined,
                results: knowledge.map(knowledgeResult),
              },
            ]
          : []),
        ...(filter === "all" || filter === "pages"
          ? [
              {
                id: "pages",
                heading: m.t("search.pages"),
                results: pageRows.map((p) => target(p, "p")),
              },
            ]
          : []),
        ...(filter === "all" || filter === "workspaces"
          ? [
              {
                id: "workspaces",
                heading: m.t("search.workspaces"),
                ...(workspaceMatches.length > workspaceRows.length
                  ? {
                      meta: m.t("search.someOf", {
                        shown: workspaceRows.length,
                        count: workspaceMatches.length,
                      }),
                    }
                  : {}),
                results: workspaceRows.map((w) => ({
                  id: `w:${w.id}`,
                  title: w.name,
                  glyph: { icon: Box },
                  detail: m.t("search.workspaceHint"),
                  href: absolute(addresses.workspace(w.id)),
                  onSelect: () => navigate(addresses.workspace(w.id)),
                })),
              },
            ]
          : []),
        ...(filter === "all"
          ? [
              {
                id: "actions",
                heading: m.t("search.actions"),
                results: actionRows.map((a) => target(a, "a")),
              },
            ]
          : []),
      ];

  const count = (kind: KnowledgeKind) => hits.items.filter((hit) => hit.kind === kind).length;
  const total = groups.reduce((n, g) => n + g.results.length, 0);
  const filters = words
    ? [
        {
          id: "all",
          label: m.t("search.filters.all"),
          count: hits.items.length + pageRows.length + workspaceRows.length + actionRows.length,
        },
        ...KINDS.map((kind) => ({
          id: kind,
          label: m.t(`search.filters.${kind}`),
          count: count(kind),
        })),
        { id: "pages", label: m.t("search.filters.pages"), count: pageRows.length },
        { id: "workspaces", label: m.t("search.filters.workspaces"), count: workspaceRows.length },
      ]
    : [
        { id: "all", label: m.t("search.filters.all") },
        ...KINDS.map((kind) => ({ id: kind, label: m.t(`search.filters.${kind}`) })),
        { id: "pages", label: m.t("search.filters.pages") },
      ];

  const scopeMenu =
    workspace && allowAll ? (
      <MenuRadio
        label={m.t("search.scopeLabel")}
        heading={m.t("search.scopeLabel")}
        align="end"
        value={scope === "all" ? "all" : workspace.id}
        onValueChange={(value) => setScope(value === "all" ? "all" : "workspace")}
        options={[
          { value: workspace.id, label: workspace.name },
          { value: "all", label: m.t("search.everyWorkspace") },
        ]}
        trigger={
          <button type="button" className="lc-search-scope" aria-label={m.t("search.scopeLabel")}>
            <span>{scopeName}</span>
            <ChevronDown size={12} aria-hidden />
          </button>
        }
      />
    ) : scopeName ? (
      <span className="lc-search-scope lc-search-scope--fixed">{scopeName}</span>
    ) : null;

  return (
    <SearchPalette
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={(value) => setQuery(value)}
      placeholder={m.t("search.placeholder")}
      scope={scopeMenu}
      filters={filters}
      filter={filter}
      onFilterChange={(id) => setFilter(id as Filter)}
      groups={groups}
      loading={hits.loading}
      empty={
        words ? (
          <div className="lc-search-empty">
            <span className="lc-search-empty__icon" aria-hidden>
              <Icon icon={Search} size="md" />
            </span>
            <span className="lc-search-empty__title">
              {hits.failed
                ? m.t("search.failed")
                : m.t("search.noResults", { query: query.trim(), scope: scopeName })}
            </span>
            <span className="lc-search-empty__hint">{m.t("search.noResultsHint")}</span>
            <span className="lc-search-empty__actions">
              {scope === "workspace" && allowAll ? (
                <Button size="sm" onClick={() => setScope("all")}>
                  {m.t("search.searchAll")}
                </Button>
              ) : null}
              {workspace ? (
                <Button
                  size="sm"
                  onClick={() => {
                    onOpenChange(false);
                    navigate(addresses.newMemory(workspace.id));
                  }}
                >
                  {m.t("search.writeMemory")}
                </Button>
              ) : null}
            </span>
          </div>
        ) : undefined
      }
      aside={
        !words ? (
          <div className="lc-search-tips">
            <span className="lc-search-tips__heading">{m.t("search.tipsHeading")}</span>
            <ul>
              <li>{m.t("search.tipKnowledge")}</li>
              <li>{m.t("search.tipFolder")}</li>
              <li>{m.t("search.tipPages")}</li>
            </ul>
            <span className="lc-search-tips__heading">{m.t("search.anywhere")}</span>
            <ul className="lc-search-tips__keys">
              <li>
                <span>{m.t("search.openSearch")}</span>
                <kbd className="pr-kbd">⌘K</kbd>
              </li>
              {allowAll ? (
                <li>
                  <span>{m.t("search.searchEverywhere")}</span>
                  <kbd className="pr-kbd">⌘⇧K</kbd>
                </li>
              ) : null}
            </ul>
          </div>
        ) : undefined
      }
      status={
        !words
          ? m.t("search.statusEmpty", { scope: scopeName })
          : hits.loading && !total
            ? m.t("search.searching")
            : total
              ? m.plural("search.status", total, { scope: scopeName })
              : m.t("search.statusNone", { scope: scopeName })
      }
    />
  );
}
