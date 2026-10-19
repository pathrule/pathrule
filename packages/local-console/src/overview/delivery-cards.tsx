// SPDX-License-Identifier: Apache-2.0
// The Overview's delivery cards: deliveries by kind over the window, and the top knowledge.
import type { KnowledgeKind, KnowledgeListItem } from "@pathrule/protocol/local-ui-api.js";
import {
  CardHeader,
  ChartLegend,
  DataList,
  DataTable,
  EmptyPanel,
  LoadError,
  SegmentedControl,
  StackedBarChart,
  StateMessage,
  StatStrip,
  Swatch,
  type ChartBucket,
} from "@pathrule/ui";
import { ArrowUpRight, BarChart3 } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useConsole } from "../app/context.js";
import { useConsoleMessages } from "../messages.js";
import { hrefFor } from "../router.js";
import { KINDS, summarizeDeliveries, topKnowledge, type TopMode } from "./model.js";
import {
  KIND_COLORS,
  Loading,
  Panel,
  PanelFooterLink,
  Unavailable,
  type OverviewCardData,
} from "./panel.js";

/* ── Deliveries ──────────────────────────────────────────────────────────── */

export function DeliveriesCard({ data }: { data: OverviewCardData }) {
  const m = useConsoleMessages();
  const id = useId();
  const [view, setView] = useState<"chart" | "table">("chart");
  const rangeText = m.t(`overview.range.last.${data.range}`);
  const day = (date: string, options: Intl.DateTimeFormatOptions) =>
    m.dateTime(`${date}T00:00:00Z`, { ...options, timeZone: "UTC" });
  const stats = data.stats.status === "success" ? data.stats.data : null;
  const summary = stats ? summarizeDeliveries(stats) : null;

  let body: ReactNode;
  if (data.deliveriesOff) {
    body = (
      <Unavailable title={m.t("overview.deliveries.unavailable")} reason={data.deliveriesOff} />
    );
  } else if (data.stats.status === "loading") {
    body = <Loading />;
  } else if (data.stats.status === "error") {
    body = (
      <LoadError
        compact
        title={m.t("overview.deliveries.error")}
        error={data.stats.error}
        onRetry={data.reloadStats}
      />
    );
  } else if (stats && summary) {
    const every = stats.days.length <= 7 ? 1 : stats.days.length <= 30 ? 7 : 15;
    const buckets: ChartBucket<KnowledgeKind>[] = stats.days.map((entry, index) => ({
      key: entry.date,
      label: day(entry.date, { weekday: "short", month: "short", day: "numeric" }),
      tick:
        (stats.days.length - 1 - index) % every === 0
          ? day(entry.date, { month: "short", day: "numeric" })
          : "",
      values: { memory: entry.memory, rule: entry.rule, skill: entry.skill },
    }));
    const series = KINDS.map((kind) => ({
      key: kind,
      label: m.t(`kinds.plural.${kind}`),
      color: KIND_COLORS[kind],
    }));
    const label = m.t("overview.deliveries.chartLabel", { range: rangeText });
    body = (
      <div className="lc-panel__body lc-panel__body--chart">
        {summary.total > 0 ? (
          <ChartLegend
            items={KINDS.map((kind) => ({
              key: kind,
              label: m.t(`kinds.plural.${kind}`),
              color: KIND_COLORS[kind],
              value: m.number(summary.byKind[kind]),
              detail: m.number(summary.byKind[kind] / summary.total, {
                style: "percent",
                maximumFractionDigits: 0,
              }),
            }))}
          />
        ) : null}
        {view === "chart" || summary.total === 0 ? (
          <StackedBarChart
            series={series}
            buckets={buckets}
            label={label}
            format={(value) => m.number(value)}
            empty={
              <StateMessage
                compact
                icon={BarChart3}
                title={m.t("overview.deliveries.empty")}
                description={m.t("overview.deliveries.emptyLine")}
              />
            }
          />
        ) : (
          <div className="lc-panel__scroll">
            <DataTable
              caption={label}
              captionHidden
              rows={[...buckets].reverse()}
              rowKey={(bucket) => bucket.key}
              columns={[
                {
                  key: "date",
                  header: m.t("overview.deliveries.date"),
                  render: (bucket) => <span className="pr-mono">{bucket.label}</span>,
                },
                ...series.map((entry) => ({
                  key: entry.key,
                  header: entry.label,
                  align: "end" as const,
                  render: (bucket: ChartBucket<KnowledgeKind>) =>
                    m.number(bucket.values[entry.key]),
                })),
                {
                  key: "total",
                  header: m.t("overview.deliveries.total"),
                  align: "end",
                  render: (bucket) =>
                    m.number(KINDS.reduce((sum, kind) => sum + bucket.values[kind], 0)),
                },
              ]}
            />
          </div>
        )}
      </div>
    );
  }

  const dash = "—";
  return (
    <Panel id={id}>
      <CardHeader
        id={id}
        title={m.t("overview.deliveries.title")}
        description={m.t("overview.deliveries.description", { range: rangeText })}
        actions={
          stats && summary && summary.total > 0 ? (
            <SegmentedControl
              label={m.t("overview.deliveries.showAs")}
              size="sm"
              value={view}
              onValueChange={setView}
              options={[
                { value: "chart", label: m.t("overview.deliveries.chart") },
                { value: "table", label: m.t("overview.deliveries.table") },
              ]}
            />
          ) : undefined
        }
      />
      {body}
      {data.deliveriesOff ? null : (
        <StatStrip
          label={m.t("overview.deliveries.summary")}
          items={[
            {
              key: "average",
              label: m.t("overview.deliveries.average"),
              value: summary?.total ? m.number(Math.round(summary.average)) : dash,
              detail: summary?.total ? m.t("overview.deliveries.averageDetail") : undefined,
            },
            {
              key: "busiest",
              label: m.t("overview.deliveries.busiest"),
              value: summary?.busiest ? m.number(summary.busiest.total) : dash,
              detail: summary?.busiest
                ? day(summary.busiest.date, { weekday: "short", month: "short", day: "numeric" })
                : undefined,
            },
            {
              key: "quietest",
              label: m.t("overview.deliveries.quietest"),
              value: summary?.quietest ? m.number(summary.quietest.total) : dash,
              detail: summary?.quietest
                ? day(summary.quietest.date, { weekday: "short", month: "short", day: "numeric" })
                : undefined,
            },
            {
              key: "weekends",
              label: m.t("overview.deliveries.weekends"),
              value:
                summary?.weekendShare != null
                  ? m.number(summary.weekendShare, { style: "percent", maximumFractionDigits: 0 })
                  : dash,
              detail:
                summary?.weekendShare != null
                  ? m.t("overview.deliveries.weekendsDetail")
                  : undefined,
            },
          ]}
        />
      )}
    </Panel>
  );
}

/* ── Top knowledge ───────────────────────────────────────────────────────── */

function itemHref(workspaceId: string, item: KnowledgeListItem): string {
  return hrefFor({
    name: "knowledge",
    workspaceId,
    kind: item.kind,
    archived: false,
    open: item.id,
  });
}

export function TopKnowledgeCard({ data }: { data: OverviewCardData }) {
  const m = useConsoleMessages();
  const { navigate } = useConsole();
  const id = useId();
  const [mode, setMode] = useState<TopMode>("delivered");
  const rangeText = m.t(`overview.range.last.${data.range}`);
  const items = data.items.status === "success" ? data.items.data : null;
  const stats = data.stats.status === "success" ? data.stats.data : null;
  const rows = items && stats ? topKnowledge(items, stats, mode) : null;
  const total = stats ? summarizeDeliveries(stats).total : 0;
  const max = rows?.length ? Math.max(...rows.map((row) => row.value)) : 1;
  const listHref = hrefFor({
    name: "knowledge",
    workspaceId: data.workspaceId,
    kind: "memory",
    archived: false,
    open: null,
  });

  let body: ReactNode;
  if (data.deliveriesOff) {
    body = (
      <Unavailable title={m.t("overview.deliveries.unavailable")} reason={data.deliveriesOff} />
    );
  } else if (data.items.status === "error") {
    body = (
      <LoadError
        compact
        title={m.t("overview.loadError")}
        error={data.items.error}
        onRetry={data.reloadItems}
      />
    );
  } else if (data.stats.status === "error") {
    body = (
      <LoadError
        compact
        title={m.t("overview.deliveries.error")}
        error={data.stats.error}
        onRetry={data.reloadStats}
      />
    );
  } else if (!rows) {
    body = <Loading />;
  } else if (rows.length === 0) {
    body = (
      <EmptyPanel
        icon={ArrowUpRight}
        title={m.t(mode === "rising" ? "overview.top.emptyRising" : "overview.top.empty")}
        ghost={{ columns: ["56%", "120px", "40px"] }}
      />
    );
  } else {
    body = (
      <DataList
        label={m.t("overview.top.title")}
        ordered
        onNavigate={navigate}
        header={{
          title: m.t("overview.top.item"),
          value: m.t(mode === "rising" ? "overview.top.gain" : "overview.top.deliveries"),
        }}
        rows={rows.map((row) => ({
          key: `${row.item.kind}:${row.item.id}`,
          leading: <Swatch color={KIND_COLORS[row.item.kind]} />,
          title: row.item.title,
          meta: (
            <>
              <span>{m.t(`kinds.title.${row.item.kind}`)}</span>
              <span aria-hidden>·</span>
              <span className="pr-mono lc-path">{row.item.path ?? m.t("knowledge.unplaced")}</span>
            </>
          ),
          fraction: row.value / max,
          barColor: "neutral",
          value: mode === "rising" ? `+${m.number(row.value)}` : m.number(row.value),
          detail:
            mode === "rising"
              ? m.t("overview.top.now", { count: m.number(row.count) })
              : m.number(total ? row.value / total : 0, {
                  style: "percent",
                  maximumFractionDigits: 1,
                }),
          href: itemHref(data.workspaceId, row.item),
        }))}
      />
    );
  }

  return (
    <Panel id={id}>
      <CardHeader
        id={id}
        title={m.t("overview.top.title")}
        description={
          mode === "rising"
            ? m.t("overview.top.risingNote", {
                previous: m.t(`overview.range.previous.${data.range}`),
              })
            : m.t("overview.top.deliveredNote", { range: rangeText })
        }
        actions={
          data.deliveriesOff ? undefined : (
            <SegmentedControl
              label={m.t("overview.top.rankBy")}
              size="sm"
              value={mode}
              onValueChange={setMode}
              options={[
                { value: "delivered", label: m.t("overview.top.delivered") },
                { value: "rising", label: m.t("overview.top.rising") },
              ]}
            />
          )
        }
      />
      <div className="lc-panel__grow">{body}</div>
      <PanelFooterLink href={listHref} navigate={navigate}>
        {m.t("overview.top.viewAll")}
      </PanelFooterLink>
    </Panel>
  );
}
