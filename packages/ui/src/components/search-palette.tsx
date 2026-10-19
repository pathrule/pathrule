// SPDX-License-Identifier: Apache-2.0
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CornerDownLeft, Search } from "lucide-react";
import { Fragment, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { Icon, type IconComponent } from "../lib/icon.js";
import { useUiMessages } from "../i18n/ui-messages.js";
import { chartColor, type ChartColor } from "./charts.js";

/** The square in front of a result: a kind's letter in its color, or an icon. */
export type SearchGlyph = { letter: string; color: ChartColor } | { icon: IconComponent };

export interface SearchPreviewFact {
  label: string;
  value: ReactNode;
}

/** What the side pane shows for the active result. */
export interface SearchPreview {
  kind: { label: string; color: ChartColor };
  path?: string;
  title: string;
  /** Plain text; the query's words are highlighted. */
  text: string;
  facts?: readonly SearchPreviewFact[];
  actions?: ReactNode;
}

export interface SearchResult {
  id: string;
  title: string;
  glyph: SearchGlyph;
  /** Mono, before the detail: a path or a slug. */
  path?: string;
  detail?: string;
  /** Right-aligned: a shortcut, or what ↵ does. */
  hint?: string;
  /** Opened in a new tab with ⌘↵. */
  href?: string;
  preview?: SearchPreview;
  onSelect: () => void;
}

export interface SearchGroup {
  id: string;
  heading: string;
  /** Right of the heading, e.g. a count. */
  meta?: string;
  results: readonly SearchResult[];
}

export interface SearchFilter {
  id: string;
  label: string;
  count?: number;
}

export interface SearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  groups: readonly SearchGroup[];
  placeholder?: string;
  /** Beside the input, before esc: what the search covers, e.g. a workspace menu. */
  scope?: ReactNode;
  filters?: readonly SearchFilter[];
  filter?: string;
  onFilterChange?: (id: string) => void;
  loading?: boolean;
  /** Shown instead of the list when there are no results. */
  empty?: ReactNode;
  /** The side pane when the active result has no preview (e.g. tips before typing). */
  aside?: ReactNode;
  /** Right of the key hints. */
  status?: ReactNode;
}

/** The query's words in `text`, marked; case-insensitive, longest words first. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 1)
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join("|")})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="pr-search__mark">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Glyph({ glyph }: { glyph: SearchGlyph }) {
  if ("icon" in glyph)
    return (
      <span className="pr-search__glyph" aria-hidden>
        <Icon icon={glyph.icon} size="sm" />
      </span>
    );
  return (
    <span
      className="pr-search__glyph pr-search__glyph--kind"
      style={{ ["--pr-glyph" as string]: chartColor(glyph.color) }}
      aria-hidden
    >
      {glyph.letter}
    </span>
  );
}

/**
 * ⌘K search: results grouped (knowledge first), filters as chips (Tab moves through them), the
 * active result previewed beside the list, and the keys spelled out underneath. A dialog holding
 * a combobox and a listbox: ↑↓ move aria-activedescendant, ↵ opens, ⌘↵ opens in a new tab, Esc
 * closes and returns focus. The caller searches: this component neither filters nor fetches.
 */
export function SearchPalette({
  open,
  onOpenChange,
  query,
  onQueryChange,
  groups,
  placeholder,
  scope,
  filters,
  filter,
  onFilterChange,
  loading,
  empty,
  aside,
  status,
}: SearchPaletteProps) {
  const ui = useUiMessages();
  const [active, setActive] = useState(0);
  const listId = useId();
  const flat = useMemo(() => groups.flatMap((group) => group.results), [groups]);
  const current = Math.min(active, Math.max(0, flat.length - 1));
  const activeResult = flat[current];

  useEffect(() => setActive(0), [query, filter, open]);

  const select = (result: SearchResult | undefined, newTab = false) => {
    if (!result) return;
    if (newTab && result.href) {
      window.open(result.href, "_blank", "noopener");
      return;
    }
    onOpenChange(false);
    result.onSelect();
  };

  const cycleFilter = (back: boolean) => {
    if (!filters?.length || !onFilterChange) return;
    const at = Math.max(
      0,
      filters.findIndex((f) => f.id === filter),
    );
    const next = filters[(at + (back ? filters.length - 1 : 1)) % filters.length];
    if (next) onFilterChange(next.id);
  };

  const preview = activeResult?.preview;
  const side = preview ? (
    <aside className="pr-search__preview" aria-label={ui.t("search.preview")}>
      <span className="pr-search__preview-kind">
        <span className="pr-search__kind">
          <span
            className="pr-search__kind-dot"
            style={{ ["--pr-glyph" as string]: chartColor(preview.kind.color) }}
            aria-hidden
          />
          {preview.kind.label}
        </span>
        {preview.path ? <span className="pr-search__preview-path">{preview.path}</span> : null}
      </span>
      <h3 className="pr-search__preview-title">{preview.title}</h3>
      <p className="pr-search__preview-text">
        <Highlight text={preview.text} query={query} />
      </p>
      {preview.facts?.length ? (
        <dl className="pr-search__facts">
          {preview.facts.map((fact) => (
            <Fragment key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      {preview.actions ? <div className="pr-search__preview-actions">{preview.actions}</div> : null}
    </aside>
  ) : aside ? (
    <aside className="pr-search__preview pr-search__preview--tips">{aside}</aside>
  ) : null;

  let index = -1;
  const nothing = !loading && flat.length === 0;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="pr-scrim" />
        <DialogPrimitive.Content
          className={cx("pr-search", nothing && empty ? "pr-search--narrow" : null)}
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="pr-sr-only">
            {ui.t("search.title")}
          </DialogPrimitive.Title>
          <div className="pr-search__bar">
            <Icon icon={Search} size="md" />
            <input
              className="pr-search__input"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeResult ? `${listId}-${activeResult.id}` : undefined}
              placeholder={placeholder ?? ui.t("command.placeholder")}
              value={query}
              autoFocus
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActive(Math.min(flat.length - 1, current + 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive(Math.max(0, current - 1));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  select(activeResult, event.metaKey || event.ctrlKey);
                } else if (event.key === "Tab" && filters?.length) {
                  event.preventDefault();
                  cycleFilter(event.shiftKey);
                }
              }}
            />
            {scope}
            <kbd className="pr-kbd">esc</kbd>
          </div>
          {filters?.length ? (
            <div className="pr-search__filters" role="group" aria-label={ui.t("search.filters")}>
              {filters.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  tabIndex={-1}
                  aria-pressed={f.id === filter}
                  className={cx("pr-search__filter", f.id === filter && "pr-search__filter--on")}
                  onClick={() => onFilterChange?.(f.id)}
                >
                  {f.label}
                  {f.count !== undefined ? (
                    <span className="pr-search__filter-count">{f.count}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          {nothing && empty ? (
            <div className="pr-search__empty">{empty}</div>
          ) : (
            <div className={cx("pr-search__body", side && "pr-search__body--split")}>
              <div
                id={listId}
                role="listbox"
                aria-label={ui.t("command.results")}
                className="pr-search__list"
              >
                {loading && flat.length === 0 ? (
                  <div className="pr-search__note">{ui.t("command.searching")}</div>
                ) : null}
                {nothing ? <div className="pr-search__note">{ui.t("command.empty")}</div> : null}
                {groups.map((group) =>
                  group.results.length ? (
                    <div
                      key={group.id}
                      role="group"
                      aria-label={group.heading}
                      className="pr-search__group"
                    >
                      <div className="pr-search__heading" aria-hidden>
                        <span>{group.heading}</span>
                        {group.meta ? <span>{group.meta}</span> : null}
                      </div>
                      {group.results.map((result) => {
                        index += 1;
                        const at = index;
                        const on = at === current;
                        return (
                          <div
                            key={result.id}
                            id={`${listId}-${result.id}`}
                            role="option"
                            aria-selected={on}
                            className={cx("pr-search__result", on && "pr-search__result--active")}
                            onMouseMove={() => setActive(at)}
                            onClick={(event) => select(result, event.metaKey || event.ctrlKey)}
                          >
                            <Glyph glyph={result.glyph} />
                            <span className="pr-search__text">
                              <span className="pr-search__title">
                                <Highlight text={result.title} query={query} />
                              </span>
                              {result.path || result.detail ? (
                                <span className="pr-search__detail">
                                  {result.path ? (
                                    <span className="pr-search__path">{result.path}</span>
                                  ) : null}
                                  {result.path && result.detail ? " · " : null}
                                  {result.detail}
                                </span>
                              ) : null}
                            </span>
                            {on ? (
                              <span className="pr-search__hint pr-search__hint--active">
                                <Icon icon={CornerDownLeft} size="xs" />
                                {ui.t("search.open")}
                              </span>
                            ) : result.hint ? (
                              <span className="pr-search__hint">{result.hint}</span>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null,
                )}
              </div>
              {side}
            </div>
          )}
          <div className="pr-search__keys">
            <span>
              <kbd className="pr-kbd">↑</kbd>
              <kbd className="pr-kbd">↓</kbd>
              {ui.t("search.move")}
            </span>
            <span>
              <kbd className="pr-kbd">↵</kbd>
              {ui.t("search.open")}
            </span>
            <span>
              <kbd className="pr-kbd">⌘↵</kbd>
              {ui.t("search.newTab")}
            </span>
            {filters?.length ? (
              <span>
                <kbd className="pr-kbd">tab</kbd>
                {ui.t("search.filter")}
              </span>
            ) : null}
            {status ? <span className="pr-search__status">{status}</span> : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
