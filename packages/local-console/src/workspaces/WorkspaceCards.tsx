// SPDX-License-Identifier: Apache-2.0
// One workspace as a grid card or a table row: its name and where it lives, knowledge by kind,
// deliveries over 30 days, the latest activity and active Signals. Both open the workspace's
// overview; the star and the menu sit above that link.
import type { KnowledgeKind, LocalWorkspaceSummary } from "@pathrule/protocol/local-ui-api.js";
import {
  Badge,
  DataTable,
  FavoriteButton,
  GroupHeading,
  IconButton,
  Menu,
  Monogram,
  RelativeTime,
  RowTitle,
  SegmentBar,
  Sparkline,
  type Column,
  type MenuEntry,
} from "@pathrule/ui";
import { Ellipsis, Folder, GitBranch, Radio, Star } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { useConsoleMessages } from "../messages.js";
import { KIND_COLORS } from "../overview/panel.js";
import {
  activityTone,
  deliveryChange,
  type DirectoryPage,
  type DirectoryRow,
  type WorkspaceSort,
} from "./model.js";

const KINDS = ["memory", "rule", "skill"] as const;

/** What the cards and rows need from the page. */
export interface WorkspaceRowContext {
  now: number;
  /** The line under a workspace's name: its repository or folder; null where none is known. */
  describe: (
    workspace: LocalWorkspaceSummary,
  ) => { text: string; kind: "repository" | "folder" } | null;
  hrefFor: (workspace: LocalWorkspaceSummary) => string;
  navigate: (href: string) => void;
  actions: (workspace: LocalWorkspaceSummary) => readonly MenuEntry[];
  onFavorite: (workspace: LocalWorkspaceSummary, favorite: boolean) => void;
  /** Workspaces whose favorite change is being saved. */
  saving: ReadonlySet<string>;
  /** False until the summaries arrive: figures show a placeholder. */
  loaded: boolean;
  /** Favorites can be kept by this backend. */
  favorites: boolean;
}

function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

const DOT: Record<ReturnType<typeof activityTone>, string> = {
  recent: "lc-ws-dot--recent",
  week: "lc-ws-dot--idle",
  idle: "lc-ws-dot--idle",
  quiet: "lc-ws-dot--quiet",
  none: "lc-ws-dot--none",
};

/** "Active 2h ago", "Last active Aug 27, 2026" past the quiet line, or "No activity yet". */
function Activity({ row, now, short }: { row: DirectoryRow; now: number; short?: boolean }) {
  const m = useConsoleMessages();
  const at = row.summary?.lastActivityAt ?? null;
  const tone = activityTone(at, now);
  return (
    <span className="lc-ws-activity">
      <span aria-hidden className={`lc-ws-dot ${DOT[tone]}`} />
      {at ? (
        <span className="lc-ws-activity__text">
          {short ? null : (
            <>{m.t(tone === "quiet" ? "workspaces.lastActive" : "workspaces.activeAgo")} </>
          )}
          <RelativeTime iso={at} />
        </span>
      ) : (
        <span className="lc-ws-activity__text">{m.t("workspaces.never")}</span>
      )}
    </span>
  );
}

function Where({ workspace, ctx }: { workspace: LocalWorkspaceSummary; ctx: WorkspaceRowContext }) {
  const where = ctx.describe(workspace);
  if (!where) return null;
  const Icon = where.kind === "repository" ? GitBranch : Folder;
  return (
    <span className="lc-ws-where" title={where.text}>
      <Icon size={12} strokeWidth={1.75} aria-hidden />
      <span className="lc-ws-where__text">{where.text}</span>
    </span>
  );
}

function Mix({ row, scale }: { row: DirectoryRow; scale?: number }) {
  const m = useConsoleMessages();
  const items = row.summary?.items;
  return (
    <SegmentBar
      size="sm"
      scale={scale}
      label={
        items
          ? m.t("workspaces.mix", {
              memories: m.number(items.memory),
              rules: m.number(items.rule),
              skills: m.number(items.skill),
            })
          : undefined
      }
      format={(value, segment) => m.plural(`kinds.count.${segment.key as KnowledgeKind}`, value)}
      segments={KINDS.map((kind) => ({
        key: kind,
        value: items?.[kind] ?? 0,
        color: KIND_COLORS[kind],
        label: m.t(`kinds.plural.${kind}`),
      }))}
    />
  );
}

function Change({ row }: { row: DirectoryRow }) {
  const m = useConsoleMessages();
  const change = row.summary ? deliveryChange(row.delivered, row.summary.previousDeliveries) : null;
  if (change == null || row.delivered === 0) return null;
  return (
    <span className={`lc-ws-change ${change < 0 ? "lc-ws-change--down" : "lc-ws-change--up"}`}>
      {change >= 0 ? "+" : "−"}
      {m.number(Math.abs(change) / 100, { style: "percent", maximumFractionDigits: 0 })}
    </span>
  );
}

function Signals({ row }: { row: DirectoryRow }) {
  const m = useConsoleMessages();
  const active = row.summary?.activeSignals ?? 0;
  if (active <= 0) return null;
  return (
    <Badge size="sm" tone="danger" icon={Radio}>
      {m.plural("workspaces.signals", active)}
    </Badge>
  );
}

function MoreActions({
  workspace,
  ctx,
}: {
  workspace: LocalWorkspaceSummary;
  ctx: WorkspaceRowContext;
}) {
  const m = useConsoleMessages();
  const label = m.t("workspaces.more", { name: workspace.name });
  return (
    <span className="lc-ws-over" onClick={(event) => event.stopPropagation()}>
      <Menu
        label={label}
        items={ctx.actions(workspace)}
        trigger={<IconButton icon={Ellipsis} label={label} tooltip={false} size="sm" />}
      />
    </span>
  );
}

function figure(ctx: WorkspaceRowContext, value: string): string {
  return ctx.loaded ? value : "…";
}

/** One workspace as a card: the whole card opens its overview. */
export function WorkspaceCard({ row, ctx }: { row: DirectoryRow; ctx: WorkspaceRowContext }) {
  const m = useConsoleMessages();
  const { workspace } = row;
  const href = ctx.hrefFor(workspace);
  return (
    <article className="lc-ws-card">
      <div className="lc-ws-card__head">
        <Monogram name={workspace.name} />
        <div className="lc-ws-card__title">
          <span className="lc-ws-card__name-line">
            <a
              className="lc-ws-card__name"
              href={href}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                ctx.navigate(href);
              }}
            >
              {workspace.name}
            </a>
            {workspace.current ? (
              <Badge size="sm" tone="accent">
                {m.t("workspaces.thisFolder")}
              </Badge>
            ) : null}
          </span>
          <Where workspace={workspace} ctx={ctx} />
        </div>
        {ctx.favorites ? (
          <FavoriteButton
            name={workspace.name}
            favorite={row.favorite}
            busy={ctx.saving.has(workspace.id)}
            onToggle={() => ctx.onFavorite(workspace, !row.favorite)}
          />
        ) : null}
        <MoreActions workspace={workspace} ctx={ctx} />
      </div>

      <div className="lc-ws-card__figures">
        <div className="lc-ws-card__figure">
          <span className="lc-ws-card__label">{m.t("workspaces.knowledge")}</span>
          <span
            className={`lc-ws-card__value pr-tabular${row.items === 0 ? " lc-ws-card__value--zero" : ""}`}
          >
            {figure(ctx, m.number(row.items))}
          </span>
          <span className="lc-ws-card__visual">
            <Mix row={row} />
          </span>
        </div>
        <div className="lc-ws-card__figure">
          <span className="lc-ws-card__label">{m.t("workspaces.deliveries")}</span>
          <span className="lc-ws-card__value-line">
            <span
              className={`lc-ws-card__value pr-tabular${row.delivered === 0 ? " lc-ws-card__value--zero" : ""}`}
            >
              {figure(
                ctx,
                row.delivered > 0 ? m.number(row.delivered, { notation: "compact" }) : "—",
              )}
            </span>
            <Change row={row} />
          </span>
          <span className="lc-ws-card__visual">
            <Sparkline values={row.summary?.deliveries ?? []} color="neutral" />
          </span>
        </div>
      </div>

      <div className="lc-ws-card__foot">
        {ctx.loaded ? <Activity row={row} now={ctx.now} /> : <span className="lc-ws-activity" />}
        <span className="lc-ws-card__badges">
          <Signals row={row} />
        </span>
      </div>
    </article>
  );
}

/** The cards of one page, under a heading per group. */
export function WorkspaceGrid({
  page,
  sort,
  ctx,
}: {
  page: DirectoryPage;
  sort: WorkspaceSort;
  ctx: WorkspaceRowContext;
}) {
  return (
    <div className="lc-ws-grid">
      {page.groups.map((group) => (
        <section key={group.favorite ? "favorites" : "others"} className="lc-ws-grid__group">
          <GroupHeadingFor page={page} favorite={group.favorite} sort={sort} />
          <div className="lc-ws-grid__cards">
            {group.rows.map((row) => (
              <WorkspaceCard key={row.workspace.id} row={row} ctx={ctx} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** "Favorites 3 —— latest activity first", or the rest's heading; none when nothing is a favorite. */
function GroupHeadingFor({
  page,
  favorite,
  sort,
}: {
  page: DirectoryPage;
  favorite: boolean;
  sort: WorkspaceSort;
}): ReactNode {
  const m = useConsoleMessages();
  if (page.favorites === 0) return null;
  return (
    <GroupHeading
      level={3}
      icon={favorite ? <Star size={12} fill="currentColor" aria-hidden /> : undefined}
      title={m.t(favorite ? "workspaces.favorites" : "workspaces.others")}
      count={m.number(favorite ? page.favorites : page.others)}
      note={m.t(`workspaces.order.${sort}`)}
    />
  );
}

const SORT_DIRECTION: Record<WorkspaceSort, "ascending" | "descending"> = {
  name: "ascending",
  items: "descending",
  deliveries: "descending",
  activity: "descending",
};

/** The same page as rows; the column headers sort as the toolbar does. */
export function WorkspaceTable({
  page,
  sort,
  onSort,
  ctx,
}: {
  page: DirectoryPage;
  sort: WorkspaceSort;
  onSort: (sort: WorkspaceSort) => void;
  ctx: WorkspaceRowContext;
}) {
  const m = useConsoleMessages();
  const rows = page.groups.flatMap((group) => group.rows);
  const largest = Math.max(1, ...rows.map((row) => row.items));
  const columns: Column<DirectoryRow, WorkspaceSort | "favorite" | "actions">[] = [
    ...(ctx.favorites
      ? [
          {
            key: "favorite" as const,
            header: <span className="pr-sr-only">{m.t("workspaces.columns.favorite")}</span>,
            label: m.t("workspaces.columns.favorite"),
            width: "44px",
            render: (row: DirectoryRow) => (
              <FavoriteButton
                size="sm"
                name={row.workspace.name}
                favorite={row.favorite}
                busy={ctx.saving.has(row.workspace.id)}
                onToggle={() => ctx.onFavorite(row.workspace, !row.favorite)}
              />
            ),
          },
        ]
      : []),
    {
      key: "name",
      header: m.t("workspaces.columns.workspace"),
      sortable: true,
      render: (row) => (
        <span className="lc-ws-row__title">
          <Monogram name={row.workspace.name} size="sm" />
          <span className="lc-ws-row__names">
            <span className="lc-ws-card__name-line">
              <RowTitle mono onOpen={() => ctx.navigate(ctx.hrefFor(row.workspace))}>
                {row.workspace.name}
              </RowTitle>
              {row.workspace.current ? (
                <Badge size="sm" tone="accent">
                  {m.t("workspaces.thisFolder")}
                </Badge>
              ) : null}
            </span>
            <Where workspace={row.workspace} ctx={ctx} />
          </span>
        </span>
      ),
    },
    {
      key: "items",
      header: m.t("workspaces.columns.knowledge"),
      sortable: true,
      width: "18%",
      hideOnMobile: true,
      render: (row) => (
        <span className="lc-ws-row__figure">
          <span className="pr-tabular">{figure(ctx, m.number(row.items))}</span>
          <span className="lc-ws-row__bar">
            <Mix row={row} scale={row.items / largest} />
          </span>
        </span>
      ),
    },
    {
      key: "deliveries",
      header: m.t("workspaces.columns.deliveries"),
      sortable: true,
      width: "22%",
      render: (row) => (
        <span className="lc-ws-row__figure">
          <span className="lc-ws-row__spark" aria-hidden>
            <Sparkline values={row.summary?.deliveries ?? []} color="neutral" />
          </span>
          <span className="lc-ws-row__number">
            <span className="pr-tabular">
              {figure(ctx, row.delivered > 0 ? m.number(row.delivered) : "—")}
            </span>
            <Change row={row} />
          </span>
        </span>
      ),
    },
    {
      key: "activity",
      header: m.t("workspaces.columns.activity"),
      sortable: true,
      width: "18%",
      render: (row) => (
        <span className="lc-ws-row__activity">
          {ctx.loaded ? <Activity row={row} now={ctx.now} short /> : "…"}
          <Signals row={row} />
        </span>
      ),
    },
    {
      key: "actions",
      header: <span className="pr-sr-only">{m.t("workspaces.columns.actions")}</span>,
      label: m.t("workspaces.columns.actions"),
      width: "52px",
      align: "end",
      actions: true,
      render: (row) => <MoreActions workspace={row.workspace} ctx={ctx} />,
    },
  ];
  return (
    <DataTable
      caption={m.t("workspaces.title")}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.workspace.id}
      sort={{ key: sort, direction: SORT_DIRECTION[sort] }}
      onSortChange={(next) => {
        if (next.key !== "favorite" && next.key !== "actions") onSort(next.key);
      }}
      onRowClick={(row) => ctx.navigate(ctx.hrefFor(row.workspace))}
      rowGroup={
        page.favorites > 0
          ? (row) => ({
              key: row.favorite ? "favorites" : "others",
              heading: <GroupHeadingFor page={page} favorite={row.favorite} sort={sort} />,
            })
          : undefined
      }
      className="lc-ws-table"
    />
  );
}
