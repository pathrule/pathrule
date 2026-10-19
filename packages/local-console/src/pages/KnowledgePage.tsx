// SPDX-License-Identifier: Apache-2.0
// Memories, rules and skills: browsed by path (the folders knowledge is written to) or by topic
// (the knowledge map's groups of linked, alike items), found with one box, filtered by health, and
// listed a group at a time with how often agents received each item and who added it.
import type { KnowledgeKind, KnowledgeTopicsResponse } from "@pathrule/protocol/local-ui-api.js";
import {
  Button,
  EmptyPanel,
  LoadError,
  Page,
  PageHeader,
  Pagination,
  SearchInput,
  SegmentedControl,
  Select,
  Swatch,
  useAsync,
  type ChartColor,
} from "@pathrule/ui";
import { Layers, Plus, SearchX } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { LocalApiError } from "../api/client.js";
import { useConsole } from "../app/context.js";
import { BrowseRail, GroupCard } from "../knowledge/KnowledgeBrowse.js";
import { KnowledgeDrawer } from "../knowledge/KnowledgeDrawer.js";
import { KnowledgeEditor } from "../knowledge/KnowledgeEditor.js";
import "../knowledge/knowledge.css";
import {
  CONVENTIONS,
  GROUPS_PER_PAGE,
  groupItems,
  itemKey,
  keepHealth,
  KNOWLEDGE_SORTS,
  pageOf,
  pathTree,
  ROWS_PER_GROUP,
  ROWS_STEP,
  scopedItems,
  sortItems,
  topicIndex,
  type BrowseMode,
  type HealthFilter,
  type KnowledgeSort,
} from "../knowledge/model.js";
import { useConsoleMessages } from "../messages.js";
import {
  deliveriesByItem,
  HEALTH_STATES,
  healthBreakdown,
  healthOf,
  KINDS,
  type HealthState,
} from "../overview/model.js";
import { KIND_COLORS, Loading } from "../overview/panel.js";
import { hrefFor, type Route } from "../router.js";

type KnowledgeRoute = Extract<Route, { name: "knowledge" }>;

const HEALTH_COLORS: Record<HealthState, ChartColor> = {
  current: "positive",
  unused: "info",
  stale: "warning",
  unplaced: "danger",
};
/** Asks again this many times while topics are being grouped or named. */
const TOPIC_RETRIES = 6;

export function KnowledgePage({ route }: { route: KnowledgeRoute }) {
  const m = useConsoleMessages();
  const { api, workspace, navigate, capabilities } = useConsole();
  const workspaceId = route.workspaceId;
  const workspaceName = workspace?.name ?? m.t("knowledge.thisWorkspace");
  const createKind: KnowledgeKind = route.kind === "all" ? "memory" : route.kind;
  const canWrite = capabilities.knowledgeWrite.available;
  const deliveriesOn = capabilities.deliveryStats.available;
  const topicsOn = capabilities.knowledgeTopics.available;
  const [now] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [browse, setBrowse] = useState<BrowseMode>("paths");
  // A link may open the page on a folder (Signals' "Open in Knowledge"): scope it and unfold its parents.
  const [scope, setScope] = useState<string | null>(route.path ?? null);
  const [health, setHealth] = useState<HealthFilter>("all");
  const [sort, setSort] = useState<KnowledgeSort>(deliveriesOn ? "delivered" : "edited");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        (route.path ?? "")
          .split("/")
          .filter(Boolean)
          .map((_, index, parts) => `/${parts.slice(0, index + 1).join("/")}`),
      ),
  );
  const [shown, setShown] = useState<Record<string, number>>({});
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(route.create === true);
  const [version, setVersion] = useState(0);

  // Every kind at once: the kind switch counts them, and "All" needs them anyway.
  const list = useAsync(
    (signal) =>
      Promise.all(
        KINDS.map((kind) =>
          api
            .call(
              "knowledge.list",
              { workspaceId, kind, status: route.archived ? "archived" : "active" },
              signal,
            )
            .then((r) => r.items),
        ),
      ).then((batches) => batches.flat()),
    [api, workspaceId, route.archived, version],
  );
  const stats = useAsync(
    (signal) =>
      deliveriesOn
        ? api.call("deliveries.stats", { workspaceId, days: 30 }, signal)
        : Promise.resolve(null),
    [api, workspaceId, deliveriesOn],
  );
  const topics = useAsync<KnowledgeTopicsResponse | null>(
    (signal) =>
      topicsOn ? api.call("knowledge.topics", { workspaceId }, signal) : Promise.resolve(null),
    [api, workspaceId, topicsOn, version],
  );

  // "/" anywhere but in a field goes to the find box.
  const findRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      findRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // While the map is being built or named, ask again a few times.
  const retries = useRef(0);
  const topicData = topics.state.status === "success" ? topics.state.data : null;
  useEffect(() => {
    if (!topicData) return;
    const waiting = topicData.status === "computing" || topicData.naming.status === "pending";
    if (!waiting || retries.current >= TOPIC_RETRIES) return;
    const timer = setTimeout(() => {
      retries.current += 1;
      topics.reload();
    }, topicData.retryAfterMs ?? 4_000);
    return () => clearTimeout(timer);
  }, [topicData, topics]);

  const allItems = useMemo(
    () => (list.state.status === "success" ? list.state.data : null),
    [list.state],
  );
  const kindItems = useMemo(
    () => (allItems ?? []).filter((item) => route.kind === "all" || item.kind === route.kind),
    [allItems, route.kind],
  );
  const delivered = useMemo(
    () =>
      stats.state.status === "success" && stats.state.data
        ? deliveriesByItem(stats.state.data)
        : null,
    [stats.state],
  );
  const previous = useMemo(() => {
    const map = new Map<string, number>();
    if (stats.state.status === "success" && stats.state.data) {
      for (const item of stats.state.data.items) map.set(`${item.kind}:${item.id}`, item.previous);
    }
    return map;
  }, [stats.state]);
  const index = useMemo(() => topicIndex(topicData), [topicData]);
  const nodes = useMemo(() => pathTree(kindItems), [kindItems]);
  const topicCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of kindItems) {
      const key =
        index.byItem.get(itemKey(item))?.id ??
        (index.conventions.has(itemKey(item)) ? CONVENTIONS : null);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [kindItems, index]);
  // What each topic holds by kind, whichever kind the page shows.
  const topicMix = useMemo(() => {
    const mix = new Map<string, Record<KnowledgeKind, number>>();
    for (const item of allItems ?? []) {
      const id = index.byItem.get(itemKey(item))?.id;
      if (!id) continue;
      const counts = mix.get(id) ?? { memory: 0, rule: 0, skill: 0 };
      counts[item.kind] += 1;
      mix.set(id, counts);
    }
    return mix;
  }, [allItems, index]);

  const filter = { browse, scope, query, health };
  const scoped = useMemo(
    () => scopedItems(kindItems, { browse, scope, query, health }, index),
    [kindItems, browse, scope, query, health, index],
  );
  const healthCounts = useMemo(
    () => healthBreakdown(scoped, delivered, now),
    [scoped, delivered, now],
  );
  const sorted = useMemo(
    () => sortItems(keepHealth(scoped, health, delivered, now), sort, delivered),
    [scoped, health, delivered, now, sort],
  );
  const groups = useMemo(
    () => groupItems(sorted, browse, index, delivered),
    [sorted, browse, index, delivered],
  );
  const paged = pageOf(groups, page, GROUPS_PER_PAGE);
  const maxDelivered = useMemo(
    () => Math.max(0, ...sorted.map((item) => delivered?.get(itemKey(item)) ?? 0)),
    [sorted, delivered],
  );

  // Any change of view starts over at the first page with groups folded.
  const view = JSON.stringify([route.kind, route.archived, filter, sort]);
  const lastView = useRef(view);
  useEffect(() => {
    if (lastView.current === view) return;
    lastView.current = view;
    setPage(1);
    setShown({});
  }, [view]);

  const go = (patch: Partial<KnowledgeRoute>) => navigate(hrefFor({ ...route, ...patch }));
  const openItem = allItems?.find((item) => item.id === route.open) ?? null;
  const openKind: KnowledgeKind | null =
    openItem?.kind ?? (route.kind === "all" ? null : route.kind);
  const kindNoun = (count: number) =>
    route.kind === "all"
      ? m.plural("knowledge.items", count)
      : m.plural(`kinds.count.${route.kind}`, count);

  const states: readonly HealthState[] = delivered
    ? HEALTH_STATES
    : ["current", "stale", "unplaced"];
  const stateLabel = (state: HealthState) =>
    !delivered && (state === "current" || state === "stale")
      ? m.t(`knowledge.healthStatesEdits.${state}`)
      : m.t(`knowledge.healthStates.${state}`);

  const topicsCapability = capabilities.knowledgeTopics;
  const topicsNote = !topicsCapability.available
    ? m.t("knowledge.topicsUnavailable", { reason: topicsCapability.reason })
    : topics.state.status === "error"
      ? // A backend that groups no topics for this workspace says why (Cloud: past its size limits).
        topics.state.error instanceof LocalApiError && topics.state.error.code === "unavailable"
        ? m.t("knowledge.topicsUnavailable", { reason: topics.state.error.message })
        : m.t("knowledge.topicsError")
      : !topicData
        ? null
        : topicData.status === "computing"
          ? m.t("knowledge.topicsComputing")
          : `${m.t("knowledge.topicsNote")} ${
              // Which model names topics is the backend's business: people are told AI does it.
              topicData.naming.status === "off"
                ? topicData.naming.reason
                : topicData.naming.status === "named"
                  ? m.t("knowledge.topicsNamed")
                  : topicData.naming.status === "pending"
                    ? m.t("knowledge.topicsPending")
                    : m.t("knowledge.topicsFailed")
            }`;

  const kinds =
    route.kind === "all" ? m.t("knowledge.title").toLowerCase() : m.t(`kinds.lower.${route.kind}`);
  let body;
  if (list.state.status === "error") {
    body = (
      <LoadError
        title={m.t("knowledge.loadError", { kinds })}
        error={list.state.error}
        onRetry={list.reload}
      />
    );
  } else if (!allItems) {
    body = <Loading />;
  } else if (kindItems.length === 0) {
    body = (
      <div className="lc-kn-panel">
        <EmptyPanel
          icon={Layers}
          title={
            route.archived
              ? m.t("knowledge.noArchived", { kinds })
              : m.t("knowledge.none", { kinds, workspace: workspaceName })
          }
          actions={
            canWrite && !route.archived ? (
              <Button
                size="sm"
                variant="primary"
                leadingIcon={Plus}
                onClick={() => setCreating(true)}
              >
                {m.t("knowledge.new", { kind: m.t(`kinds.singular.${createKind}`) })}
              </Button>
            ) : undefined
          }
          ghost={{ columns: ["46%", "120px", "64px", "120px"] }}
        />
      </div>
    );
  } else if (groups.length === 0) {
    body = (
      <div className="lc-kn-panel">
        <EmptyPanel
          icon={SearchX}
          title={
            query.trim()
              ? m.t("knowledge.noMatch", { kinds, query: query.trim() })
              : m.t("knowledge.noFilterMatch")
          }
          actions={
            <Button
              size="sm"
              onClick={() => {
                setQuery("");
                setHealth("all");
                setScope(null);
              }}
            >
              {m.t("knowledge.clearFilters")}
            </Button>
          }
          ghost={{ columns: ["46%", "120px", "64px", "120px"] }}
        />
      </div>
    );
  } else {
    body = (
      <>
        {paged.slice.map((group) => (
          <GroupCard
            key={`${group.kind}:${group.key}`}
            group={group}
            shown={shown[group.key] ?? ROWS_PER_GROUP}
            onMore={() =>
              setShown((current) => ({
                ...current,
                [group.key]: (current[group.key] ?? ROWS_PER_GROUP) + ROWS_STEP,
              }))
            }
            delivered={delivered}
            maxDelivered={maxDelivered}
            health={(item) => healthOf(item, delivered, now)}
            topics={index}
            browse={browse}
            openId={route.open}
            hrefFor={(item) => hrefFor({ ...route, open: item.id })}
            onOpen={(item) => go({ open: item.id })}
          />
        ))}
        <Pagination
          page={paged.page}
          pageSize={GROUPS_PER_PAGE}
          total={groups.length}
          onPageChange={setPage}
          formatRange={(range) =>
            m.t("knowledge.groupsRange", {
              from: m.number(range.from),
              to: m.number(range.to),
              total: m.number(range.total),
              items: kindNoun(sorted.length),
            })
          }
        />
      </>
    );
  }

  const kindOptions = (["all", ...KINDS] as const).map((kind) => {
    const count =
      kind === "all"
        ? (allItems?.length ?? 0)
        : (allItems ?? []).filter((i) => i.kind === kind).length;
    return {
      value: kind,
      label:
        kind === "all" ? (
          m.t("knowledge.all")
        ) : (
          <span className="lc-kn-kind">
            <Swatch color={KIND_COLORS[kind]} />
            {m.t(`kinds.plural.${kind}`)}
          </span>
        ),
      count: allItems ? m.number(count) : undefined,
    };
  });

  return (
    <Page>
      <div className="lc-kn">
        <PageHeader
          title={route.kind === "all" ? m.t("knowledge.title") : m.t(`kinds.plural.${route.kind}`)}
          description={
            route.kind === "all"
              ? m.t("knowledge.descriptionAll", { workspace: workspaceName })
              : m.t(`kinds.hint.${route.kind}`)
          }
          actions={
            canWrite ? (
              <Button variant="primary" leadingIcon={Plus} onClick={() => setCreating(true)}>
                {m.t("knowledge.new", { kind: m.t(`kinds.singular.${createKind}`) })}
              </Button>
            ) : undefined
          }
        />

        <div className="lc-kn-toolbar">
          <SearchInput
            ref={findRef}
            value={query}
            onValueChange={setQuery}
            placeholder={m.t("knowledge.find")}
            aria-label={m.t("knowledge.findLabel")}
            shortcut="/"
            wrapperClassName="lc-kn-toolbar__find"
          />
          <SegmentedControl
            label={m.t("knowledge.kind")}
            size="sm"
            value={route.kind}
            onValueChange={(kind) => go({ kind, open: null })}
            options={kindOptions}
          />
          <label className="lc-kn-toolbar__sort">
            <span>{m.t("knowledge.sort")}</span>
            <Select
              size="sm"
              value={sort}
              onChange={(event) => setSort(event.target.value as KnowledgeSort)}
              options={KNOWLEDGE_SORTS.filter((s) => s !== "delivered" || delivered).map(
                (value) => ({
                  value,
                  label: m.t(`knowledge.sorts.${value}`),
                }),
              )}
            />
          </label>
          <SegmentedControl
            label={m.t("knowledge.status")}
            size="sm"
            value={route.archived ? "archived" : "active"}
            onValueChange={(v) => go({ archived: v === "archived", open: null })}
            options={[
              { value: "active", label: m.t("knowledge.active") },
              { value: "archived", label: m.t("knowledge.archived") },
            ]}
          />
        </div>

        <div className="lc-kn-body">
          <BrowseRail
            browse={browse}
            onBrowse={(next) => {
              setBrowse(next);
              setScope(null);
            }}
            scope={scope}
            onScope={setScope}
            nodes={nodes}
            expanded={expanded}
            onToggle={(path) =>
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              })
            }
            topicCounts={topicCounts}
            topicMix={topicMix}
            topics={index}
            total={kindItems.length}
            naming={topicData?.naming ?? null}
            topicsNote={topicsNote}
            topicsOn={topicsOn}
          />
          <section className="lc-kn-main" aria-label={m.t("knowledge.title")}>
            <div className="lc-kn-scope">
              <span className="lc-kn-scope__label">
                <span className={browse === "paths" && scope ? "pr-mono" : undefined}>
                  {scope === null
                    ? m.t(browse === "paths" ? "knowledge.allPaths" : "knowledge.allTopics")
                    : browse === "paths"
                      ? scope
                      : scope === CONVENTIONS
                        ? m.t("knowledge.conventions")
                        : (index.topics.find((t) => t.id === scope)?.label ?? scope)}
                </span>
                <span className="lc-kn-scope__count pr-mono">{kindNoun(scoped.length)}</span>
              </span>
              {scope !== null ? (
                <button type="button" className="lc-kn-scope__clear" onClick={() => setScope(null)}>
                  {m.t("knowledge.clearScope")} ×
                </button>
              ) : null}
              <div className="lc-kn-health" role="group" aria-label={m.t("knowledge.health")}>
                <button
                  type="button"
                  className="lc-kn-health__chip"
                  aria-pressed={health === "all"}
                  onClick={() => setHealth("all")}
                >
                  {m.t("knowledge.all")}
                  <span className="pr-mono">{m.number(scoped.length)}</span>
                </button>
                {states.map((state) => (
                  <button
                    key={state}
                    type="button"
                    className="lc-kn-health__chip"
                    aria-pressed={health === state}
                    onClick={() => setHealth(health === state ? "all" : state)}
                  >
                    <Swatch color={HEALTH_COLORS[state]} />
                    {stateLabel(state)}
                    <span className="pr-mono">{m.number(healthCounts[state])}</span>
                  </button>
                ))}
              </div>
            </div>
            {body}
          </section>
        </div>
      </div>
      <KnowledgeDrawer
        workspaceId={workspaceId}
        kind={openKind ?? createKind}
        id={openKind ? route.open : null}
        archived={route.archived}
        listItem={openItem}
        delivered={delivered}
        previous={previous}
        topics={index}
        items={kindItems}
        onOpenItem={(item) => go({ open: item.id })}
        onClose={() => go({ open: null })}
        onChanged={() => setVersion((v) => v + 1)}
      />
      {creating ? (
        <KnowledgeEditor
          mode={{ kind: "create", knowledgeKind: createKind }}
          workspaceId={workspaceId}
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            setVersion((v) => v + 1);
            go({ open: id, archived: false });
          }}
        />
      ) : null}
    </Page>
  );
}
