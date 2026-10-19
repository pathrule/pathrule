// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { Checkbox } from "./forms.js";
import { Skeleton } from "./spinner.js";
import { useUiMessages } from "../i18n/ui-messages.js";

export type SortDirection = "ascending" | "descending";

export interface SortState<K extends string = string> {
  key: K;
  direction: SortDirection;
}

export interface Column<Row, K extends string = string> {
  key: K;
  header: ReactNode;
  /** Plain-text header for the mobile card label and the sort button name. */
  label?: string;
  sortable?: boolean;
  align?: "start" | "end";
  /** CSS width, e.g. "90px" or "minmax(0, 2fr)" is not supported: use px or %. */
  width?: string;
  /** Hide on narrow screens (the card layout shows only primary columns). */
  hideOnMobile?: boolean;
  /** The row's actions (a menu or buttons): the card layout puts them at the card's top-right, unlabelled. */
  actions?: boolean;
  render: (row: Row) => ReactNode;
}

export interface DataTableProps<Row, K extends string = string> {
  columns: readonly Column<Row, K>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** Accessible table name. */
  caption: string;
  captionHidden?: boolean;
  sort?: SortState<K> | null;
  onSortChange?: (sort: SortState<K>) => void;
  selectable?: boolean;
  selected?: ReadonlySet<string>;
  onSelectedChange?: (selected: Set<string>) => void;
  /** Replaces the header row while rows are selected, so the table never jumps. */
  bulkActions?: (selected: ReadonlySet<string>) => ReactNode;
  onRowClick?: (row: Row) => void;
  loading?: boolean;
  /** Rendered in place of rows when there are none and not loading. */
  empty?: ReactNode;
  rowTone?: (row: Row) => "default" | "muted" | "danger" | undefined;
  /**
   * Splits the rows into groups, in the order given: a heading row starts each run of rows with a
   * new group key (e.g. favorites, then the rest). Null leaves a row outside any group.
   */
  rowGroup?: (row: Row) => { key: string; heading: ReactNode } | null;
  className?: string;
}

/**
 * The workhorse. Native table semantics; sortable headers are buttons with aria-sort;
 * row click opens detail while checkboxes and menus stop propagation; under 600px rows
 * become cards (CSS only).
 */
export function DataTable<Row, K extends string = string>({
  columns,
  rows,
  rowKey,
  caption,
  captionHidden = true,
  sort,
  onSortChange,
  selectable = false,
  selected = new Set<string>(),
  onSelectedChange,
  bulkActions,
  onRowClick,
  loading = false,
  empty,
  rowTone,
  rowGroup,
  className,
}: DataTableProps<Row, K>) {
  const ui = useUiMessages();
  const allKeys = rows.map(rowKey);
  const selectedCount = allKeys.filter((key) => selected.has(key)).length;
  const headerState: boolean | "indeterminate" =
    selectedCount === 0 ? false : selectedCount === allKeys.length ? true : "indeterminate";
  const showBulk = selectable && selectedCount > 0 && bulkActions;
  const colCount = columns.length + (selectable ? 1 : 0);

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectedChange?.(next);
  };

  return (
    <div className={cx("pr-table-wrap", className)} aria-busy={loading || undefined}>
      <table className={cx("pr-table", onRowClick && "pr-table--interactive")}>
        <caption className={captionHidden ? "pr-sr-only" : "pr-table__caption"}>{caption}</caption>
        <thead>
          {showBulk ? (
            <tr className="pr-table__bulk">
              <th scope="col" className="pr-table__select">
                <Checkbox
                  checked={headerState}
                  onCheckedChange={(on) => onSelectedChange?.(on ? new Set(allKeys) : new Set())}
                  aria-label={ui.t("table.selectAll")}
                />
              </th>
              <th scope="colgroup" colSpan={colCount - 1}>
                <div className="pr-table__bulk-bar">
                  <span className="pr-table__bulk-count" role="status">
                    {ui.t("table.selected", { count: selectedCount })}
                  </span>
                  {bulkActions(selected)}
                </div>
              </th>
            </tr>
          ) : (
            <tr>
              {selectable ? (
                <th scope="col" className="pr-table__select">
                  <Checkbox
                    checked={headerState}
                    onCheckedChange={(on) => onSelectedChange?.(on ? new Set(allKeys) : new Set())}
                    aria-label={ui.t("table.selectAll")}
                  />
                </th>
              ) : null}
              {columns.map((column) => {
                const active = sort?.key === column.key;
                const ariaSort = active ? sort?.direction : column.sortable ? "none" : undefined;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={ariaSort}
                    className={cx(
                      column.align === "end" && "pr-table__cell--end",
                      column.hideOnMobile && "pr-table__cell--desktop",
                    )}
                    style={column.width ? { width: column.width } : undefined}
                  >
                    {column.sortable && onSortChange ? (
                      <button
                        type="button"
                        className={cx("pr-table__sort", active && "pr-table__sort--active")}
                        onClick={() =>
                          onSortChange({
                            key: column.key,
                            direction:
                              active && sort?.direction === "ascending"
                                ? "descending"
                                : "ascending",
                          })
                        }
                      >
                        {column.header}
                        <span aria-hidden className="pr-table__arrow">
                          {active ? (sort?.direction === "ascending" ? "↑" : "↓") : ""}
                        </span>
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          )}
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: 5 }, (_, index) => (
              <tr key={`sk-${index}`} className="pr-table__row">
                {selectable ? <td className="pr-table__select" /> : null}
                {columns.map((column, ci) => (
                  <td
                    key={column.key}
                    className={cx(column.hideOnMobile && "pr-table__cell--desktop")}
                  >
                    <Skeleton width={ci === 0 ? `${40 + ((index * 17) % 40)}%` : "60%"} />
                  </td>
                ))}
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={colCount} className="pr-table__empty">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => {
              const key = rowKey(row);
              const isSelected = selected.has(key);
              const tone = rowTone?.(row);
              const group = rowGroup?.(row) ?? null;
              const previous = index > 0 ? (rowGroup?.(rows[index - 1]!) ?? null) : null;
              const heading =
                group && group.key !== previous?.key ? (
                  <tr key={`group-${group.key}-${key}`} className="pr-table__group">
                    <th scope="colgroup" colSpan={colCount}>
                      {group.heading}
                    </th>
                  </tr>
                ) : null;
              const line = (
                <tr
                  key={key}
                  className={cx(
                    "pr-table__row",
                    isSelected && "pr-table__row--selected",
                    tone && tone !== "default" && `pr-table__row--${tone}`,
                  )}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {selectable ? (
                    <td className="pr-table__select" onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggle(key)}
                        aria-label={ui.t("table.selectRow")}
                      />
                    </td>
                  ) : null}
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      data-label={
                        column.actions
                          ? undefined
                          : (column.label ??
                            (typeof column.header === "string" ? column.header : undefined))
                      }
                      className={cx(
                        column.align === "end" && "pr-table__cell--end",
                        column.hideOnMobile && "pr-table__cell--desktop",
                        column.actions && "pr-table__cell--actions",
                      )}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              );
              return heading ? [heading, line] : line;
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The keyboard path into a clickable row: a real button styled as the row title.
 * Clicking it opens the row; it stops propagation so the row handler does not run twice.
 */
export function RowTitle({
  children,
  onOpen,
  mono,
  muted,
  struck,
}: {
  children: ReactNode;
  onOpen: () => void;
  mono?: boolean;
  muted?: boolean;
  struck?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx(
        "pr-row-title",
        mono && "pr-mono",
        muted && "pr-row-title--muted",
        struck && "pr-row-title--struck",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {children}
    </button>
  );
}
