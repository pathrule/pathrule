// SPDX-License-Identifier: Apache-2.0
// The Overview's key figures. Every card keeps one anatomy (MetricGrid): label, the value with at
// most one qualifier (a change or a state), a 24px visual, and two lines of detail.
import type {
  DeliveryStatsResponse,
  DeliveryStatsWindow,
  KnowledgeKind,
  KnowledgeListItem,
} from "@pathrule/protocol/local-ui-api.js";
import type { TreeNode } from "@pathrule/protocol/node-types.js";
import {
  MetricCard,
  MetricGrid,
  SegmentBar,
  Sparkbars,
  Sparkline,
  Swatch,
  UnitBar,
  type AsyncState,
} from "@pathrule/ui";
import { ArrowUpRight, Clock, FolderTree, Layers, Radio, TriangleAlert } from "lucide-react";
import { useConsole } from "../app/context.js";
import { useLocal } from "../app/use-local.js";
import { useConsoleMessages } from "../messages.js";
import { hrefFor } from "../router.js";
import { KIND_COLORS } from "./panel.js";
import {
  ageHistogram,
  countByKind,
  deliveriesByItem,
  folderCoverage,
  healthBreakdown,
  KINDS,
  STALE_DAYS,
  summarizeDeliveries,
} from "./model.js";

const DAY_MS = 86_400_000;

export function KeyFigures({
  workspaceId,
  items,
  stats,
  deliveriesOff,
  range,
  folders,
  now,
  onNavigate,
}: {
  workspaceId: string;
  items: AsyncState<KnowledgeListItem[]>;
  stats: AsyncState<DeliveryStatsResponse | null>;
  deliveriesOff: string | null;
  range: DeliveryStatsWindow;
  folders: readonly TreeNode[] | null;
  now: number;
  onNavigate: (href: string) => void;
}) {
  const m = useConsoleMessages();
  const { capabilities } = useConsole();
  const list = items.status === "success" ? items.data : null;
  const counts = list ? countByKind(list) : null;
  const total = list?.length ?? 0;
  const statsData = stats.status === "success" ? stats.data : null;
  const summary = statsData ? summarizeDeliveries(statsData) : null;
  const coverage = list && folders ? folderCoverage(folders, list) : null;
  const health =
    list && !deliveriesOff && statsData
      ? healthBreakdown(list, deliveriesByItem(statsData), now)
      : null;
  const staleByEdit = list
    ? list.filter((item) => now - Date.parse(item.updatedAt) >= STALE_DAYS * DAY_MS).length
    : null;
  const staleCount = deliveriesOff ? staleByEdit : (health?.stale ?? null);
  const knowledgeHref = hrefFor({
    name: "knowledge",
    workspaceId,
    kind: "memory",
    archived: false,
    open: null,
  });
  const percent = (value: number) =>
    m.number(value, { style: "percent", maximumFractionDigits: 0 });
  /** A figure, or what stands in for it while it loads or after it failed. */
  const figure = (value: string | null) =>
    value ?? (items.status === "error" ? m.t("overview.kpi.unavailable") : "…");

  return (
    <MetricGrid label={m.t("overview.kpi.label")}>
      <MetricCard
        label={m.t("overview.kpi.items")}
        icon={Layers}
        value={figure(counts ? m.number(total) : null)}
        empty={total === 0}
        href={knowledgeHref}
        onNavigate={onNavigate}
        visual={
          <SegmentBar
            size="sm"
            format={(value, segment) =>
              m.plural(`kinds.count.${segment.key as KnowledgeKind}`, value)
            }
            segments={KINDS.map((kind) => ({
              key: kind,
              value: counts?.[kind] ?? 0,
              color: KIND_COLORS[kind],
              label: m.t(`kinds.plural.${kind}`),
            }))}
          />
        }
        detail={
          counts && total > 0 ? (
            <span className="lc-figure-legend">
              {KINDS.map((kind) => (
                <span key={kind}>
                  <Swatch color={KIND_COLORS[kind]} />
                  {m.plural(`kinds.count.${kind}`, counts[kind])}
                </span>
              ))}
            </span>
          ) : counts ? (
            m.t("overview.kpi.itemsEmpty")
          ) : undefined
        }
      />

      <MetricCard
        label={m.t("overview.kpi.deliveries")}
        icon={ArrowUpRight}
        value={deliveriesOff ? "—" : summary ? m.number(summary.total) : "…"}
        empty={deliveriesOff != null || summary?.total === 0}
        delta={
          summary && summary.change != null
            ? {
                value: `${summary.change >= 0 ? "+" : ""}${m.number(summary.change / 100, {
                  style: "percent",
                  maximumFractionDigits: 1,
                })}`,
                direction: summary.change > 0 ? "up" : summary.change < 0 ? "down" : "flat",
                tone: summary.change > 0 ? "positive" : summary.change < 0 ? "danger" : "neutral",
              }
            : undefined
        }
        visual={
          <Sparkline
            values={statsData ? statsData.days.map((day) => day.memory + day.rule + day.skill) : []}
          />
        }
        detail={
          deliveriesOff
            ? [m.t("overview.kpi.deliveriesOff"), deliveriesOff]
            : summary && statsData
              ? summary.total === 0
                ? [m.t("overview.kpi.deliveriesEmpty"), m.t("overview.kpi.deliveriesEmptyLine")]
                : [
                    m.t(
                      summary.change != null
                        ? `overview.range.previous.${range}`
                        : `overview.range.last.${range}`,
                    ),
                    statsData.previousTotal > 0
                      ? m.t("overview.kpi.previousCount", {
                          count: m.number(statsData.previousTotal),
                          days: m.number(range),
                        })
                      : m.t("overview.kpi.previousNone", { days: m.number(range) }),
                  ]
              : undefined
        }
      />

      <MetricCard
        label={m.t("overview.kpi.coverage")}
        icon={FolderTree}
        value={figure(
          coverage ? (coverage.total ? percent(coverage.covered / coverage.total) : "—") : null,
        )}
        empty={!coverage || coverage.covered === 0}
        visual={
          <SegmentBar
            size="sm"
            track
            scale={coverage?.total ? coverage.covered / coverage.total : 0}
            format={(value) => m.plural("overview.kpi.folders", value)}
            segments={[
              {
                key: "covered",
                value: coverage?.covered ?? 0,
                color: "neutral",
                label: m.t("overview.kpi.coveredPart"),
              },
            ]}
          />
        }
        detail={
          coverage
            ? coverage.total
              ? [
                  m.t("overview.kpi.coverageDetail", {
                    covered: m.number(coverage.covered),
                    total: m.number(coverage.total),
                  }),
                  m.plural("overview.kpi.coverageMissing", coverage.total - coverage.covered),
                ]
              : [m.t("overview.kpi.coverageEmpty"), m.t("overview.kpi.coverageEmptyLine")]
            : undefined
        }
      />

      <MetricCard
        label={m.t(deliveriesOff ? "overview.kpi.staleEdits" : "overview.kpi.stale")}
        icon={Clock}
        value={figure(staleCount == null ? null : m.number(staleCount))}
        empty={staleCount === 0}
        href="#overview-health"
        status={
          staleCount
            ? { label: m.t("overview.kpi.review"), tone: "warning", icon: TriangleAlert }
            : undefined
        }
        visual={
          <Sparkbars
            format={(value) => m.plural("knowledge.items", value)}
            bars={(list ? ageHistogram(list, now) : []).map((age) => ({
              key: age.bucket,
              value: age.count,
              color: age.stale ? "warning" : "positive",
              label: m.t("overview.health.ageTip", {
                age: m.t(`overview.health.ages.${age.bucket}`),
              }),
              note: m.t(`overview.health.detailsEdits.${age.stale ? "stale" : "current"}`),
            }))}
          />
        }
        detail={
          staleCount == null
            ? undefined
            : staleCount === 0
              ? [m.t("overview.kpi.staleNone"), m.t("overview.kpi.staleNoneLine")]
              : [
                  m.t("overview.kpi.staleLine"),
                  m.t(
                    deliveriesOff ? "overview.kpi.staleEditsLine" : "overview.kpi.staleDelivered",
                  ),
                ]
        }
      />

      {capabilities.runtimeEvents.available ? (
        <SignalsFigure workspaceId={workspaceId} onNavigate={onNavigate} />
      ) : null}
    </MetricGrid>
  );
}

function SignalsFigure({
  workspaceId,
  onNavigate,
}: {
  workspaceId: string;
  onNavigate: (href: string) => void;
}) {
  const m = useConsoleMessages();
  const signals = useLocal("signals.status", { workspaceId });
  const status = signals.state.status === "success" ? signals.state.data.status : null;
  const href = hrefFor({
    name: "signals",
    workspaceId,
    view: status && !status.connected ? "setup" : "overview",
    group: null,
  });
  const connected = status?.connected === true;
  return (
    <MetricCard
      label={m.t("overview.kpi.signals")}
      icon={Radio}
      value={
        status
          ? connected
            ? m.number(status.activeCount)
            : "—"
          : signals.state.status === "error"
            ? m.t("overview.kpi.unavailable")
            : "…"
      }
      empty={!connected || status?.activeCount === 0}
      href={href}
      onNavigate={onNavigate}
      status={
        connected && status && status.activeCount > 0
          ? { label: m.t("overview.kpi.signalsActive"), tone: "danger" }
          : undefined
      }
      visual={
        <UnitBar
          filled={connected ? (status?.activeCount ?? 0) : 0}
          total={connected ? (status?.groupCount ?? 0) : 0}
          color="danger"
        />
      }
      detail={
        status
          ? connected
            ? [
                m.t("overview.kpi.signalsGroups", {
                  active: m.number(status.activeCount),
                  total: m.number(status.groupCount),
                }),
                status.lastSeen
                  ? m.t("overview.kpi.signalsLast", { time: m.relative(status.lastSeen) })
                  : m.t("overview.kpi.signalsQuiet"),
              ]
            : [m.t("overview.kpi.signalsNotConnected"), m.t("overview.kpi.signalsConnect")]
          : undefined
      }
    />
  );
}
