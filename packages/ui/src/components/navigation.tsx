// SPDX-License-Identifier: Apache-2.0
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { Icon, type IconComponent } from "../lib/icon.js";
import { useUiMessages } from "../i18n/ui-messages.js";

/** Moves focus among sibling buttons with arrows, Home and End. Returns the next index. */
function rovingIndex(
  event: KeyboardEvent,
  index: number,
  count: number,
  orientation: "horizontal" | "vertical" = "horizontal",
): number | null {
  const prev = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  const next = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  if (event.key === next) return (index + 1) % count;
  if (event.key === prev) return (index - 1 + count) % count;
  if (event.key === "Home") return 0;
  if (event.key === "End") return count - 1;
  return null;
}

export interface TabItem<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Show when it helps decide where to look. */
  count?: number | string;
  disabled?: boolean;
}

export interface TabsProps<V extends string> {
  value: V;
  onValueChange: (value: V) => void;
  items: readonly TabItem<V>[];
  label: string;
  size?: "sm" | "md";
  /**
   * Pair with <TabPanel idPrefix value> to link each tab to its panel (aria-controls).
   * Omit when the tabs switch content that is not wrapped in a TabPanel.
   */
  idPrefix?: string;
  className?: string;
}

/** Views of one object. role=tablist with automatic activation and roving focus. */
export function Tabs<V extends string>({
  value,
  onValueChange,
  items,
  label,
  size = "md",
  idPrefix,
  className,
}: TabsProps<V>) {
  const generated = useId();
  const prefix = idPrefix ?? generated;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = items.filter((item) => !item.disabled);
  return (
    <div role="tablist" aria-label={label} className={cx("pr-tabs", `pr-tabs--${size}`, className)}>
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`${prefix}-tab-${item.value}`}
            aria-selected={selected}
            aria-controls={idPrefix ? `${prefix}-panel-${item.value}` : undefined}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            className={cx("pr-tab", selected && "pr-tab--selected")}
            onClick={() => onValueChange(item.value)}
            onKeyDown={(event) => {
              const position = enabled.findIndex((entry) => entry.value === item.value);
              const next = rovingIndex(event, position, enabled.length);
              if (next == null) return;
              event.preventDefault();
              const target = enabled[next];
              if (!target) return;
              onValueChange(target.value);
              refs.current[items.indexOf(target)]?.focus();
            }}
          >
            <span>{item.label}</span>
            {item.count != null ? (
              <span className="pr-tab__count pr-tabular">{item.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  idPrefix: string;
  value: string;
  children: ReactNode;
  className?: string;
}

export function TabPanel({ idPrefix, value, children, className }: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${value}`}
      aria-labelledby={`${idPrefix}-tab-${value}`}
      tabIndex={0}
      className={cx("pr-tabpanel", className)}
    >
      {children}
    </div>
  );
}

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: ReactNode;
  count?: number | string;
  icon?: IconComponent;
  /** Required when the option has no visible text. */
  ariaLabel?: string;
}

export interface SegmentedControlProps<V extends string> {
  value: V;
  onValueChange: (value: V) => void;
  options: readonly SegmentedOption<V>[];
  label: string;
  size?: "sm" | "md";
  className?: string;
}

/** A mode or filter switched in place: the inverse pill from pathrule.io. role=radiogroup. */
export function SegmentedControl<V extends string>({
  value,
  onValueChange,
  options,
  label,
  size = "md",
  className,
}: SegmentedControlProps<V>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx("pr-segmented", `pr-segmented--${size}`, className)}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.ariaLabel}
            tabIndex={checked ? 0 : -1}
            className={cx("pr-segmented__option", checked && "pr-segmented__option--checked")}
            onClick={() => onValueChange(option.value)}
            onKeyDown={(event) => {
              const next = rovingIndex(event, index, options.length);
              if (next == null) return;
              event.preventDefault();
              const target = options[next];
              if (!target) return;
              onValueChange(target.value);
              refs.current[next]?.focus();
            }}
          >
            {option.icon ? <Icon icon={option.icon} size="sm" /> : null}
            {option.label}
            {option.count != null ? (
              <span className="pr-segmented__count pr-tabular">{option.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export interface FilterChipProps {
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  children: ReactNode;
  count?: number | string;
  /** A small glyph before the label, e.g. a status shape. */
  glyph?: ReactNode;
}

/** Independent facets. Toggle buttons with aria-pressed. */
export function FilterChip({
  selected,
  onSelectedChange,
  children,
  count,
  glyph,
}: FilterChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cx("pr-chip", selected && "pr-chip--selected")}
      onClick={() => onSelectedChange(!selected)}
    >
      {glyph}
      {children}
      {count != null ? <span className="pr-chip__count pr-tabular">{count}</span> : null}
    </button>
  );
}

export interface Crumb {
  label: string;
  href?: string;
  onClick?: () => void;
}

/** Reads like a path, in mono. The last crumb is the current page. */
export function Breadcrumbs({ items, className }: { items: readonly Crumb[]; className?: string }) {
  const ui = useUiMessages();
  return (
    <nav aria-label={ui.t("navigation.breadcrumb")} className={cx("pr-breadcrumbs", className)}>
      <ol>
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`}>
              {last ? (
                <span aria-current="page" className="pr-breadcrumbs__current">
                  {item.label}
                </span>
              ) : item.href ? (
                <a
                  href={item.href}
                  onClick={
                    item.onClick
                      ? (event) => {
                          event.preventDefault();
                          item.onClick?.();
                        }
                      : undefined
                  }
                >
                  {item.label}
                </a>
              ) : item.onClick ? (
                <button type="button" onClick={item.onClick}>
                  {item.label}
                </button>
              ) : (
                <span>{item.label}</span>
              )}
              {last ? null : (
                <span className="pr-breadcrumbs__sep" aria-hidden>
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  label?: string;
  /** The range in the page's own words, e.g. "1–12 of 28 workspaces". */
  formatRange?: (range: { from: number; to: number; total: number }) => string;
}

/** States the range first, page numbers second. */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  label,
  formatRange,
}: PaginationProps) {
  const ui = useUiMessages();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const visible = Array.from(new Set([1, 2, page - 1, page, page + 1, pages - 1, pages]))
    .filter((n) => n >= 1 && n <= pages)
    .sort((a, b) => a - b);
  return (
    <nav aria-label={label ?? ui.t("navigation.pagination")} className="pr-pagination">
      <span className="pr-pagination__range pr-tabular">
        {formatRange
          ? formatRange({ from, to, total })
          : ui.t("navigation.range", { from, to, total })}
      </span>
      <div className="pr-pagination__pages">
        <button
          type="button"
          className="pr-pagination__btn"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label={ui.t("navigation.previousPage")}
        >
          <Icon icon={ChevronLeft} size="sm" />
        </button>
        {visible.map((n, index) => (
          <span key={n} className="pr-pagination__item">
            {index > 0 && n - (visible[index - 1] ?? n) > 1 ? (
              <span className="pr-pagination__gap" aria-hidden>
                …
              </span>
            ) : null}
            <button
              type="button"
              className={cx("pr-pagination__btn", n === page && "pr-pagination__btn--current")}
              aria-current={n === page ? "page" : undefined}
              aria-label={ui.t("navigation.page", { page: n })}
              onClick={() => onPageChange(n)}
            >
              {n}
            </button>
          </span>
        ))}
        <button
          type="button"
          className="pr-pagination__btn"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pages}
          aria-label={ui.t("navigation.nextPage")}
        >
          <Icon icon={ChevronRight} size="sm" />
        </button>
      </div>
    </nav>
  );
}
