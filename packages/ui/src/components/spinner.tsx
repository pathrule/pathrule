// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type CSSProperties } from "react";
import { cx } from "../lib/cx.js";
import { useUiMessages } from "../i18n/ui-messages.js";

export interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  /** Announced text. `null` for spinners inside a control that already sets aria-busy. */
  label?: string | null;
  /** Only show after this many ms so fast work never flashes a spinner. */
  delayMs?: number;
  className?: string;
}

export function Spinner({ size = "md", label: givenLabel, delayMs = 0, className }: SpinnerProps) {
  const ui = useUiMessages();
  const label = givenLabel === undefined ? ui.t("common.loading") : givenLabel;
  const [visible, setVisible] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) return;
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  if (!visible) return null;
  return (
    <span
      className={cx("pr-spinner", `pr-spinner--${size}`, className)}
      role={label ? "status" : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
    />
  );
}

export interface ProgressProps {
  /** Omit for indeterminate work: no percentage is shown. */
  value?: number;
  max?: number;
  label: string;
  /** Text read by assistive tech, e.g. "64 percent uploaded". */
  valueText?: string;
  tone?: "accent" | "warning" | "danger";
  className?: string;
}

export function Progress({
  value,
  max = 100,
  label,
  valueText,
  tone = "accent",
  className,
}: ProgressProps) {
  const determinate = typeof value === "number";
  const pct = determinate ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? max : undefined}
      aria-valuenow={determinate ? value : undefined}
      aria-valuetext={valueText}
      className={cx(
        "pr-progress",
        `pr-progress--${tone}`,
        !determinate && "pr-progress--indeterminate",
        className,
      )}
    >
      <span
        className="pr-progress__bar"
        style={determinate ? ({ width: `${pct}%` } as CSSProperties) : undefined}
      />
    </div>
  );
}

export interface MeterProps {
  label: string;
  value: number;
  /**
   * `null` when the plan or capability does not include this resource; "unlimited" when it has no
   * limit, which keeps the meter's shape (a dashed track, no fill) so it lines up with the others.
   */
  max: number | null | "unlimited";
  /** Thresholds as percentages: tone changes at warn and danger. */
  thresholds?: { warn: number; danger: number };
  format?: (n: number) => string;
  /** Said under the bar instead of the percentage ("Granted by Pathrule", "Renews Nov 1"). */
  detail?: string;
  className?: string;
}

/** Usage meters change tone at thresholds and always state the numbers in text. */
export function Meter({
  label,
  value,
  max,
  thresholds = { warn: 80, danger: 100 },
  format: givenFormat,
  detail,
  className,
}: MeterProps) {
  const ui = useUiMessages();
  const format = givenFormat ?? ((n: number) => ui.number(n));
  if (max === "unlimited") {
    return (
      <div className={cx("pr-meter", className)}>
        <div className="pr-meter__head">
          <span className="pr-meter__label">{label}</span>
          <span className="pr-meter__value pr-tabular">{format(value)}</span>
        </div>
        <div
          className="pr-progress pr-progress--unlimited"
          role="img"
          aria-label={`${label}: ${ui.t("meter.usedUnlimited", { value: format(value) })}`}
        />
        <span className="pr-meter__note">{detail ?? ui.t("meter.unlimited")}</span>
      </div>
    );
  }
  const pct = max && max > 0 ? (value / max) * 100 : 100;
  const tone =
    max == null || pct >= thresholds.danger
      ? "danger"
      : pct >= thresholds.warn
        ? "warning"
        : "accent";
  const percent = Math.round(pct);
  const note =
    max == null
      ? ui.t("meter.notIncluded")
      : pct >= thresholds.danger
        ? ui.t("meter.atLimit")
        : pct >= thresholds.warn
          ? ui.t("meter.approaching", { percent })
          : ui.t("meter.percent", { percent });
  const summary =
    max == null
      ? ui.t("meter.usedNotIncluded", { value: format(value) })
      : ui.t("meter.valueOfMax", { value: format(value), max: format(max) });
  return (
    <div className={cx("pr-meter", className)}>
      <div className="pr-meter__head">
        <span className="pr-meter__label">{label}</span>
        <span className="pr-meter__value pr-tabular">
          {max == null
            ? ui.t("meter.valueSlashNotIncluded", { value: format(value) })
            : ui.t("meter.valueSlashMax", { value: format(value), max: format(max) })}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max ?? 0}
        aria-valuenow={value}
        aria-valuetext={summary}
        className={cx("pr-progress", `pr-progress--${tone}`)}
      >
        <span className="pr-progress__bar" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className={cx("pr-meter__note", `pr-meter__note--${tone}`)}>{detail ?? note}</span>
    </div>
  );
}

export interface SkeletonProps {
  shape?: "line" | "row" | "card";
  width?: string;
  className?: string;
}

/** Mirrors the final layout. Containers that hold skeletons set aria-busy. */
export function Skeleton({ shape = "line", width, className }: SkeletonProps) {
  return (
    <span
      aria-hidden
      className={cx("pr-skeleton", `pr-skeleton--${shape}`, className)}
      style={width ? { width } : undefined}
    />
  );
}
