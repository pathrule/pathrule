// SPDX-License-Identifier: Apache-2.0
// Dashboard pages: metric tiles, stacked bars with a table view, small charts, aligned lists and
// the ghost rows of an empty card.
import { ArrowUpRight, BarChart3, FolderPlus, Layers } from "lucide-react";
import { useState } from "react";
import {
  Card,
  CardHeader,
  ChartLegend,
  ColumnChart,
  DataList,
  DataTable,
  CommandChip,
  EmptyPanel,
  FavoriteButton,
  GhostCards,
  GroupHeading,
  MetricCard,
  Monogram,
  SegmentBar,
  SegmentedControl,
  Sparkline,
  StackedBarChart,
  StatStrip,
  Swatch,
  type ChartBucket,
} from "../src/index.js";
import type { Entry } from "./registry-entry.js";

type Kind = "memory" | "rule" | "skill";

const SERIES = [
  { key: "memory" as const, label: "Memories", color: "viz-1" as const },
  { key: "rule" as const, label: "Rules", color: "viz-2" as const },
  { key: "skill" as const, label: "Skills", color: "viz-3" as const },
];

function sampleBuckets(days: number): ChartBucket<Kind>[] {
  const end = Date.UTC(2026, 9, 13);
  return Array.from({ length: days }, (_, index) => {
    const ago = days - 1 - index;
    const at = new Date(end - ago * 86_400_000);
    const weekend = at.getUTCDay() === 0 || at.getUTCDay() === 6 ? 0.5 : 1;
    const wave = 1 + Math.sin(index * 1.7) * 0.15;
    const short = at.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    return {
      key: at.toISOString().slice(0, 10),
      label: at.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
      tick: ago % 7 === 0 ? short : "",
      values: {
        memory: Math.round(440 * weekend * wave),
        rule: Math.round(160 * weekend * wave),
        skill: Math.round(32 * weekend * wave),
      },
    };
  });
}

function DeliveriesDemo() {
  const [view, setView] = useState<"chart" | "table">("chart");
  const buckets = sampleBuckets(30);
  const total = (kind: Kind) => buckets.reduce((sum, bucket) => sum + bucket.values[kind], 0);
  const all = total("memory") + total("rule") + total("skill");
  return (
    <Card aria-labelledby="pg-deliveries" style={{ width: "100%" }}>
      <CardHeader
        id="pg-deliveries"
        title="Deliveries to agents"
        description="Knowledge sent into agent sessions, by kind · last 30 days"
        actions={
          <SegmentedControl
            label="Show as"
            size="sm"
            value={view}
            onValueChange={setView}
            options={[
              { value: "chart", label: "Chart" },
              { value: "table", label: "Table" },
            ]}
          />
        }
      />
      <div className="pr-card__body pr-stack pr-stack--4">
        <ChartLegend
          items={SERIES.map((series) => ({
            key: series.key,
            label: series.label,
            color: series.color,
            value: total(series.key).toLocaleString("en-US"),
            detail: `${Math.round((total(series.key) / all) * 100)}%`,
          }))}
        />
        {view === "chart" ? (
          <StackedBarChart
            series={SERIES}
            buckets={buckets}
            label="Deliveries by kind, last 30 days"
          />
        ) : (
          <DataTable
            caption="Deliveries by kind, last 30 days"
            captionHidden
            rowKey={(bucket) => bucket.key}
            rows={[...buckets].reverse()}
            columns={[
              { key: "day", header: "Date", render: (bucket) => bucket.label },
              ...SERIES.map((series) => ({
                key: series.key,
                header: series.label,
                align: "end" as const,
                render: (bucket: ChartBucket<Kind>) =>
                  bucket.values[series.key].toLocaleString("en-US"),
              })),
            ]}
          />
        )}
      </div>
      <StatStrip
        label="Summary of the period"
        items={[
          {
            key: "avg",
            label: "Daily average",
            value: Math.round(all / 30).toLocaleString("en-US"),
            detail: "deliveries per day",
          },
          { key: "peak", label: "Busiest day", value: "668", detail: "Wed, Oct 7" },
          { key: "low", label: "Quietest day", value: "298", detail: "Sun, Sep 20" },
          { key: "weekend", label: "Weekends", value: "17%", detail: "of deliveries" },
        ]}
      />
    </Card>
  );
}

export const CHART_ENTRIES: Entry[] = [
  {
    id: "metric-tiles",
    category: "data",
    name: "Metric tiles",
    kind: "shared",
    imports: "MetricCard, Sparkline, SegmentBar, Swatch",
    description:
      "A figure, what it is compared against and, when it helps, a small visual. A delta always has an arrow, a signed value and a word; the whole tile can link to its source.",
    props: [
      { name: "icon", type: "IconComponent" },
      { name: "delta", type: "{ value, direction, tone?, label? }" },
      { name: "visual", type: "ReactNode", description: "Sparkline, SegmentBar or a meter." },
      { name: "empty", type: "boolean", description: "No data yet: the value reads muted." },
      { name: "href / onNavigate", type: "string / (href) => void" },
    ],
    dos: [
      "Pair a positive delta with its arrow and comparison word.",
      "Link a tile to the page that explains it.",
    ],
    donts: ["Color a value green or red with nothing else saying why."],
    render: () => (
      <div className="pr-grid pr-grid--metrics" style={{ width: "100%" }}>
        <MetricCard
          label="Knowledge items"
          icon={Layers}
          value="1,544"
          href="#metric-tiles"
          visual={
            <SegmentBar
              size="sm"
              label="1,284 memories, 212 rules, 48 skills"
              segments={[
                { key: "m", value: 1284, color: "viz-1" },
                { key: "r", value: 212, color: "viz-2" },
                { key: "s", value: 48, color: "viz-3" },
              ]}
            />
          }
          detail={
            <span className="pr-row">
              <Swatch color="viz-1" /> 1,284 memories <Swatch color="viz-2" /> 212 rules
            </span>
          }
        />
        <MetricCard
          label="Deliveries to agents"
          icon={ArrowUpRight}
          value="16,619"
          delta={{ value: "+8.4%", direction: "up", tone: "positive" }}
          visual={<Sparkline values={[420, 380, 510, 460, 530, 590, 560, 610]} />}
          detail="vs previous 30 days"
        />
        <MetricCard label="Signals" value="0" empty detail="No events yet" />
      </div>
    ),
  },
  {
    id: "stacked-bars",
    category: "data",
    name: "Stacked bars",
    kind: "shared",
    imports: "StackedBarChart, ChartLegend, StatStrip",
    description:
      "Counts over time split by series. Hover or arrow keys read a bucket; a Chart/Table switch gives the same numbers without hover. Series take viz-1..3 in order and the legend always names them.",
    props: [
      { name: "series", type: "{ key, label, color }[]", description: "Bottom to top." },
      { name: "buckets", type: "{ key, label, tick?, values }[]" },
      { name: "label", type: "string", description: "What the chart shows." },
      {
        name: "empty",
        type: "ReactNode",
        description: "Shown over the plot when everything is zero.",
      },
    ],
    a11y: "The plot is a focusable group: ← → move between buckets, Home/End jump, Escape closes. Offer the table view too.",
    render: () => <DeliveriesDemo />,
  },
  {
    id: "small-charts",
    category: "data",
    name: "Segment bar, sparkline, columns",
    kind: "shared",
    imports: "SegmentBar, Sparkline, ColumnChart",
    description:
      "Part-to-whole in one bar (scale it to compare rows), a trend without axes, and a few labelled columns. No data draws dashed shapes, never an empty gap.",
    render: () => (
      <div className="pr-stack pr-stack--4" style={{ width: "100%", maxWidth: 520 }}>
        <SegmentBar
          size="lg"
          label="1,390 current, 112 not delivered, 38 stale, 4 without a path"
          segments={[
            { key: "current", value: 1390, color: "positive" },
            { key: "unused", value: 112, color: "info" },
            { key: "stale", value: 38, color: "warning" },
            { key: "unplaced", value: 4, color: "danger" },
          ]}
        />
        <SegmentBar
          size="md"
          scale={0.45}
          segments={[
            { key: "m", value: 96, color: "viz-1" },
            { key: "r", value: 11, color: "viz-2" },
          ]}
        />
        <SegmentBar size="md" segments={[]} />
        <Sparkline values={[3, 5, 4, 8, 6, 9]} color="viz-1" />
        <Sparkline values={[]} />
        <ColumnChart
          label="Items by last edit"
          data={[
            { key: "1w", label: "< 1 wk", value: 212, color: "positive" },
            { key: "4w", label: "1–4 wk", value: 418, color: "positive" },
            { key: "3m", label: "1–3 mo", value: 764, color: "positive" },
            { key: "6m", label: "3–6 mo", value: 112, color: "warning" },
            { key: "old", label: "6 mo +", value: 38, color: "warning" },
          ]}
        />
      </div>
    ),
  },
  {
    id: "data-list",
    category: "data",
    name: "Data list",
    kind: "shared",
    imports: "DataList",
    description:
      "Rows whose bars and figures line up in fixed columns: a ranked list, a breakdown, recent changes. A row with an href is a link with a chevron.",
    render: () => (
      <Card style={{ width: "100%", maxWidth: 560 }} aria-labelledby="pg-top">
        <CardHeader id="pg-top" title="Top knowledge" description="By agent deliveries · 30 days" />
        <DataList
          label="Top knowledge"
          ordered
          header={{ title: "Item", value: "Deliveries" }}
          rows={[
            {
              key: "a",
              leading: <Swatch color="viz-1" />,
              title: "Console runs on @pathrule/ui tokens",
              meta: "Memory · /packages/ui",
              fraction: 1,
              value: "1,412",
              detail: "8.5%",
              href: "#data-list",
            },
            {
              key: "b",
              leading: <Swatch color="viz-2" />,
              title: "Hotspot files must not grow",
              meta: "Rule · /",
              fraction: 0.86,
              value: "1,208",
              detail: "7.3%",
              href: "#data-list",
            },
            {
              key: "c",
              leading: <Swatch color="viz-3" />,
              title: "ship-pathrule-change",
              meta: "Skill · /",
              fraction: 0.44,
              value: "615",
              detail: "3.7%",
              href: "#data-list",
            },
          ]}
        />
      </Card>
    ),
  },
  {
    id: "empty-card",
    category: "data",
    name: "Empty card",
    kind: "pattern",
    imports: "EmptyPanel",
    description:
      "A card with no data yet: one icon and a short title in the middle of the content area, both ways, over the faded dashed shape of what will appear. No paragraphs.",
    dos: ["Keep the card's header and column captions.", "One title, at most one short line."],
    donts: ["Use skeletons for empty data: they read as loading."],
    render: () => (
      <Card
        style={{ width: "100%", maxWidth: 560, display: "flex", flexDirection: "column" }}
        aria-labelledby="pg-empty"
      >
        <CardHeader
          id="pg-empty"
          title="Deliveries to agents"
          description="By kind · last 30 days"
        />
        <EmptyPanel
          icon={BarChart3}
          title="No deliveries yet"
          ghost={{ columns: ["56%", "120px", "40px"] }}
        />
      </Card>
    ),
  },
  {
    id: "collection",
    category: "data",
    name: "Collection pieces",
    kind: "pattern",
    imports: "FavoriteButton, GroupHeading, Monogram, GhostCards",
    description:
      "For pages that list many things as cards or rows: a star that keeps something on top, a small heading per group with its count and order, a monogram tile, and the dashed grid an empty page shows behind its message.",
    dos: [
      "Keep favorites with the backend that serves the page, never in the browser.",
      "Put the star and the menu above a card's stretched link.",
    ],
    donts: ["Label the star with its state: aria-pressed says it."],
    a11y: "FavoriteButton is a toggle button with a constant name, “Favorite <name>”.",
    render: () => <CollectionDemo />,
  },
];

function CollectionDemo() {
  const [favorite, setFavorite] = useState(true);
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 16, width: "100%", maxWidth: 640 }}
    >
      <GroupHeading title="Favorites" count={3} note="latest activity first" />
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Monogram name="pathrule" />
        <span className="pr-mono" style={{ flex: 1 }}>
          pathrule
        </span>
        <FavoriteButton
          name="pathrule"
          favorite={favorite}
          onToggle={() => setFavorite(!favorite)}
        />
      </div>
      <Card style={{ display: "flex", flexDirection: "column" }} aria-label="No workspaces yet">
        <EmptyPanel
          icon={FolderPlus}
          title="No workspaces yet"
          actions={<CommandChip command="pathrule init" />}
          backdrop={<GhostCards count={6} />}
        />
      </Card>
    </div>
  );
}
