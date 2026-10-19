// SPDX-License-Identifier: Apache-2.0
// Small charts for dashboards: series swatches, a sparkline, a part-to-whole bar, stacked bars over
// time, a column chart, a legend and a summary strip. Colors are roles, never values: series take
// viz-1..5 in order (memory, rule, skill), states take the status roles.
import {
  useId,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { cx } from "../lib/cx.js";
import { useUiMessages } from "../i18n/ui-messages.js";

/** A color role a chart may paint with. */
export type ChartColor =
  | "viz-1"
  | "viz-2"
  | "viz-3"
  | "viz-4"
  | "viz-5"
  | "positive"
  | "info"
  | "warning"
  | "danger"
  | "neutral"
  /** The quiet rest of a whole, e.g. what a share is a share of. */
  | "track";

const COLOR_VARS: Record<ChartColor, string> = {
  "viz-1": "var(--pr-viz-1)",
  "viz-2": "var(--pr-viz-2)",
  "viz-3": "var(--pr-viz-3)",
  "viz-4": "var(--pr-viz-4)",
  "viz-5": "var(--pr-viz-5)",
  positive: "var(--pr-positive)",
  info: "var(--pr-info)",
  warning: "var(--pr-warn)",
  danger: "var(--pr-danger)",
  neutral: "var(--pr-fg-3)",
  track: "var(--pr-bg-3)",
};

/** The CSS value of a chart color role, for inline fills. */
export function chartColor(color: ChartColor): string {
  return COLOR_VARS[color];
}

/** A small square that names a series next to text. Decorative: the text carries the meaning. */
export function Swatch({ color, className }: { color: ChartColor; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("pr-swatch", className)}
      style={{ background: chartColor(color) }}
    />
  );
}

/* ── Sparkline ───────────────────────────────────────────────────────────── */

export interface SparklineProps {
  values: readonly number[];
  color?: ChartColor;
  /** Give it a label only when no nearby text states the trend. */
  label?: string;
  className?: string;
}

/** A trend line without axes. No data, or a flat zero, draws a dashed baseline. */
export function Sparkline({ values, color = "viz-1", label, className }: SparklineProps) {
  const max = values.length ? Math.max(...values) : 0;
  const min = values.length ? Math.min(...values) : 0;
  const empty = values.length < 2 || max === 0;
  const points = empty
    ? ""
    : values
        .map((value, index) => {
          const x = (index / (values.length - 1)) * 120;
          const y = 30 - ((value - min) / (max - min || 1)) * 26;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
  return (
    <svg
      viewBox="0 0 120 32"
      preserveAspectRatio="none"
      className={cx("pr-sparkline", empty && "pr-sparkline--empty", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {empty ? (
        <line x1="0" y1="28" x2="120" y2="28" vectorEffect="non-scaling-stroke" />
      ) : (
        <polyline
          points={points}
          fill="none"
          style={{ stroke: chartColor(color) }}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

/* ── Hover layer for small bars ──────────────────────────────────────────── */

/**
 * Which part of a small bar the pointer is over, from its horizontal position: a 6px bar is too
 * thin to aim at, so the whole row (with 8px above and below) is the target. `weights` are the
 * parts' widths; equal widths when omitted.
 */
function useHoverPart(weights: readonly number[]) {
  const [active, setActive] = useState<number | null>(null);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const onMouseMove = (event: ReactMouseEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || total <= 0) return;
    const at = ((event.clientX - box.left) / box.width) * total;
    let before = 0;
    for (let index = 0; index < weights.length; index += 1) {
      before += weights[index]!;
      if (at < before || index === weights.length - 1) {
        setActive(index);
        return;
      }
    }
  };
  // The centre of the active part, as a share of the row, to place the tip over it.
  let center = 0;
  if (active != null && total > 0) {
    const before = weights.slice(0, active).reduce((sum, weight) => sum + weight, 0);
    center = (before + weights[active]! / 2) / total;
  }
  return { active, center, onMouseMove, onMouseLeave: () => setActive(null) };
}

/** What one part of a small bar is: its color, its name, its value and, optionally, a note. */
function HoverTip({
  color,
  label,
  value,
  note,
  center,
}: {
  color: ChartColor;
  label: string;
  value: string;
  note?: string;
  center: number;
}) {
  const at = Math.round(Math.max(0, Math.min(1, center)) * 100);
  return (
    <span
      role="status"
      className="pr-hovertip"
      style={{ left: `${at}%`, transform: `translateX(-${at}%)` }}
    >
      <span className="pr-hovertip__row">
        <Swatch color={color} />
        <span className="pr-hovertip__name">{label}</span>
        <span className="pr-hovertip__value pr-tabular">{value}</span>
      </span>
      {note ? <span className="pr-hovertip__note">{note}</span> : null}
    </span>
  );
}

/* ── Segment bar ─────────────────────────────────────────────────────────── */

export interface Segment {
  key: string;
  value: number;
  color: ChartColor;
  /** What the color stands for. A bar whose parts have labels names each one on hover. */
  label?: string;
}

export interface SegmentBarProps {
  segments: readonly Segment[];
  /** Accessible summary; without it the bar is decorative and nearby text must state the parts. */
  label?: string;
  size?: "sm" | "md" | "lg";
  /** The bar's length as a share (0–1) of its row, to compare totals across rows. Default 1. */
  scale?: number;
  /** Draw the rest of the row as a quiet track, so a short bar reads as "a share of all". */
  track?: boolean;
  /** A part's value as the hover tip shows it, e.g. "12 memories". */
  format?: (value: number, segment: Segment) => string;
  className?: string;
}

/**
 * Parts of a whole in one bar, 2px apart. A zero total draws a dashed track. When the parts carry
 * labels, hovering names the part under the pointer with its value and share, and the bar's
 * accessible name lists every part.
 */
export function SegmentBar({
  segments,
  label,
  size = "md",
  scale = 1,
  track = false,
  format = (value) => String(value),
  className,
}: SegmentBarProps) {
  const visible = segments.filter((segment) => segment.value > 0);
  const named = visible.length > 0 && visible.every((segment) => segment.label);
  const total = visible.reduce((sum, segment) => sum + segment.value, 0);
  const share = Math.max(0, Math.min(1, scale));
  // Over a track the parts fill `share` of the row; the rest of the row is a part with no tip.
  const rest = track && share > 0 && share < 1 ? (total * (1 - share)) / share : 0;
  const hover = useHoverPart([...visible.map((segment) => segment.value), ...(rest ? [rest] : [])]);
  const accessible =
    label ??
    (named
      ? visible.map((segment) => `${segment.label} ${format(segment.value, segment)}`).join(", ")
      : undefined);
  const bar = (
    <span
      role={!track && accessible ? "img" : undefined}
      aria-label={!track ? accessible : undefined}
      aria-hidden={track || !accessible ? true : undefined}
      className={cx(
        "pr-segments",
        `pr-segments--${size}`,
        visible.length === 0 && "pr-segments--empty",
        !track && className,
      )}
      style={visible.length ? { width: `${share * 100}%` } : undefined}
    >
      {visible.map((segment, index) => (
        <span
          key={segment.key}
          className={cx(
            "pr-segments__part",
            hover.active != null &&
              hover.active < visible.length &&
              hover.active !== index &&
              "pr-segments__part--dim",
          )}
          style={{ flexGrow: segment.value, background: chartColor(segment.color) }}
        />
      ))}
    </span>
  );
  const shown = track ? (
    <span
      role={accessible ? "img" : undefined}
      aria-label={accessible}
      aria-hidden={accessible ? undefined : true}
      className={cx("pr-segments-track", `pr-segments--${size}`, className)}
    >
      {bar}
    </span>
  ) : (
    bar
  );
  if (!named) return shown;
  const current = hover.active != null ? visible[hover.active] : undefined;
  return (
    <span className="pr-hoverbar" onMouseMove={hover.onMouseMove} onMouseLeave={hover.onMouseLeave}>
      {shown}
      {current ? (
        <HoverTip
          color={current.color}
          label={current.label!}
          value={format(current.value, current)}
          note={total > 0 ? `${Math.round((current.value / total) * 100)}%` : undefined}
          center={hover.center}
        />
      ) : null}
    </span>
  );
}

/* ── Metric visuals ──────────────────────────────────────────────────────── */

/**
 * A few tiny columns, e.g. a histogram squeezed into a metric card. Decorative unless the columns
 * carry labels: then hovering names the column under the pointer and its value.
 */
export function Sparkbars({
  bars,
  format = (value) => String(value),
  className,
}: {
  bars: ReadonlyArray<{
    key: string;
    value: number;
    color: ChartColor;
    label?: string;
    note?: string;
  }>;
  /** A column's value as the hover tip shows it, e.g. "12 entries". */
  format?: (value: number) => string;
  className?: string;
}) {
  const max = bars.length ? Math.max(...bars.map((bar) => bar.value)) : 0;
  const named = bars.length > 0 && bars.every((bar) => bar.label);
  const hover = useHoverPart(bars.map(() => 1));
  const columns = (
    <span aria-hidden className={cx("pr-sparkbars", max === 0 && "pr-sparkbars--empty", className)}>
      {bars.map((bar, index) => (
        <span
          key={bar.key}
          className={cx(
            "pr-sparkbars__bar",
            hover.active != null && hover.active !== index && "pr-sparkbars__bar--dim",
          )}
          style={
            max > 0
              ? { height: `${(bar.value / max) * 100}%`, background: chartColor(bar.color) }
              : undefined
          }
        />
      ))}
    </span>
  );
  if (!named) return columns;
  const current = hover.active != null ? bars[hover.active] : undefined;
  return (
    <span
      className="pr-hoverbar pr-hoverbar--columns"
      onMouseMove={hover.onMouseMove}
      onMouseLeave={hover.onMouseLeave}
    >
      {columns}
      {current ? (
        <HoverTip
          color={current.color}
          label={current.label!}
          value={format(current.value)}
          note={current.note}
          center={hover.center}
        />
      ) : null}
    </span>
  );
}

/**
 * `filled` of `total` as equal units, e.g. 3 of 12 groups active. Past 24 units it scales the
 * filled share onto 24, so the row never turns into a texture. Decorative: pair with text.
 */
export function UnitBar({
  filled,
  total,
  color = "neutral",
  className,
}: {
  filled: number;
  total: number;
  color?: ChartColor;
  className?: string;
}) {
  const units = Math.min(Math.max(total, 0), 24);
  const lit = total > 24 ? Math.round((filled / total) * 24) : Math.min(filled, units);
  return (
    <span aria-hidden className={cx("pr-units", units === 0 && "pr-units--empty", className)}>
      {Array.from({ length: units }, (_, index) => (
        <span
          key={index}
          className="pr-units__unit"
          style={index < lit ? { background: chartColor(color) } : undefined}
        />
      ))}
    </span>
  );
}

/* ── Stacked bars over time ──────────────────────────────────────────────── */

export interface ChartSeries<K extends string = string> {
  key: K;
  label: string;
  color: ChartColor;
}

export interface ChartBucket<K extends string = string> {
  key: string;
  /** Full label for the tooltip and the table view, e.g. "Tue, Oct 13". */
  label: string;
  /** Axis label; leave empty to skip a tick. */
  tick?: string;
  values: Record<K, number>;
}

export interface StackedBarChartProps<K extends string> {
  /** Bottom to top. */
  series: readonly ChartSeries<K>[];
  buckets: readonly ChartBucket<K>[];
  /** What the chart shows, for assistive technology, e.g. "Deliveries by kind, last 30 days". */
  label: string;
  /** Plot height in px. Default 232. */
  height?: number;
  format?: (value: number) => string;
  /** Drawn over the empty plot when every value is zero. */
  empty?: ReactNode;
  className?: string;
}

function niceStep(max: number): number {
  if (max <= 0) return 1;
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const nice =
    fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

/**
 * Stacked columns, one per bucket. Hover or arrow keys show a bucket's values; the other columns
 * dim. Pair it with a table view of the same buckets: hover is not the only way to read it.
 */
export function StackedBarChart<K extends string>({
  series,
  buckets,
  label,
  height = 232,
  format: givenFormat,
  empty,
  className,
}: StackedBarChartProps<K>) {
  const ui = useUiMessages();
  const format = givenFormat ?? ((value: number) => ui.number(value));
  const compact = (value: number) => ui.number(value, { notation: "compact" });
  const [active, setActive] = useState<number | null>(null);
  const tipId = useId();
  const totals = buckets.map((bucket) =>
    series.reduce((sum, item) => sum + (bucket.values[item.key] ?? 0), 0),
  );
  const max = totals.length ? Math.max(...totals) : 0;
  const step = niceStep(max);
  const top = step * 4;
  const isEmpty = max === 0;
  const count = buckets.length;
  const barWidth = count <= 7 ? "64px" : count <= 14 ? "44px" : "100%";
  const current = active != null ? buckets[active] : undefined;
  const center = active != null ? ((active + 0.5) / count) * 100 : 0;

  const onKeyDown = (event: KeyboardEvent) => {
    if (!count) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      setActive((index) =>
        index == null
          ? delta > 0
            ? 0
            : count - 1
          : Math.min(count - 1, Math.max(0, index + delta)),
      );
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : count - 1);
    } else if (event.key === "Escape") {
      setActive(null);
    }
  };

  return (
    <div className={cx("pr-bars", className)}>
      <div className="pr-bars__axis" aria-hidden style={{ height }}>
        {isEmpty
          ? null
          : [0, 1, 2, 3, 4].map((tick) => (
              <span key={tick} className="pr-bars__tick" style={{ bottom: `${tick * 25}%` }}>
                {compact(step * tick)}
              </span>
            ))}
      </div>
      <div
        className="pr-bars__plot"
        style={{ height }}
        role="group"
        aria-label={label}
        aria-describedby={current ? tipId : undefined}
        tabIndex={isEmpty ? undefined : 0}
        onKeyDown={onKeyDown}
        onMouseLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
      >
        {[0, 1, 2, 3, 4].map((tick) => (
          <span
            key={tick}
            aria-hidden
            className={cx("pr-bars__grid", tick === 0 && "pr-bars__grid--base")}
            style={{ bottom: `${tick * 25}%` }}
          />
        ))}
        {isEmpty ? (
          <div className="pr-bars__empty">{empty}</div>
        ) : (
          <div className="pr-bars__columns" aria-hidden>
            {buckets.map((bucket, index) => (
              <div
                key={bucket.key}
                className={cx(
                  "pr-bars__column",
                  active != null && active !== index && "pr-bars__column--dim",
                )}
                onMouseEnter={() => setActive(index)}
              >
                <div className="pr-bars__stack" style={{ maxWidth: barWidth }}>
                  {[...series].reverse().map((item) => {
                    const value = bucket.values[item.key] ?? 0;
                    if (value <= 0) return null;
                    return (
                      <span
                        key={item.key}
                        className="pr-bars__part"
                        style={{
                          height: `${(value / top) * 100}%`,
                          background: chartColor(item.color),
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        {current && active != null ? (
          <div
            id={tipId}
            role="status"
            className="pr-bars__tooltip"
            style={{
              left: `${center}%`,
              transform: center > 62 ? "translateX(calc(-100% - 14px))" : "translateX(14px)",
            }}
          >
            <span className="pr-bars__tooltip-label">{current.label}</span>
            {series.map((item) => (
              <span key={item.key} className="pr-bars__tooltip-row">
                <Swatch color={item.color} />
                <span className="pr-bars__tooltip-name">{item.label}</span>
                <span className="pr-bars__tooltip-value pr-tabular">
                  {format(current.values[item.key] ?? 0)}
                </span>
              </span>
            ))}
            <span className="pr-bars__tooltip-row pr-bars__tooltip-row--total">
              <span className="pr-bars__tooltip-name">{ui.t("chart.total")}</span>
              <span className="pr-bars__tooltip-value pr-tabular">
                {format(totals[active] ?? 0)}
              </span>
            </span>
          </div>
        ) : null}
      </div>
      <span aria-hidden />
      <div className="pr-bars__ticks" aria-hidden>
        {buckets.map((bucket) => (
          <span key={bucket.key} className="pr-bars__x">
            {isEmpty ? "" : (bucket.tick ?? "")}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Column chart ────────────────────────────────────────────────────────── */

export interface ColumnDatum {
  key: string;
  label: string;
  value: number;
  color?: ChartColor;
}

export interface ColumnChartProps {
  data: readonly ColumnDatum[];
  /** What the columns count, e.g. "Items by last edit". The values are read out with it. */
  label: string;
  format?: (value: number) => string;
  className?: string;
}

/** A few labelled columns with their values on top, e.g. a histogram. Zero data draws dashed stubs. */
export function ColumnChart({ data, label, format: givenFormat, className }: ColumnChartProps) {
  const ui = useUiMessages();
  const format = givenFormat ?? ((value: number) => ui.number(value));
  const max = data.length ? Math.max(...data.map((datum) => datum.value)) : 0;
  const summary = `${label}: ${data.map((datum) => `${datum.label} ${format(datum.value)}`).join(", ")}`;
  return (
    <div className={cx("pr-columns", max === 0 && "pr-columns--empty", className)}>
      <div className="pr-columns__plot" role="img" aria-label={summary}>
        {data.map((datum) => (
          <div key={datum.key} className="pr-columns__column">
            <span className="pr-columns__spacer" style={{ flexGrow: max - datum.value }} />
            {max > 0 ? (
              <span className="pr-columns__value pr-tabular">{format(datum.value)}</span>
            ) : null}
            <span
              className="pr-columns__bar"
              style={{
                flexGrow: datum.value,
                background: max > 0 ? chartColor(datum.color ?? "neutral") : undefined,
              }}
            />
          </div>
        ))}
      </div>
      <div className="pr-columns__labels" aria-hidden>
        {data.map((datum) => (
          <span key={datum.key}>{datum.label}</span>
        ))}
      </div>
    </div>
  );
}

/* ── Legend and summary strip ────────────────────────────────────────────── */

export interface LegendItem {
  key: string;
  label: string;
  color: ChartColor;
  /** The series' total or current value. */
  value?: ReactNode;
  /** Mono detail after the value, e.g. a share. */
  detail?: ReactNode;
}

/** Names every series of a chart, with its value. Always shown when a chart has two or more. */
export function ChartLegend({
  items,
  className,
}: {
  items: readonly LegendItem[];
  className?: string;
}) {
  return (
    <ul className={cx("pr-legend", className)}>
      {items.map((item) => (
        <li key={item.key} className="pr-legend__item">
          <Swatch color={item.color} />
          <span className="pr-legend__label">{item.label}</span>
          {item.value != null ? (
            <span className="pr-legend__value pr-tabular">{item.value}</span>
          ) : null}
          {item.detail != null ? <span className="pr-legend__detail">{item.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export interface StatStripItem {
  key: string;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}

/** A row of small figures under a chart: averages, peaks, shares. */
export function StatStrip({
  items,
  label,
  className,
}: {
  items: readonly StatStripItem[];
  label: string;
  className?: string;
}) {
  return (
    <dl className={cx("pr-statstrip", className)} aria-label={label}>
      {items.map((item) => (
        <div key={item.key} className="pr-statstrip__item">
          <dt className="pr-statstrip__label">{item.label}</dt>
          <dd className="pr-statstrip__value pr-tabular">{item.value}</dd>
          {item.detail != null ? <dd className="pr-statstrip__detail">{item.detail}</dd> : null}
        </div>
      ))}
    </dl>
  );
}
