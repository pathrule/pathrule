// SPDX-License-Identifier: Apache-2.0
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { Icon, type IconComponent } from "../lib/icon.js";
import { Spinner } from "./spinner.js";
import { Tooltip } from "./tooltip.js";

export type ButtonVariant = "primary" | "neutral" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

/** `true` disables silently; `{ reason }` keeps the button focusable and explains why. */
export type DisabledState = boolean | { reason: string };

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: DisabledState;
  leadingIcon?: IconComponent;
  trailingIcon?: IconComponent;
  /** Stretch to the container width (mobile sheets, stacked forms). */
  block?: boolean;
  children?: ReactNode;
}

const ICON_SIZE = { sm: "sm", md: "sm", lg: "md" } as const;

/**
 * Commits an action. Pill shape inherited from pathrule.io. One primary per region;
 * danger only when the action destroys data. Loading keeps the label and focus and
 * sets aria-busy; a permission-disabled button stays discoverable through a tooltip.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    disabled = false,
    leadingIcon,
    trailingIcon,
    block = false,
    type = "button",
    className,
    children,
    onClick,
    ...rest
  },
  ref,
) {
  const reason = typeof disabled === "object" ? disabled.reason : undefined;
  const inert = loading || Boolean(disabled);
  const button = (
    <button
      ref={ref}
      type={type}
      className={cx(
        "pr-btn",
        `pr-btn--${variant}`,
        `pr-btn--${size}`,
        block && "pr-btn--block",
        className,
      )}
      disabled={disabled === true}
      aria-disabled={reason || loading ? true : undefined}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      onClick={(event) => {
        if (inert) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      {...rest}
    >
      {loading ? (
        <Spinner size="sm" label={null} />
      ) : leadingIcon ? (
        <Icon icon={leadingIcon} size={ICON_SIZE[size]} />
      ) : null}
      {children != null && <span className="pr-btn__label">{children}</span>}
      {trailingIcon && !loading ? <Icon icon={trailingIcon} size={ICON_SIZE[size]} /> : null}
    </button>
  );
  return reason ? <Tooltip content={reason}>{button}</Tooltip> : button;
});

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "disabled" | "children"
> {
  icon: IconComponent;
  /** Required: becomes aria-label and the tooltip text. */
  label: string;
  variant?: "ghost" | "secondary";
  size?: ButtonSize;
  disabled?: DisabledState;
  /** Show the label as a tooltip on hover and focus. */
  tooltip?: boolean;
  pressed?: boolean;
}

/** Square, 8px radius. For dense toolbars and row actions. Always labelled. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    label,
    variant = "ghost",
    size = "md",
    disabled = false,
    tooltip = true,
    pressed,
    type = "button",
    className,
    onClick,
    ...rest
  },
  ref,
) {
  const reason = typeof disabled === "object" ? disabled.reason : undefined;
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={reason ? true : undefined}
      disabled={disabled === true}
      className={cx("pr-icon-btn", `pr-icon-btn--${variant}`, `pr-icon-btn--${size}`, className)}
      onClick={(event) => {
        if (reason) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      {...rest}
    >
      <Icon icon={icon} size={size === "lg" ? "lg" : size === "sm" ? "sm" : "md"} />
    </button>
  );
  if (!tooltip && !reason) return button;
  return <Tooltip content={reason ? `${label}: ${reason}` : label}>{button}</Tooltip>;
});
