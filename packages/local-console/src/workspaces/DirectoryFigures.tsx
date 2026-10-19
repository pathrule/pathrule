// SPDX-License-Identifier: Apache-2.0
// The figures above the workspace list, over every workspace whatever the search or page. The same
// anatomy as the Overview's key figures (MetricGrid): label, value with at most one qualifier, a
// 24px visual, two lines of detail.
import type { KnowledgeKind } from "@pathrule/protocol/local-ui-api.js";
import {
  MetricCard,
  MetricGrid,
  SegmentBar,
  Sparkbars,
  Sparkline,
  Swatch,
  type ChartColor,
} from "@pathrule/ui";
import { ArrowUpRight, Clock, FolderClosed, Layers, TriangleAlert } from "lucide-react";
import { useConsoleMessages } from "../messages.js";
import { KIND_COLORS } from "../overview/panel.js";
import type { DirectoryFigures as Figures } from "./model.js";

const KINDS = ["memory", "rule", "skill"] as const;
const AGE_KEYS = ["today", "week", "month", "quarter", "older"] as const;
const AGE_COLORS: readonly ChartColor[] = [
  "positive",
  "positive",
  "positive",
  "warning",
  "warning",
];

export interface DirectoryFiguresText {
  /** The Workspaces figure's second line, e.g. how many are archived. */
  countNote: string;
  /** The deliveries figure's first line: which deliveries these are. */
  deliveriesLine: string;
  /** The quiet figure's second line: what to do about them. */
  quietAdvice: string;
}

export function DirectoryFigures({
  figures,
  state,
  text,
}: {
  figures: Figures;
  /** "loading" and "error" stand in for figures the summary carries. */
  state: "ready" | "loading" | "error";
  text: DirectoryFiguresText;
}) {
  const m = useConsoleMessages();
  const known = state === "ready";
  const value = (shown: string) =>
    known ? shown : state === "error" ? m.t("workspaces.figures.unavailable") : "…";
  const change = figures.change;
  const share = figures.count ? figures.activeThisWeek / figures.count : 0;

  return (
    <MetricGrid label={m.t("workspaces.figures.label")}>
      <MetricCard
        label={m.t("workspaces.figures.count")}
        icon={FolderClosed}
        value={m.number(figures.count)}
        empty={figures.count === 0}
        visual={
          <SegmentBar
            size="sm"
            track
            scale={known ? share : 0}
            format={(value) => m.plural("workspaces.figures.workspacesCount", value)}
            segments={[
              {
                key: "active",
                value: figures.activeThisWeek,
                color: "positive",
                label: m.t("workspaces.figures.activePart"),
              },
            ]}
          />
        }
        detail={
          figures.count === 0
            ? [m.t("workspaces.figures.none"), text.countNote]
            : [
                known
                  ? m.t("workspaces.figures.active", { count: m.number(figures.activeThisWeek) })
                  : "…",
                text.countNote,
              ]
        }
      />

      <MetricCard
        label={m.t("workspaces.figures.items")}
        icon={Layers}
        value={value(m.number(figures.itemsTotal))}
        empty={known && figures.itemsTotal === 0}
        visual={
          <SegmentBar
            size="sm"
            format={(value, segment) =>
              m.plural(`kinds.count.${segment.key as KnowledgeKind}`, value)
            }
            segments={KINDS.map((kind) => ({
              key: kind,
              value: figures.items[kind],
              color: KIND_COLORS[kind],
              label: m.t(`kinds.plural.${kind}`),
            }))}
          />
        }
        detail={
          known && figures.itemsTotal > 0 ? (
            <span className="lc-figure-legend">
              {KINDS.map((kind) => (
                <span key={kind}>
                  <Swatch color={KIND_COLORS[kind]} />
                  {m.plural(`kinds.count.${kind}`, figures.items[kind])}
                </span>
              ))}
            </span>
          ) : known ? (
            [m.t("workspaces.figures.itemsNone"), m.t("workspaces.figures.itemsNoneLine")]
          ) : undefined
        }
      />

      <MetricCard
        label={m.t("workspaces.figures.deliveries")}
        icon={ArrowUpRight}
        value={value(m.number(figures.delivered))}
        empty={known && figures.delivered === 0}
        delta={
          known && change != null
            ? {
                value: `${change >= 0 ? "+" : ""}${m.number(change / 100, {
                  style: "percent",
                  maximumFractionDigits: 1,
                })}`,
                direction: change > 0 ? "up" : change < 0 ? "down" : "flat",
                tone: change > 0 ? "positive" : change < 0 ? "danger" : "neutral",
              }
            : undefined
        }
        visual={<Sparkline values={known ? figures.deliveries : []} color="neutral" />}
        detail={
          !known
            ? undefined
            : figures.delivered === 0 && figures.previous === 0
              ? [
                  m.t("workspaces.figures.deliveriesNone"),
                  m.t("workspaces.figures.deliveriesNoneLine"),
                ]
              : [
                  text.deliveriesLine,
                  figures.previous > 0
                    ? m.t("workspaces.figures.previous", { count: m.number(figures.previous) })
                    : m.t("workspaces.figures.previousNone"),
                ]
        }
      />

      <MetricCard
        label={m.t("workspaces.figures.quiet")}
        icon={Clock}
        value={value(m.number(figures.quiet))}
        empty={known && figures.quiet === 0}
        status={
          known && figures.quiet > 0
            ? { label: m.t("workspaces.figures.review"), tone: "warning", icon: TriangleAlert }
            : undefined
        }
        visual={
          <Sparkbars
            format={(value) => m.plural("workspaces.figures.workspacesCount", value)}
            bars={figures.ages.map((count, index) => ({
              key: String(index),
              value: known ? count : 0,
              color: AGE_COLORS[index] ?? "neutral",
              label: m.t(`workspaces.figures.ages.${AGE_KEYS[index] ?? "older"}`),
            }))}
          />
        }
        detail={
          !known
            ? undefined
            : figures.quiet > 0
              ? [m.t("workspaces.figures.quietLine"), text.quietAdvice]
              : [m.t("workspaces.figures.quietNone"), m.t("workspaces.figures.quietNoneLine")]
        }
      />
    </MetricGrid>
  );
}
