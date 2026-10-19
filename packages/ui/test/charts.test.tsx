// SPDX-License-Identifier: Apache-2.0
// Dashboard pieces: charts, aligned lists, ghost rows, the extended metric card and the nav meta.
import axe from "axe-core";
import { Layers } from "lucide-react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChartLegend,
  ColumnChart,
  SegmentBar,
  Sparkline,
  StackedBarChart,
  StatStrip,
  type ChartBucket,
} from "../src/components/charts.js";
import { FavoriteButton, GroupHeading } from "../src/components/collection.js";
import { DataList, EmptyPanel, GhostCards, GhostRows } from "../src/components/lists.js";
import { DataTable } from "../src/components/table.js";
import { Card, CardHeader, MetricCard, StateMessage } from "../src/components/surface.js";
import { NavItem } from "../src/layouts/app-shell.js";
import { byRole, cleanup, click, key, render } from "./render.js";

afterEach(cleanup);

type Kind = "memory" | "rule" | "skill";
const SERIES = [
  { key: "memory" as const, label: "Memories", color: "viz-1" as const },
  { key: "rule" as const, label: "Rules", color: "viz-2" as const },
  { key: "skill" as const, label: "Skills", color: "viz-3" as const },
];
const BUCKETS: ChartBucket<Kind>[] = [
  {
    key: "d1",
    label: "Mon, Oct 12",
    tick: "Oct 12",
    values: { memory: 400, rule: 150, skill: 30 },
  },
  { key: "d2", label: "Tue, Oct 13", tick: "Oct 13", values: { memory: 420, rule: 0, skill: 25 } },
];

function hover(element: Element | null) {
  if (!element) throw new Error("hover: element not found");
  act(() => {
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
  });
}

describe("StackedBarChart", () => {
  it("stacks one column per bucket, skips zero parts and labels the plot", () => {
    const { container } = render(
      <StackedBarChart series={SERIES} buckets={BUCKETS} label="Deliveries by kind" />,
    );
    const plot = byRole(container, "group", "Deliveries by kind")[0]!;
    expect(plot).toBeTruthy();
    const columns = container.querySelectorAll(".pr-bars__column");
    expect(columns).toHaveLength(2);
    expect(columns[0]!.querySelectorAll(".pr-bars__part")).toHaveLength(3);
    expect(columns[1]!.querySelectorAll(".pr-bars__part")).toHaveLength(2);
    expect(container.querySelector(".pr-bars__x")?.textContent).toBe("Oct 12");
  });

  it("shows a bucket's values and total on hover and dims the others", () => {
    const { container } = render(
      <StackedBarChart series={SERIES} buckets={BUCKETS} label="Deliveries by kind" />,
    );
    hover(container.querySelectorAll(".pr-bars__column")[0]!);
    const tooltip = container.querySelector(".pr-bars__tooltip")!;
    expect(tooltip.textContent).toContain("Mon, Oct 12");
    expect(tooltip.textContent).toContain("Memories");
    expect(tooltip.textContent).toContain("Total");
    expect(tooltip.textContent).toContain("580");
    expect(container.querySelectorAll(".pr-bars__column--dim")).toHaveLength(1);
  });

  it("moves between buckets with the arrow keys and closes on Escape", () => {
    const { container } = render(
      <StackedBarChart series={SERIES} buckets={BUCKETS} label="Deliveries by kind" />,
    );
    const plot = byRole(container, "group", "Deliveries by kind")[0]!;
    expect(plot.tabIndex).toBe(0);
    key(plot, "ArrowRight");
    expect(container.querySelector(".pr-bars__tooltip")?.textContent).toContain("Mon, Oct 12");
    key(plot, "ArrowRight");
    expect(container.querySelector(".pr-bars__tooltip")?.textContent).toContain("Tue, Oct 13");
    expect(plot.getAttribute("aria-describedby")).toBeTruthy();
    key(plot, "Escape");
    expect(container.querySelector(".pr-bars__tooltip")).toBeNull();
  });

  it("draws the empty slot, no columns and no ticks when every value is zero", () => {
    const zero: ChartBucket<Kind>[] = [
      { key: "d1", label: "Mon", tick: "Oct 12", values: { memory: 0, rule: 0, skill: 0 } },
    ];
    const { container } = render(
      <StackedBarChart
        series={SERIES}
        buckets={zero}
        label="Deliveries"
        empty={<StateMessage compact title="No deliveries yet" />}
      />,
    );
    expect(container.querySelector(".pr-bars__column")).toBeNull();
    expect(container.querySelector(".pr-bars__tick")).toBeNull();
    expect(container.textContent).toContain("No deliveries yet");
    expect(byRole(container, "group", "Deliveries")[0]!.hasAttribute("tabindex")).toBe(false);
  });
});

describe("small charts", () => {
  it("names the part under the pointer with its value and share, when the parts carry labels", () => {
    const { container } = render(
      <SegmentBar
        format={(value) => `${value} items`}
        segments={[
          { key: "memory", value: 3, color: "viz-1", label: "Memories" },
          { key: "rule", value: 1, color: "viz-2", label: "Rules" },
        ]}
      />,
    );
    // The bar names every part for assistive technology.
    expect(byRole(container, "img")[0]!.getAttribute("aria-label")).toBe(
      "Memories 3 items, Rules 1 items",
    );
    const row = container.querySelector(".pr-hoverbar") as HTMLElement;
    row.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 22, right: 100, bottom: 22, x: 0, y: 0 }) as DOMRect;
    act(() => {
      row.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 90 }));
    });
    const tip = container.querySelector(".pr-hovertip");
    expect(tip?.textContent).toBe("Rules1 items25%");
    expect(container.querySelectorAll(".pr-segments__part--dim")).toHaveLength(1);
    act(() => {
      row.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
      );
    });
    expect(container.querySelector(".pr-hovertip")).toBeNull();
  });

  it("keeps an unlabelled bar silent, as before", () => {
    const { container } = render(
      <SegmentBar segments={[{ key: "a", value: 1, color: "neutral" }]} />,
    );
    expect(container.querySelector(".pr-hoverbar")).toBeNull();
  });

  it("SegmentBar sizes parts by value, drops zeros and dashes an empty total", () => {
    const { container, rerender } = render(
      <SegmentBar
        label="1,284 memories, 212 rules, 0 skills"
        segments={[
          { key: "m", value: 1284, color: "viz-1" },
          { key: "r", value: 212, color: "viz-2" },
          { key: "s", value: 0, color: "viz-3" },
        ]}
      />,
    );
    const parts = container.querySelectorAll<HTMLElement>(".pr-segments__part");
    expect(parts).toHaveLength(2);
    expect(parts[0]!.style.flexGrow).toBe("1284");
    expect(byRole(container, "img", "1,284 memories, 212 rules, 0 skills")).toHaveLength(1);
    rerender(<SegmentBar segments={[{ key: "m", value: 0, color: "viz-1" }]} />);
    expect(container.querySelector(".pr-segments--empty")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("Sparkline draws a line through the values, or a dashed baseline without data", () => {
    const { container, rerender } = render(<Sparkline values={[1, 4, 2, 6]} />);
    expect(container.querySelector("polyline")?.getAttribute("points")?.split(" ")).toHaveLength(4);
    rerender(<Sparkline values={[0, 0, 0]} />);
    expect(container.querySelector(".pr-sparkline--empty line")).toBeTruthy();
  });

  it("ColumnChart reads its values out and dashes empty columns", () => {
    const { container, rerender } = render(
      <ColumnChart
        label="Items by last edit"
        data={[
          { key: "a", label: "< 1 wk", value: 212, color: "positive" },
          { key: "b", label: "6 mo +", value: 38, color: "warning" },
        ]}
      />,
    );
    expect(byRole(container, "img")[0]!.getAttribute("aria-label")).toBe(
      "Items by last edit: < 1 wk 212, 6 mo + 38",
    );
    rerender(<ColumnChart label="Items" data={[{ key: "a", label: "< 1 wk", value: 0 }]} />);
    expect(container.querySelector(".pr-columns--empty")).toBeTruthy();
    expect(container.querySelector(".pr-columns__value")).toBeNull();
  });

  it("ChartLegend and StatStrip state every value as text", () => {
    const { container } = render(
      <>
        <ChartLegend
          items={[{ key: "m", label: "Memories", color: "viz-1", value: "11,840", detail: "71%" }]}
        />
        <StatStrip label="Summary" items={[{ key: "avg", label: "Daily average", value: "554" }]} />
      </>,
    );
    expect(container.querySelector(".pr-legend")?.textContent).toBe("Memories11,84071%");
    expect(container.querySelector("dt")?.textContent).toBe("Daily average");
    expect(container.querySelector("dd")?.textContent).toBe("554");
  });
});

describe("DataList", () => {
  it("lines rows up, adds the bar column only when a row has a fraction, and navigates in place", () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <DataList
        label="Top knowledge"
        ordered
        header={{ title: "Item", value: "Deliveries" }}
        onNavigate={onNavigate}
        rows={[
          {
            key: "a",
            title: "Hotspot files must not grow",
            fraction: 1,
            value: "1,208",
            href: "/k/a",
          },
          { key: "b", title: "Worktree location", fraction: 0.5, value: "604", href: "/k/b" },
        ]}
      />,
    );
    expect(container.querySelector("ol")?.getAttribute("aria-label")).toBe("Top knowledge");
    expect(container.querySelector(".pr-datalist--bars.pr-datalist--links")).toBeTruthy();
    expect(container.querySelectorAll<HTMLElement>(".pr-datalist__fill")[1]!.style.width).toBe(
      "50%",
    );
    click(byRole(container, "link", /Worktree location/)[0]!);
    expect(onNavigate).toHaveBeenCalledWith("/k/b");
  });

  it("rows without fractions or links render plain rows", () => {
    const { container } = render(
      <DataList
        label="Changes"
        rows={[{ key: "a", title: "Updated a memory", value: "12m ago" }]}
      />,
    );
    expect(container.querySelector(".pr-datalist--bars")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("ul")).toBeTruthy();
  });

  it("GhostRows are decorative and fade row by row", () => {
    const { container } = render(<GhostRows rows={3} />);
    const ghost = container.querySelector(".pr-ghost")!;
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
    const rows = ghost.querySelectorAll<HTMLElement>(".pr-ghost__row");
    expect(rows).toHaveLength(3);
    expect(Number(rows[2]!.style.opacity)).toBeLessThan(Number(rows[0]!.style.opacity));
  });
});

describe("EmptyPanel", () => {
  it("centers one message over the data's faded shape, which stays out of the accessibility tree", () => {
    const { container } = render(
      <EmptyPanel icon={Layers} title="No knowledge yet" ghost={{ columns: ["56%", "32px"] }} />,
    );
    const panel = container.querySelector(".pr-empty-panel")!;
    expect(panel.querySelector(".pr-empty-panel__ghost")?.getAttribute("aria-hidden")).toBe("true");
    expect(panel.querySelectorAll(".pr-ghost__row")).toHaveLength(5);
    expect(panel.querySelector<HTMLElement>(".pr-ghost__row")!.style.opacity).toBe("");
    expect(byRole(container, "status")[0]!.textContent).toBe("No knowledge yet");
  });

  it("without a ghost it is just the centered message, e.g. a capability this backend lacks", () => {
    const { container } = render(<EmptyPanel title="Not recorded here" description="No ledgers" />);
    expect(container.querySelector(".pr-ghost")).toBeNull();
    expect(container.querySelector(".pr-empty-panel__message")?.textContent).toContain(
      "No ledgers",
    );
  });
});

describe("MetricCard and nav meta", () => {
  it("a delta carries an arrow, a signed value and a word, and the card can be a link", () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <MetricCard
        label="Deliveries to agents"
        value="16,619"
        delta={{ value: "+8.4%", direction: "up", tone: "positive", label: "vs previous 30 days" }}
        href="/deliveries"
        onNavigate={onNavigate}
      />,
    );
    const delta = container.querySelector(".pr-metric__delta--positive")!;
    expect(delta.querySelector("svg")).toBeTruthy();
    expect(delta.textContent).toBe("+8.4%vs previous 30 days");
    click(container.querySelector("a.pr-metric--link"));
    expect(onNavigate).toHaveBeenCalledWith("/deliveries");
  });

  it("an empty metric reads muted", () => {
    const { container } = render(<MetricCard label="Signals" value="0" empty />);
    expect(container.querySelector(".pr-metric--empty")).toBeTruthy();
  });

  it("shows a quiet count, which an actionable badge replaces", () => {
    const { container, rerender } = render(
      <NavItem label="Memories" icon={Layers} href="/m" meta="1,284" />,
    );
    expect(container.querySelector(".pr-nav-item__meta")?.textContent).toBe("1,284");
    rerender(
      <NavItem label="Memories" icon={Layers} href="/m" meta="1,284" badge={{ count: 3 }} />,
    );
    expect(container.querySelector(".pr-nav-item__meta")).toBeNull();
    expect(container.querySelector(".pr-nav-item__badge")?.textContent).toBe("3");
  });

  it("a described card header stacks title and description", () => {
    const { container } = render(
      <Card>
        <CardHeader id="t" title="Knowledge health" description="Active items by state" />
      </Card>,
    );
    expect(container.querySelector(".pr-card__header--described h2#t")?.textContent).toBe(
      "Knowledge health",
    );
    expect(container.querySelector(".pr-card__description")?.textContent).toBe(
      "Active items by state",
    );
  });
});

describe("dashboard accessibility", () => {
  it("a dashboard of charts, lists and empty states has no axe violations", async () => {
    const { container } = render(
      <main>
        <h1>Overview</h1>
        <MetricCard
          label="Deliveries"
          value="16,619"
          delta={{
            value: "+8.4%",
            direction: "up",
            tone: "positive",
            label: "vs previous 30 days",
          }}
          visual={<Sparkline values={[1, 3, 2, 5]} />}
          href="/d"
        />
        <Card aria-labelledby="deliveries">
          <CardHeader id="deliveries" title="Deliveries to agents" description="By kind" />
          <ChartLegend
            items={SERIES.map((s) => ({ key: s.key, label: s.label, color: s.color, value: "1" }))}
          />
          <StackedBarChart series={SERIES} buckets={BUCKETS} label="Deliveries by kind" />
          <StatStrip label="Summary" items={[{ key: "a", label: "Daily average", value: "554" }]} />
        </Card>
        <Card aria-labelledby="top">
          <CardHeader id="top" title="Top knowledge" description="30 days" />
          <DataList
            label="Top knowledge"
            ordered
            header={{ title: "Item", value: "Deliveries" }}
            rows={[{ key: "a", title: "Hotspot files", fraction: 1, value: "1,208", href: "/a" }]}
          />
        </Card>
        <Card aria-labelledby="empty">
          <CardHeader id="empty" title="Recent changes" description="This workspace" />
          <GhostRows />
          <StateMessage compact icon={Layers} title="No changes yet" />
        </Card>
        <ColumnChart label="Items by last edit" data={[{ key: "a", label: "< 1 wk", value: 3 }]} />
      </main>,
    );
    const result = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
      resultTypes: ["violations"],
    });
    expect(result.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe("collection pieces", () => {
  it("a favorite star is a toggle with a constant name that never opens the card under it", () => {
    const onToggle = vi.fn();
    const onCard = vi.fn();
    const { container } = render(
      <div onClick={onCard}>
        <FavoriteButton name="pathrule" favorite={false} onToggle={onToggle} />
      </div>,
    );
    const star = byRole(container, "button", "Favorite pathrule")[0]!;
    expect(star.getAttribute("aria-pressed")).toBe("false");
    click(star);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onCard).not.toHaveBeenCalled();
  });

  it("a busy star ignores presses until the change is saved", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <FavoriteButton name="pathrule" favorite busy onToggle={onToggle} />,
    );
    const star = byRole(container, "button", "Favorite pathrule")[0]!;
    expect(star.getAttribute("aria-pressed")).toBe("true");
    click(star);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("a group heading names the group, its count and its order", () => {
    const { container } = render(
      <GroupHeading title="Favorites" count={3} note="latest activity first" />,
    );
    expect(container.querySelector("h2")?.textContent).toBe("Favorites3");
    expect(container.textContent).toContain("latest activity first");
  });

  it("an empty grid draws the cards it will hold behind its message", () => {
    const { container } = render(
      <EmptyPanel title="No workspaces yet" backdrop={<GhostCards count={4} />} />,
    );
    expect(container.querySelectorAll(".pr-ghost-card")).toHaveLength(4);
    expect(container.querySelector(".pr-empty-panel__ghost")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("a table splits its rows into groups with a heading row each", () => {
    const rows = [
      { id: "a", fav: true },
      { id: "b", fav: true },
      { id: "c", fav: false },
    ];
    const { container } = render(
      <DataTable
        caption="Workspaces"
        columns={[{ key: "id", header: "Id", render: (row) => row.id }]}
        rows={rows}
        rowKey={(row) => row.id}
        rowGroup={(row) => ({
          key: row.fav ? "f" : "o",
          heading: row.fav ? "Favorites" : "Others",
        })}
      />,
    );
    expect([...container.querySelectorAll("tbody tr")].map((tr) => tr.textContent)).toEqual([
      "Favorites",
      "a",
      "b",
      "Others",
      "c",
    ]);
  });
});
