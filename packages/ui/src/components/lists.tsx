// SPDX-License-Identifier: Apache-2.0
// Aligned rows for dashboards (a ranked list, a breakdown, recent changes) and the dashed ghost rows
// an empty card shows in their place.
import { ChevronRight } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { Icon, type IconComponent } from "../lib/icon.js";
import { chartColor, type ChartColor } from "./charts.js";
import { StateMessage } from "./surface.js";

export interface DataListRow {
  key: string;
  /** Before the title: a swatch, a status chip, a small badge. */
  leading?: ReactNode;
  title: ReactNode;
  /** Under the title: kind, path, description. Kept to one line. */
  meta?: ReactNode;
  /** The bar's length as a share (0–1) of the longest; omit for rows without a bar. */
  fraction?: number;
  barColor?: ChartColor;
  /** Right-aligned figure or time. */
  value?: ReactNode;
  /** Mono detail under the value, e.g. a share. */
  detail?: ReactNode;
  /** The row opens this address. */
  href?: string;
}

export interface DataListProps {
  rows: readonly DataListRow[];
  /** Accessible name of the list. */
  label: string;
  /** Column captions above the rows. */
  header?: { title: string; value?: string };
  /** Rank order matters: renders an ordered list. */
  ordered?: boolean;
  /** SPA navigation for row links; modified clicks still follow the href. */
  onNavigate?: (href: string) => void;
  className?: string;
}

function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * Rows whose bars and figures line up in columns, so values compare at a glance. A row with an
 * `href` is a link with a chevron; the bar column appears when any row has a `fraction`.
 */
export function DataList({ rows, label, header, ordered, onNavigate, className }: DataListProps) {
  const bars = rows.some((row) => row.fraction != null);
  const links = rows.some((row) => row.href != null);
  const List = ordered ? "ol" : "ul";
  const classes = cx(
    "pr-datalist",
    bars && "pr-datalist--bars",
    links && "pr-datalist--links",
    className,
  );
  return (
    <div className={classes}>
      {header ? (
        <div className="pr-datalist__header" aria-hidden>
          <span>{header.title}</span>
          {bars ? <span /> : null}
          <span className="pr-datalist__header-value">{header.value}</span>
          {links ? <span /> : null}
        </div>
      ) : null}
      <List className="pr-datalist__rows" aria-label={label}>
        {rows.map((row) => {
          const body = (
            <>
              <span className="pr-datalist__main">
                <span className="pr-datalist__title">
                  {row.leading}
                  <span className="pr-datalist__title-text">{row.title}</span>
                </span>
                {row.meta != null ? <span className="pr-datalist__meta">{row.meta}</span> : null}
              </span>
              {bars ? (
                <span className="pr-datalist__bar" aria-hidden>
                  {row.fraction != null ? (
                    <span
                      className="pr-datalist__fill"
                      style={{
                        width: `${Math.max(0, Math.min(1, row.fraction)) * 100}%`,
                        background: chartColor(row.barColor ?? "neutral"),
                      }}
                    />
                  ) : null}
                </span>
              ) : null}
              <span className="pr-datalist__figure">
                {row.value != null ? (
                  <span className="pr-datalist__value pr-tabular">{row.value}</span>
                ) : null}
                {row.detail != null ? (
                  <span className="pr-datalist__detail">{row.detail}</span>
                ) : null}
              </span>
              {links ? (
                <Icon icon={ChevronRight} size="sm" className="pr-datalist__chevron" />
              ) : null}
            </>
          );
          return (
            <li key={row.key}>
              {row.href ? (
                <a
                  className="pr-datalist__row"
                  href={row.href}
                  onClick={(event) => {
                    if (onNavigate && isPlainClick(event)) {
                      event.preventDefault();
                      onNavigate(row.href!);
                    }
                  }}
                >
                  {body}
                </a>
              ) : (
                <div className="pr-datalist__row">{body}</div>
              )}
            </li>
          );
        })}
      </List>
    </div>
  );
}

export interface GhostRowsProps {
  /** Default 3. */
  rows?: number;
  /** Each row fainter than the one above (default); off where something else fades them. */
  fade?: boolean;
  /** Widths of the dashed placeholders in a row, first to last, e.g. ["58%", "120px", "40px"]. */
  columns?: readonly string[];
  className?: string;
}

/**
 * The shape of the data a card will hold, drawn as dashed outlines. Static, so it never reads as
 * loading; pair it with a short StateMessage that says what will appear.
 */
export function GhostRows({
  rows = 3,
  fade = true,
  columns = ["56%", "40px"],
  className,
}: GhostRowsProps) {
  return (
    <div aria-hidden className={cx("pr-ghost", className)}>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="pr-ghost__row"
          style={fade ? { opacity: Math.max(0.2, 0.9 - index * 0.3) } : undefined}
        >
          {columns.map((width, column) => (
            <span
              key={column}
              className={cx("pr-ghost__shape", column > 0 && "pr-ghost__shape--end")}
              style={{ width: column === 0 ? `calc(${width} - ${index * 8}%)` : width }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export interface EmptyPanelProps {
  icon?: IconComponent;
  title: ReactNode;
  /** At most one short line. */
  description?: ReactNode;
  actions?: ReactNode;
  /** The shape of the data the card will hold, drawn faded behind the message. */
  ghost?: Pick<GhostRowsProps, "columns" | "rows">;
  /** Another shape behind the message instead of rows, e.g. `<GhostCards />`. */
  backdrop?: ReactNode;
  className?: string;
}

/**
 * A card's content when it has nothing to show yet (or cannot have it here): the message sits in
 * the middle of the content area, both ways, and the data's dashed shape fills the area behind it,
 * fading out toward the message. It grows to the card's height inside a flex column.
 */
export function EmptyPanel({
  icon,
  title,
  description,
  actions,
  ghost,
  backdrop,
  className,
}: EmptyPanelProps) {
  return (
    <div className={cx("pr-empty-panel", className)}>
      {backdrop ? (
        <div aria-hidden className="pr-empty-panel__ghost">
          {backdrop}
        </div>
      ) : ghost ? (
        <GhostRows
          rows={ghost.rows ?? 5}
          columns={ghost.columns}
          fade={false}
          className="pr-empty-panel__ghost"
        />
      ) : null}
      <StateMessage
        compact
        icon={icon}
        title={title}
        description={description}
        actions={actions}
        className="pr-empty-panel__message"
      />
    </div>
  );
}

/**
 * The shape of a grid of cards, drawn as dashed outlines: a tile, a name, two figures and a footer
 * line each. Static, for an empty grid's backdrop.
 */
export function GhostCards({ count = 6, className }: { count?: number; className?: string }) {
  const widths = ["52%", "64%", "44%", "58%", "48%", "60%", "42%", "56%", "50%"];
  return (
    <div aria-hidden className={cx("pr-ghost-cards", className)}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="pr-ghost-card">
          <span className="pr-ghost-card__head">
            <span className="pr-ghost__shape pr-ghost-card__tile" />
            <span className="pr-ghost__shape" style={{ width: widths[index % widths.length] }} />
          </span>
          <span className="pr-ghost-card__figures">
            <span className="pr-ghost__shape" />
            <span className="pr-ghost__shape" />
          </span>
          <span className="pr-ghost-card__foot">
            <span className="pr-ghost__shape" />
          </span>
        </div>
      ))}
    </div>
  );
}
