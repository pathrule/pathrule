// SPDX-License-Identifier: Apache-2.0
// The Overview's knowledge cards: health by state and age, coverage by path, recent activity.
import type { KnowledgeKind } from "@pathrule/protocol/local-ui-api.js";
import {
  Badge,
  CardHeader,
  ColumnChart,
  DataList,
  DataTable,
  EmptyPanel,
  LoadError,
  RelativeTime,
  SegmentBar,
  Swatch,
  type ChartColor,
  type Column,
} from "@pathrule/ui";
import { Clock, FolderTree, History, Layers } from "lucide-react";
import { useId, type ReactNode } from "react";
import { useConsole } from "../app/context.js";
import { useLocal } from "../app/use-local.js";
import { useConsoleMessages } from "../messages.js";
import { hrefFor } from "../router.js";
import {
  ageHistogram,
  coverageByPath,
  HEALTH_STATES,
  healthBreakdown,
  KINDS,
  type HealthState,
  type PathRow,
} from "./model.js";
import { KIND_COLORS, Loading, Panel, PanelFooterLink, type OverviewCardData } from "./panel.js";

const HEALTH_COLORS: Record<HealthState, ChartColor> = {
  current: "positive",
  unused: "info",
  stale: "warning",
  unplaced: "danger",
};

/** What every card needs: the workspace, the window and the loaded data. */
/* ── Knowledge health ────────────────────────────────────────────────────── */

export function HealthCard({
  data,
  deliveredMap,
}: {
  data: OverviewCardData;
  deliveredMap: ReadonlyMap<string, number> | null;
}) {
  const m = useConsoleMessages();
  const id = useId();
  const withDeliveries = deliveredMap != null;
  const items = data.items.status === "success" ? data.items.data : null;
  const rangeText = m.t(`overview.range.last.${data.range}`);
  const states: readonly HealthState[] = withDeliveries
    ? HEALTH_STATES
    : ["current", "stale", "unplaced"];
  const stateLabel = (state: HealthState) =>
    !withDeliveries && (state === "current" || state === "stale")
      ? m.t(`overview.health.statesEdits.${state}`)
      : m.t(`overview.health.states.${state}`);
  const stateDetail = (state: HealthState) =>
    !withDeliveries && (state === "current" || state === "stale")
      ? m.t(`overview.health.detailsEdits.${state}`)
      : m.t(`overview.health.details.${state}`);

  let body: ReactNode;
  if (data.items.status === "error") {
    body = (
      <LoadError
        compact
        title={m.t("overview.loadError")}
        error={data.items.error}
        onRetry={data.reloadItems}
      />
    );
  } else if (!items || (withDeliveries && data.stats.status === "loading")) {
    body = <Loading />;
  } else if (items.length === 0) {
    body = (
      <EmptyPanel
        icon={Layers}
        title={m.t("overview.health.empty")}
        ghost={{ columns: ["56%", "32px"] }}
      />
    );
  } else {
    const counts = healthBreakdown(items, deliveredMap, data.now);
    const total = items.length;
    const percent = (n: number) =>
      m.number(total ? n / total : 0, { style: "percent", maximumFractionDigits: 1 });
    const ages = ageHistogram(items, data.now);
    body = (
      <>
        <div className="lc-health__summary">
          <span className="lc-health__headline">
            <span className="lc-health__figure pr-tabular">
              {m.number(counts.current / total, { style: "percent", maximumFractionDigits: 0 })}
            </span>
            <span className="lc-health__caption">
              {m.t(withDeliveries ? "overview.health.headline" : "overview.health.headlineEdits", {
                count: m.number(counts.current),
                total: m.number(total),
              })}
            </span>
          </span>
          <SegmentBar
            size="lg"
            label={m.t("overview.health.label", {
              states: states
                .map((state) => `${stateLabel(state)} ${m.number(counts[state])}`)
                .join(", "),
            })}
            format={(value) => m.plural("knowledge.items", value)}
            segments={states.map((state) => ({
              key: state,
              value: counts[state],
              color: HEALTH_COLORS[state],
              label: stateLabel(state),
            }))}
          />
        </div>
        <DataList
          label={m.t("overview.health.title")}
          rows={states.map((state) => ({
            key: state,
            leading: <Swatch color={HEALTH_COLORS[state]} />,
            title: stateLabel(state),
            meta: stateDetail(state),
            value: m.number(counts[state]),
            detail: percent(counts[state]),
          }))}
        />
        <div className="lc-health__ages">
          <div className="lc-health__ages-head">
            <span className="lc-health__ages-title">{m.t("overview.health.lastEdited")}</span>
            <span className="lc-health__ages-key">
              <span>
                <Swatch color="positive" />
                {m.t("overview.health.within")}
              </span>
              <span>
                <Swatch color="warning" />
                {m.t("overview.health.older")}
              </span>
            </span>
          </div>
          <ColumnChart
            className="lc-panel__grow"
            label={m.t("overview.health.ageLabel")}
            format={(value) => m.number(value)}
            data={ages.map((age) => ({
              key: age.bucket,
              label: m.t(`overview.health.ages.${age.bucket}`),
              value: age.count,
              color: age.stale ? "warning" : "positive",
            }))}
          />
        </div>
      </>
    );
  }

  return (
    <Panel id={id} anchor="overview-health">
      <CardHeader
        id={id}
        title={m.t("overview.health.title")}
        description={
          withDeliveries
            ? m.t("overview.health.description", { range: rangeText })
            : m.t("overview.health.descriptionEdits")
        }
      />
      <div className="lc-panel__grow lc-health">{body}</div>
    </Panel>
  );
}

/* ── Coverage by path ────────────────────────────────────────────────────── */

const COVERAGE_ROWS = 8;
const STALE_MS = 90 * 86_400_000;

export function CoverageCard({
  data,
  deliveredMap,
  folders,
}: {
  data: OverviewCardData;
  deliveredMap: ReadonlyMap<string, number> | null;
  /** Active folders in the workspace tree, or null while it loads. */
  folders: number | null;
}) {
  const m = useConsoleMessages();
  const { navigate } = useConsole();
  const id = useId();
  const items = data.items.status === "success" ? data.items.data : null;
  const rows = items ? coverageByPath(items, deliveredMap) : null;
  const shown = rows?.slice(0, COVERAGE_ROWS) ?? [];
  const largest = shown.length ? Math.max(...shown.map((row) => row.total)) : 1;
  const deliveredTotal = rows?.reduce((sum, row) => sum + (row.deliveries ?? 0), 0) ?? 0;
  const knowledgeHref = hrefFor({
    name: "knowledge",
    workspaceId: data.workspaceId,
    kind: "memory",
    archived: false,
    open: null,
  });

  const columns: Column<PathRow>[] = [
    {
      key: "path",
      header: m.t("overview.coverage.path"),
      width: "28%",
      render: (row) => (
        <span className="pr-mono lc-path" title={row.path}>
          {row.path}
        </span>
      ),
    },
    {
      key: "mix",
      header: m.t("overview.coverage.mix"),
      hideOnMobile: true,
      render: (row) => (
        <span className="lc-coverage__mix">
          <SegmentBar
            size="md"
            scale={row.total / largest}
            format={(value, segment) =>
              m.plural(`kinds.count.${segment.key as KnowledgeKind}`, value)
            }
            segments={KINDS.map((kind) => ({
              key: kind,
              value: row.counts[kind],
              color: KIND_COLORS[kind],
              label: m.t(`kinds.plural.${kind}`),
            }))}
          />
          <span className="pr-text-caption-mono">
            {KINDS.map((kind) => m.number(row.counts[kind])).join(" · ")}
          </span>
        </span>
      ),
    },
    ...(deliveredMap
      ? [
          {
            key: "deliveries",
            header: m.t("overview.coverage.deliveries"),
            align: "end" as const,
            width: "112px",
            render: (row: PathRow) => (
              <span className="lc-coverage__figure">
                <span className="pr-tabular">{m.number(row.deliveries ?? 0)}</span>
                <span className="pr-text-caption-mono">
                  {m.number(deliveredTotal ? (row.deliveries ?? 0) / deliveredTotal : 0, {
                    style: "percent",
                    maximumFractionDigits: 1,
                  })}
                </span>
              </span>
            ),
          },
        ]
      : []),
    {
      key: "updated",
      header: m.t("overview.coverage.updated"),
      align: "end",
      width: "128px",
      render: (row) =>
        data.now - Date.parse(row.updatedAt) >= STALE_MS ? (
          <Badge size="sm" tone="warning" variant="outline">
            <Clock size={11} aria-hidden />
            <RelativeTime iso={row.updatedAt} />
          </Badge>
        ) : (
          <RelativeTime iso={row.updatedAt} className="pr-text-caption-mono" />
        ),
    },
  ];

  let body: ReactNode;
  if (data.items.status === "error") {
    body = (
      <LoadError
        compact
        title={m.t("overview.loadError")}
        error={data.items.error}
        onRetry={data.reloadItems}
      />
    );
  } else if (
    !rows ||
    (deliveredMap == null && !data.deliveriesOff && data.stats.status === "loading")
  ) {
    body = <Loading />;
  } else if (rows.length === 0) {
    body = (
      <EmptyPanel
        icon={FolderTree}
        title={m.t("overview.coverage.empty")}
        description={
          folders
            ? m.plural("overview.coverage.emptyLine", folders, { workspace: data.workspaceName })
            : undefined
        }
        ghost={{ columns: ["24%", "34%", "44px", "56px"] }}
      />
    );
  } else {
    body = (
      <>
        <DataTable
          caption={m.t("overview.coverage.caption")}
          captionHidden
          columns={columns}
          rows={shown}
          rowKey={(row) => row.path}
        />
        {rows.length > shown.length ? (
          <p className="lc-panel__note">
            {m.plural("overview.coverage.more", rows.length - shown.length)}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <Panel id={id}>
      <CardHeader
        id={id}
        title={m.t("overview.coverage.title")}
        description={m.t("overview.coverage.description")}
        actions={
          <a
            className="lc-panel__header-link"
            href={knowledgeHref}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              navigate(knowledgeHref);
            }}
          >
            {m.t("overview.coverage.open")}
          </a>
        }
      />
      {body}
    </Panel>
  );
}

/* ── Recent activity ─────────────────────────────────────────────────────── */

export function ActivityCard({ workspaceId }: { workspaceId: string }) {
  const m = useConsoleMessages();
  const { navigate } = useConsole();
  const id = useId();
  const activity = useLocal("activity.recent", { workspaceId, limit: 6 });
  const allHref = hrefFor({ name: "activity", workspaceId });

  let body: ReactNode;
  if (activity.state.status === "loading") body = <Loading />;
  else if (activity.state.status === "error")
    body = (
      <LoadError
        compact
        title={m.t("overview.activity.error")}
        error={activity.state.error}
        onRetry={activity.reload}
      />
    );
  else if (activity.state.data.entries.length === 0)
    body = (
      <EmptyPanel
        icon={History}
        title={m.t("overview.activity.empty")}
        ghost={{ columns: ["48%", "40px"] }}
      />
    );
  else
    body = (
      <DataList
        label={m.t("overview.activity.label")}
        rows={activity.state.data.entries.map((entry) => ({
          key: entry.id,
          leading: entry.action ? <span className="lc-activity-chip">{entry.action}</span> : null,
          title:
            entry.summary ??
            m.t("overview.activity.fallback", {
              action: entry.action ?? m.t("overview.activity.fallbackAction"),
              domain: entry.domain ?? m.t("overview.activity.fallbackDomain"),
            }),
          meta: (
            <>
              {entry.domain ? <span>{entry.domain}</span> : null}
              {entry.domain && entry.nodePath ? <span aria-hidden>·</span> : null}
              {entry.nodePath ? <span className="pr-mono lc-path">{entry.nodePath}</span> : null}
            </>
          ),
          value: <RelativeTime iso={entry.createdAt} className="pr-text-caption-mono" />,
        }))}
      />
    );

  return (
    <Panel id={id}>
      <CardHeader
        id={id}
        title={m.t("overview.activity.title")}
        description={m.t("overview.activity.description")}
      />
      <div className="lc-panel__grow">{body}</div>
      <PanelFooterLink href={allHref} navigate={navigate}>
        {m.t("overview.activity.all")}
      </PanelFooterLink>
    </Panel>
  );
}
