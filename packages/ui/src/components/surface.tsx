// SPDX-License-Identifier: Apache-2.0
import { TrendingDown, TrendingUp } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { Icon, type IconComponent } from "../lib/icon.js";
import { Badge, type Tone } from "./badge.js";
import { Button } from "./button.js";
import { useUiMessages } from "../i18n/ui-messages.js";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: "section" | "article" | "div";
  /** Inset surface for terminals and untrusted payloads. */
  inset?: boolean;
  padded?: boolean;
}

/** Elevation 0: flat surface with a hairline border. Cards in page flow never cast shadows. */
export function Card({
  as: Tag = "section",
  inset,
  padded = false,
  className,
  ...rest
}: CardProps) {
  return (
    <Tag
      className={cx("pr-card", inset && "pr-card--inset", padded && "pr-card--padded", className)}
      {...rest}
    />
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  /** One line under the title: what the card shows and over which period. */
  description?: ReactNode;
  /** Mono meta on the right, e.g. "for you" or a count. */
  meta?: ReactNode;
  actions?: ReactNode;
  headingLevel?: 2 | 3;
  /** Id for the heading, so the card can be labelled by it. */
  id?: string;
  className?: string;
}

/** A described header has no rule under it: the description already separates it from the body. */
export function CardHeader({
  title,
  description,
  meta,
  actions,
  headingLevel = 2,
  id,
  className,
}: CardHeaderProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div
      className={cx(
        "pr-card__header",
        description != null && "pr-card__header--described",
        className,
      )}
    >
      <div className="pr-card__heading">
        <Heading id={id} className="pr-card__title">
          {title}
        </Heading>
        {description != null ? <p className="pr-card__description">{description}</p> : null}
      </div>
      {meta ? <span className="pr-card__meta">{meta}</span> : null}
      {actions ? <div className="pr-card__actions">{actions}</div> : null}
    </div>
  );
}

export interface MetricDelta {
  /** Signed and formatted, e.g. "+8.4%". */
  value: string;
  direction: "up" | "down" | "flat";
  /** Whether the change is good, bad or neither for this metric. */
  tone?: "positive" | "danger" | "neutral";
  /** What it is compared against, e.g. "vs previous 30 days". */
  label?: string;
}

export interface MetricCardProps {
  label: string;
  value: ReactNode;
  /**
   * Comparison or period, e.g. "3 recurred" or "last 7 days". Two entries render as exactly two
   * lines (context, then a quieter second line), each shortened rather than wrapped.
   */
  detail?: ReactNode | readonly [ReactNode, ReactNode];
  tone?: "neutral" | "accent" | "positive" | "warning" | "danger" | "info";
  icon?: IconComponent;
  /** Change against a previous period: an arrow, a signed value and a word, never color alone. */
  delta?: MetricDelta;
  /** A state beside the value, e.g. "Review" or "Recurring". Use it or `delta`, not both. */
  status?: { label: string; tone: Exclude<Tone, "accent">; icon?: IconComponent };
  /** A small figure under the value: a sparkline, a segment bar, a meter. */
  visual?: ReactNode;
  /** No data yet: the value reads muted. */
  empty?: boolean;
  /** The whole card links to where the number comes from. */
  href?: string;
  /** SPA navigation for `href`; modified clicks still follow it. */
  onNavigate?: (href: string) => void;
}

/**
 * A metric states a number and what it is compared against. Its four parts (label, value with one
 * qualifier, visual, detail) always render in that order, so a MetricGrid can line them up.
 */
export function MetricCard({
  label,
  value,
  detail,
  tone = "neutral",
  icon,
  delta,
  status,
  visual,
  empty,
  href,
  onNavigate,
}: MetricCardProps) {
  const className = cx(
    "pr-metric",
    `pr-metric--${tone}`,
    empty && "pr-metric--empty",
    href && "pr-metric--link",
  );
  const body = (
    <>
      <span className="pr-metric__label">
        {icon ? <Icon icon={icon} size="sm" /> : null}
        {label}
      </span>
      <span className="pr-metric__figure">
        <span className="pr-metric__value pr-tabular">{value}</span>
        {delta ? (
          <span className={cx("pr-metric__delta", `pr-metric__delta--${delta.tone ?? "neutral"}`)}>
            {delta.direction !== "flat" ? (
              <Icon icon={delta.direction === "up" ? TrendingUp : TrendingDown} size="xs" />
            ) : null}
            <span className="pr-tabular">{delta.value}</span>
            {delta.label ? <span className="pr-metric__delta-label">{delta.label}</span> : null}
          </span>
        ) : status ? (
          <Badge size="sm" tone={status.tone} icon={status.icon}>
            {status.label}
          </Badge>
        ) : null}
      </span>
      <span className="pr-metric__visual">{visual}</span>
      {Array.isArray(detail) ? (
        <span className="pr-metric__detail pr-metric__detail--lines">
          <span className="pr-metric__line">{detail[0]}</span>
          <span className="pr-metric__line pr-metric__line--quiet">{detail[1]}</span>
        </span>
      ) : (
        <span className="pr-metric__detail">{detail as ReactNode}</span>
      )}
    </>
  );
  if (!href) return <div className={className}>{body}</div>;
  return (
    <a
      className={className}
      href={href}
      onClick={(event) => {
        if (
          onNavigate &&
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          onNavigate(href);
        }
      }}
    >
      {body}
    </a>
  );
}

/**
 * A row of MetricCards that share one anatomy: every card's label, value, visual and detail sit
 * on the same lines, whatever each card shows, so a row reads as one set.
 */
export function MetricGrid({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={label} className={cx("pr-metric-grid", className)}>
      {children}
    </section>
  );
}

export type AlertTone = "info" | "success" | "warning" | "danger" | "neutral";

export interface AlertProps {
  tone?: AlertTone;
  title: ReactNode;
  children?: ReactNode;
  icon?: IconComponent;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
  className?: string;
}

/** Alerts persist in context. Danger uses role=alert; everything else role=status. */
export function Alert({
  tone = "info",
  title,
  children,
  icon,
  action,
  onDismiss,
  className,
}: AlertProps) {
  const ui = useUiMessages();
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cx("pr-alert", `pr-alert--${tone}`, className)}
    >
      {icon ? <Icon icon={icon} size="md" className="pr-alert__icon" /> : null}
      <div className="pr-alert__body">
        <div className="pr-alert__title">{title}</div>
        {children ? <div className="pr-alert__text">{children}</div> : null}
      </div>
      {action || onDismiss ? (
        <div className="pr-alert__actions">
          {action ? (
            <Button size="sm" variant="secondary" onClick={action.onClick}>
              {action.label}
            </Button>
          ) : null}
          {onDismiss ? (
            <button
              type="button"
              className="pr-alert__dismiss"
              onClick={onDismiss}
              aria-label={ui.t("surface.dismiss")}
            >
              ×
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface BannerProps {
  tone?: AlertTone;
  icon?: IconComponent;
  children: ReactNode;
  action?: ReactNode;
}

/** Full-width page banner (offline, read-only mode). role=status; persists until resolved. */
export function Banner({ tone = "warning", icon, children, action }: BannerProps) {
  return (
    <div role="status" className={cx("pr-banner", `pr-banner--${tone}`)}>
      {icon ? <Icon icon={icon} size="sm" className="pr-banner__icon" /> : null}
      <span className="pr-banner__text">{children}</span>
      {action}
    </div>
  );
}

export interface StateProps {
  icon?: IconComponent;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Shown on errors so support can find the request. */
  requestId?: string;
  kind?: "empty" | "no-results" | "error" | "success" | "permission";
  /** Compact variant for use inside a card or table body. */
  compact?: boolean;
  className?: string;
}

/**
 * Empty explains what will appear and how; errors say what failed and keep the
 * request id; permission states name what is missing. No illustrations.
 */
export function StateMessage({
  icon,
  title,
  description,
  actions,
  requestId,
  kind = "empty",
  compact,
  className,
}: StateProps) {
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={cx("pr-state", `pr-state--${kind}`, compact && "pr-state--compact", className)}
    >
      {icon ? (
        <span className="pr-state__icon">
          <Icon icon={icon} size="lg" />
        </span>
      ) : null}
      <span className="pr-state__title">{title}</span>
      {description ? <span className="pr-state__description">{description}</span> : null}
      {actions ? <div className="pr-state__actions">{actions}</div> : null}
      {requestId ? <span className="pr-state__request">request {requestId}</span> : null}
    </div>
  );
}

export interface KeyValueItem {
  key: string;
  value: ReactNode;
  mono?: boolean;
  /** Plain-text value to copy; renders a labelled copy button. */
  copy?: string;
}

export interface KeyValueListProps {
  items: readonly KeyValueItem[];
  columns?: 1 | 2;
  className?: string;
  renderCopy?: (item: KeyValueItem) => ReactNode;
}

/** `<dl>` metadata for detail panels. Identifiers are mono. */
export function KeyValueList({ items, columns = 1, className, renderCopy }: KeyValueListProps) {
  return (
    <dl className={cx("pr-kv", columns === 2 && "pr-kv--grid", className)}>
      {items.map((item) => (
        <div key={item.key} className="pr-kv__row">
          <dt className="pr-kv__key">{item.key}</dt>
          <dd className={cx("pr-kv__value", item.mono && "pr-mono")}>
            {item.value}
            {item.copy && renderCopy ? renderCopy(item) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cx("pr-divider", className)} />;
}
