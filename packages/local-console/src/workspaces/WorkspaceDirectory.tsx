// SPDX-License-Identifier: Apache-2.0
// The Workspaces page, shared by the Local Console and Pathrule Cloud's console: figures over every
// workspace, then a search, a sort and a grid or table of the workspaces, favorites first, a page
// at a time. Summaries and favorites come from the Local UI API (`workspaces.summary`,
// `workspaces.favorite`), so each backend keeps its own: this machine's home locally, the person's
// account in the Cloud. Only the grid-or-table choice is the browser's.
import type {
  LocalWorkspaceSummary,
  WorkspacesSummaryResponse,
} from "@pathrule/protocol/local-ui-api.js";
import {
  Button,
  CommandChip,
  EmptyPanel,
  GhostCards,
  LoadError,
  PageHeader,
  Pagination,
  SearchInput,
  SegmentedControl,
  Select,
  useAsync,
  useToast,
  type MenuEntry,
} from "@pathrule/ui";
import { FolderPlus, LayoutGrid, Rows3, SearchX } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useConsole } from "../app/context.js";
import { useConsoleMessages } from "../messages.js";
import { DirectoryFigures, type DirectoryFiguresText } from "./DirectoryFigures.js";
import {
  arrange,
  directoryFigures,
  directoryRows,
  matchesQuery,
  PAGE_SIZE,
  WORKSPACE_SORTS,
  type WorkspaceSort,
  type WorkspaceView,
} from "./model.js";
import { WorkspaceGrid, WorkspaceTable, type WorkspaceRowContext } from "./WorkspaceCards.js";

const VIEW_KEY = "pathrule.console.workspaces.view";

function storedView(): WorkspaceView {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "table" ? "table" : "grid";
  } catch {
    return "grid";
  }
}

function storeView(view: WorkspaceView): void {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Private windows and blocked storage keep the choice for this visit only.
  }
}

export interface WorkspaceDirectoryProps {
  /** Replaces the page's description. */
  description?: string;
  /** The start of the toolbar: Pathrule Cloud's Active/Archived tabs; locally a label. */
  scope: ReactNode;
  /** Shown instead of the list and its controls, e.g. the archived workspaces. */
  replaceList?: ReactNode;
  figures: DirectoryFiguresText;
  searchHint: string;
  /** The line under a workspace's name: its repository or its folder. */
  describe: WorkspaceRowContext["describe"];
  hrefFor: (workspace: LocalWorkspaceSummary) => string;
  /** The ⋯ menu of one workspace. */
  actions: (workspace: LocalWorkspaceSummary) => readonly MenuEntry[];
  /** The command that creates a workspace, for the empty page. */
  setupCommand: string;
}

export function WorkspaceDirectory({
  description,
  scope,
  replaceList,
  figures: figureText,
  searchHint,
  describe,
  hrefFor,
  actions,
  setupCommand,
}: WorkspaceDirectoryProps) {
  const m = useConsoleMessages();
  const toast = useToast();
  const { api, workspaces, capabilities, navigate } = useConsole();
  const [now] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<WorkspaceSort>("activity");
  const [view, setView] = useState<WorkspaceView>(storedView);
  const [page, setPage] = useState(1);
  const [favorites, setFavorites] = useState<string[] | null>(null);
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());

  const summaryOn = capabilities.workspaceSummary.available;
  const favoritesOn = capabilities.favorites.available;
  const summary = useAsync<WorkspacesSummaryResponse | null>(
    (signal) => (summaryOn ? api.call("workspaces.summary", {}, signal) : Promise.resolve(null)),
    [api, summaryOn],
  );
  const data = summary.state.status === "success" ? summary.state.data : null;
  useEffect(() => {
    if (data) setFavorites(data.favorites);
  }, [data]);

  const favoriteSet = useMemo(() => new Set(favorites ?? []), [favorites]);
  const rows = useMemo(
    () => directoryRows(workspaces, data?.workspaces ?? null, favoriteSet),
    [workspaces, data, favoriteSet],
  );
  const figures = useMemo(() => directoryFigures(rows, now), [rows, now]);
  const arranged = useMemo(
    () =>
      arrange(rows, {
        sort,
        page,
        pageSize: PAGE_SIZE[view],
        keep: (row) => matchesQuery(row.workspace.name, describe(row.workspace)?.text ?? "", query),
      }),
    [rows, sort, page, view, query, describe],
  );

  const onFavorite = async (workspace: LocalWorkspaceSummary, favorite: boolean) => {
    const before = favorites ?? [];
    setFavorites(favorite ? [...before, workspace.id] : before.filter((id) => id !== workspace.id));
    setSaving((current) => new Set(current).add(workspace.id));
    try {
      const answer = await api.call("workspaces.favorite", {
        workspaceId: workspace.id,
        favorite,
      });
      setFavorites(answer.favorites);
    } catch (err) {
      setFavorites(before);
      toast.show({
        title: m.t("workspaces.favoriteFailed"),
        description: err instanceof Error ? err.message : undefined,
        tone: "error",
      });
    } finally {
      setSaving((current) => {
        const next = new Set(current);
        next.delete(workspace.id);
        return next;
      });
    }
  };

  const ctx: WorkspaceRowContext = {
    now,
    describe,
    hrefFor,
    navigate,
    actions,
    onFavorite: (workspace, favorite) => void onFavorite(workspace, favorite),
    saving,
    loaded: !summaryOn || data !== null,
    favorites: favoritesOn,
  };

  const figureState =
    summary.state.status === "success" && data
      ? "ready"
      : summary.state.status === "error" || !summaryOn
        ? "error"
        : "loading";

  let list: ReactNode;
  if (replaceList) list = replaceList;
  else if (workspaces.length === 0)
    list = (
      <div className="lc-ws-panel">
        <EmptyPanel
          icon={FolderPlus}
          title={m.t("workspaces.empty")}
          actions={<CommandChip command={setupCommand} />}
          backdrop={<GhostCards count={9} />}
          className="lc-ws-empty"
        />
      </div>
    );
  else if (arranged.total === 0)
    list = (
      <div className="lc-ws-panel">
        <EmptyPanel
          icon={SearchX}
          title={m.t("workspaces.noMatch", { query: query.trim() })}
          actions={
            <Button size="sm" onClick={() => setQuery("")}>
              {m.t("workspaces.clear")}
            </Button>
          }
          backdrop={view === "grid" ? <GhostCards count={6} /> : undefined}
          ghost={view === "table" ? { columns: ["32%", "18%", "22%", "14%"] } : undefined}
          className="lc-ws-empty"
        />
      </div>
    );
  else
    list = (
      <>
        {view === "grid" ? (
          <WorkspaceGrid page={arranged} sort={sort} ctx={ctx} />
        ) : (
          <WorkspaceTable
            page={arranged}
            sort={sort}
            onSort={(next) => {
              setSort(next);
              setPage(1);
            }}
            ctx={ctx}
          />
        )}
        <Pagination
          page={arranged.page}
          pageSize={PAGE_SIZE[view]}
          total={arranged.total}
          onPageChange={setPage}
          formatRange={(range) =>
            m.t(query.trim() ? "workspaces.rangeMatches" : "workspaces.range", {
              from: m.number(range.from),
              to: m.number(range.to),
              total: m.number(range.total),
            })
          }
        />
      </>
    );

  const controls = !replaceList && workspaces.length > 0;
  return (
    <div className="lc-workspaces">
      <PageHeader
        title={m.t("workspaces.title")}
        description={description ?? m.t("workspaces.description")}
      />
      <DirectoryFigures figures={figures} state={figureState} text={figureText} />
      {summary.state.status === "error" ? (
        <LoadError
          compact
          title={m.t("workspaces.summaryError")}
          error={summary.state.error}
          onRetry={summary.reload}
        />
      ) : null}
      <section className="lc-ws-list" aria-label={m.t("workspaces.title")}>
        <div className="lc-ws-toolbar">
          <div className="lc-ws-toolbar__scope">{scope}</div>
          {controls ? (
            <div className="lc-ws-toolbar__controls">
              <SearchInput
                size="sm"
                wrapperClassName="lc-ws-toolbar__search"
                aria-label={m.t("workspaces.search")}
                placeholder={searchHint}
                value={query}
                onValueChange={(value) => {
                  setQuery(value);
                  setPage(1);
                }}
              />
              <label className="lc-ws-toolbar__sort">
                <span>{m.t("workspaces.sort")}</span>
                <Select
                  size="sm"
                  value={sort}
                  onChange={(event) => {
                    setSort(event.target.value as WorkspaceSort);
                    setPage(1);
                  }}
                  options={WORKSPACE_SORTS.map((value) => ({
                    value,
                    label: m.t(`workspaces.sorts.${value}`),
                  }))}
                />
              </label>
              <SegmentedControl
                label={m.t("workspaces.view")}
                size="sm"
                value={view}
                onValueChange={(next) => {
                  setView(next);
                  storeView(next);
                  setPage(1);
                }}
                options={[
                  {
                    value: "grid",
                    label: null,
                    icon: LayoutGrid,
                    ariaLabel: m.t("workspaces.grid"),
                  },
                  { value: "table", label: null, icon: Rows3, ariaLabel: m.t("workspaces.table") },
                ]}
              />
            </div>
          ) : null}
        </div>
        {list}
      </section>
    </div>
  );
}
