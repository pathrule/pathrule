// SPDX-License-Identifier: Apache-2.0
import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { Icon, type IconComponent } from "../lib/icon.js";
import { useUiMessages } from "../i18n/ui-messages.js";

export type Tone = "neutral" | "accent" | "positive" | "warning" | "danger" | "info";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  variant?: "soft" | "outline" | "solid";
  size?: "sm" | "md";
  icon?: IconComponent;
  /** Mono for identifiers, versions and environments. */
  mono?: boolean;
  children: ReactNode;
}

/** Badges label; they are never buttons. Pair status tones with a word, never color alone. */
export function Badge({
  tone = "neutral",
  variant = "soft",
  size = "md",
  icon,
  mono,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cx(
        "pr-badge",
        `pr-badge--${tone}`,
        `pr-badge--${variant}`,
        `pr-badge--${size}`,
        mono && "pr-mono",
        className,
      )}
      {...rest}
    >
      {icon ? <Icon icon={icon} size="xs" /> : null}
      {children}
    </span>
  );
}

export type ConnectionStatus = "connected" | "degraded" | "disconnected" | "pending" | "paused";

export interface StatusIndicatorProps {
  status: ConnectionStatus;
  /** Visible label. Defaults to the status word. */
  label?: ReactNode;
  /** Extra context, e.g. "last heartbeat 2m ago". */
  detail?: ReactNode;
  /**
   * Pulse only while something is actively happening. Callers decide; the default
   * pulses `connected` and `pending` and nothing else.
   */
  live?: boolean;
  className?: string;
}

/** Live state with a dot. Status text is always present, visible or for screen readers. */
export function StatusIndicator({ status, label, detail, live, className }: StatusIndicatorProps) {
  const ui = useUiMessages();
  const pulsing = live ?? (status === "connected" || status === "pending");
  return (
    <span className={cx("pr-status", `pr-status--${status}`, className)}>
      <span className={cx("pr-status__dot", pulsing && "pr-status__dot--live")} aria-hidden />
      <span className="pr-status__label">{label ?? ui.t(`status.${status}`)}</span>
      {detail ? <span className="pr-status__detail">{detail}</span> : null}
    </span>
  );
}

export interface DotProps {
  tone?: Tone | "muted";
  pulse?: boolean;
  className?: string;
}

export function Dot({ tone = "neutral", pulse = false, className }: DotProps) {
  return (
    <span
      aria-hidden
      className={cx("pr-dot", `pr-dot--${tone}`, pulse && "pr-dot--pulse", className)}
    />
  );
}

export interface AvatarProps {
  name: string;
  /** People are round; agents are square. */
  kind?: "person" | "agent";
  size?: 20 | 24 | 32 | 40;
  src?: string;
  className?: string;
}

function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const second = parts.length > 1 ? (parts[1]?.[0] ?? "") : (parts[0]?.[1] ?? "");
  return `${first}${second}`.toUpperCase();
}

export function Avatar({ name, kind = "person", size = 24, src, className }: AvatarProps) {
  return (
    <span
      role="img"
      aria-label={name}
      className={cx("pr-avatar", `pr-avatar--${kind}`, className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {src ? <img src={src} alt="" /> : initials(name)}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cx("pr-kbd", className)}>{children}</kbd>;
}
