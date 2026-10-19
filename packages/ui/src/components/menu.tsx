// SPDX-License-Identifier: Apache-2.0
import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { ReactElement, ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { Icon, type IconComponent } from "../lib/icon.js";

export interface MenuAction {
  label: string;
  icon?: IconComponent;
  shortcut?: string;
  /** Destructive items come last and use the danger tone. */
  tone?: "default" | "danger";
  /** Disabled items stay visible and say why. */
  disabled?: { reason: string };
  /** Small secondary line under the label. */
  description?: string;
  onSelect: () => void;
}

export interface MenuGroupLabel {
  heading: string;
}

export type MenuEntry = MenuAction | MenuGroupLabel | "separator";

export interface MenuProps {
  trigger: ReactElement;
  items: readonly MenuEntry[];
  align?: "start" | "end";
  label?: string;
  /** Optional header above the items, e.g. the signed-in account. */
  header?: ReactNode;
  className?: string;
}

function isHeading(entry: MenuEntry): entry is MenuGroupLabel {
  return typeof entry === "object" && "heading" in entry;
}

/**
 * Row actions and contextual commands with one item anatomy: icon, label, shortcut.
 * Arrow keys, typeahead and Escape come from the menu primitive; focus returns to the trigger.
 */
export function Menu({ trigger, items, align = "end", label, header, className }: MenuProps) {
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger asChild>{trigger}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cx("pr-menu", className)}
          aria-label={label}
        >
          {header ? <div className="pr-menu__header">{header}</div> : null}
          {items.map((entry, index) => {
            if (entry === "separator")
              return (
                <MenuPrimitive.Separator key={`sep-${index}`} className="pr-menu__separator" />
              );
            if (isHeading(entry))
              return (
                <MenuPrimitive.Label key={`h-${entry.heading}`} className="pr-menu__heading">
                  {entry.heading}
                </MenuPrimitive.Label>
              );
            const disabled = Boolean(entry.disabled);
            return (
              <MenuPrimitive.Item
                key={entry.label}
                disabled={disabled}
                onSelect={() => {
                  if (!disabled) entry.onSelect();
                }}
                className={cx("pr-menu__item", entry.tone === "danger" && "pr-menu__item--danger")}
              >
                {entry.icon ? (
                  <Icon icon={entry.icon} size="sm" />
                ) : (
                  <span className="pr-menu__icon-gap" aria-hidden />
                )}
                <span className="pr-menu__text">
                  <span>{entry.label}</span>
                  {entry.disabled ? (
                    <span className="pr-menu__why">{entry.disabled.reason}</span>
                  ) : entry.description ? (
                    <span className="pr-menu__why">{entry.description}</span>
                  ) : null}
                </span>
                {entry.shortcut ? (
                  <span className="pr-menu__shortcut">{entry.shortcut}</span>
                ) : null}
              </MenuPrimitive.Item>
            );
          })}
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

export interface MenuRadioOption {
  value: string;
  label: ReactNode;
  meta?: ReactNode;
}

export interface MenuRadioProps {
  trigger: ReactElement;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly MenuRadioOption[];
  heading?: string;
  footer?: readonly MenuAction[];
  label?: string;
  align?: "start" | "end";
  className?: string;
}

/** A switcher menu (organization, workspace): one checked option plus optional actions. */
export function MenuRadio({
  trigger,
  value,
  onValueChange,
  options,
  heading,
  footer,
  label,
  align = "start",
  className,
}: MenuRadioProps) {
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger asChild>{trigger}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          align={align}
          sideOffset={4}
          collisionPadding={8}
          className={cx("pr-menu pr-menu--switcher", className)}
          aria-label={label}
        >
          {heading ? (
            <MenuPrimitive.Label className="pr-menu__heading">{heading}</MenuPrimitive.Label>
          ) : null}
          <MenuPrimitive.RadioGroup value={value} onValueChange={onValueChange}>
            {options.map((option) => (
              <MenuPrimitive.RadioItem
                key={option.value}
                value={option.value}
                className="pr-menu__item pr-menu__item--radio"
              >
                <span className="pr-menu__text">
                  <span>{option.label}</span>
                  {option.meta ? <span className="pr-menu__why">{option.meta}</span> : null}
                </span>
                <MenuPrimitive.ItemIndicator className="pr-menu__check" aria-hidden>
                  ✓
                </MenuPrimitive.ItemIndicator>
              </MenuPrimitive.RadioItem>
            ))}
          </MenuPrimitive.RadioGroup>
          {footer && footer.length ? (
            <>
              <MenuPrimitive.Separator className="pr-menu__separator" />
              {footer.map((action) => (
                <MenuPrimitive.Item
                  key={action.label}
                  disabled={Boolean(action.disabled)}
                  onSelect={() => action.onSelect()}
                  className="pr-menu__item"
                >
                  {action.icon ? (
                    <Icon icon={action.icon} size="sm" />
                  ) : (
                    <span className="pr-menu__icon-gap" aria-hidden />
                  )}
                  <span className="pr-menu__text">
                    <span>{action.label}</span>
                    {action.disabled ? (
                      <span className="pr-menu__why">{action.disabled.reason}</span>
                    ) : null}
                  </span>
                </MenuPrimitive.Item>
              ))}
            </>
          ) : null}
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
