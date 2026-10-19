// SPDX-License-Identifier: Apache-2.0
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { cx } from "../lib/cx.js";
import { Icon, type IconComponent } from "../lib/icon.js";
import { useUiMessages } from "../i18n/ui-messages.js";

export interface CommandItem {
  id: string;
  title: string;
  icon?: IconComponent;
  /** Right-aligned hint: a path, a shortcut. */
  hint?: string;
  keywords?: string;
  onSelect: () => void;
}

export interface CommandGroup {
  heading: string;
  items: readonly CommandItem[];
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: readonly CommandGroup[];
  placeholder?: string;
  loading?: boolean;
  emptyText?: string;
}

/**
 * ⌘K from anywhere: navigation and actions in one keyboard-first list. A dialog holding
 * a combobox and a listbox; ↑↓ move aria-activedescendant, ↵ selects, Esc closes and
 * returns focus. Destructive actions do not belong here without their own confirmation.
 */
export function CommandPalette({
  open,
  onOpenChange,
  groups,
  placeholder,
  loading,
  emptyText,
}: CommandPaletteProps) {
  const ui = useUiMessages();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups
      .map((group) => ({
        heading: group.heading,
        items: group.items.filter(
          (item) =>
            !q ||
            `${item.title} ${item.hint ?? ""} ${item.keywords ?? ""}`.toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [groups, query]);

  const flat = filtered.flatMap((group) => group.items);
  const current = Math.min(active, Math.max(0, flat.length - 1));
  const select = (item: CommandItem | undefined) => {
    if (!item) return;
    onOpenChange(false);
    item.onSelect();
  };

  let index = -1;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="pr-scrim" />
        <DialogPrimitive.Content className="pr-command" aria-describedby={undefined}>
          <DialogPrimitive.Title className="pr-sr-only">
            {ui.t("command.title")}
          </DialogPrimitive.Title>
          <div className="pr-command__search">
            <Icon icon={Search} size="md" />
            <input
              className="pr-command__input"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={flat[current] ? `${listId}-${flat[current]?.id}` : undefined}
              placeholder={placeholder ?? ui.t("command.placeholder")}
              value={query}
              autoFocus
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActive(Math.min(flat.length - 1, current + 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive(Math.max(0, current - 1));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  select(flat[current]);
                }
              }}
            />
            <kbd className="pr-kbd">esc</kbd>
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label={ui.t("command.results")}
            className="pr-command__list"
          >
            {loading ? <div className="pr-command__empty">{ui.t("command.searching")}</div> : null}
            {!loading && flat.length === 0 ? (
              <div className="pr-command__empty">{emptyText ?? ui.t("command.empty")}</div>
            ) : null}
            {filtered.map((group) => (
              <div
                key={group.heading}
                role="group"
                aria-label={group.heading}
                className="pr-command__group"
              >
                <div className="pr-command__heading" aria-hidden>
                  {group.heading}
                </div>
                {group.items.map((item) => {
                  index += 1;
                  const itemIndex = index;
                  const on = itemIndex === current;
                  return (
                    <div
                      key={item.id}
                      id={`${listId}-${item.id}`}
                      role="option"
                      aria-selected={on}
                      className={cx("pr-command__item", on && "pr-command__item--active")}
                      onMouseMove={() => setActive(itemIndex)}
                      onClick={() => select(item)}
                    >
                      {item.icon ? (
                        <Icon icon={item.icon} size="sm" />
                      ) : (
                        <span className="pr-menu__icon-gap" aria-hidden />
                      )}
                      <span className="pr-command__title">{item.title}</span>
                      {item.hint ? <span className="pr-command__hint">{item.hint}</span> : null}
                      {on ? (
                        <Icon icon={CornerDownLeft} size="xs" className="pr-command__enter" />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
