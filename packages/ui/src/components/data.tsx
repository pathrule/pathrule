// SPDX-License-Identifier: Apache-2.0
import { Check, Copy, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { Icon } from "../lib/icon.js";
import { useUiMessages } from "../i18n/ui-messages.js";
import { uiMessages } from "../i18n/ui-messages.js";
import { createTranslator } from "../i18n/core.js";

/* ── Copy ────────────────────────────────────────────────────────────────── */

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await globalThis.navigator?.clipboard?.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface CopyButtonProps {
  value: string;
  /** What is copied, for the accessible name: "Copy workspace id". */
  label: string;
  /** Visible text next to the icon; omit for icon-only. */
  text?: string;
  /** "primary": the view's main action, drawn as a primary button. */
  emphasis?: "primary";
  className?: string;
}

/** Confirms in place for 1.5 s and never moves layout; announced politely. */
export function CopyButton({ value, label, text, emphasis, className }: CopyButtonProps) {
  const ui = useUiMessages();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      className={cx(
        "pr-copy",
        text && "pr-copy--text",
        emphasis === "primary" && "pr-copy--primary",
        state === "copied" && "pr-copy--done",
        className,
      )}
      aria-label={text ? undefined : label}
      onClick={async () => {
        const ok = await writeClipboard(value);
        setState(ok ? "copied" : "failed");
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 1500);
      }}
    >
      <Icon icon={state === "copied" ? Check : Copy} size="xs" />
      {text ? (
        <span className="pr-copy__text">
          {state === "copied" ? ui.t("copy.done") : state === "failed" ? ui.t("copy.failed") : text}
        </span>
      ) : null}
      <span className="pr-sr-only" aria-live="polite">
        {state === "copied" ? ui.t("copy.done") : state === "failed" ? ui.t("copy.failed") : ""}
      </span>
    </button>
  );
}

export interface CommandChipProps {
  command: string;
  prompt?: "$" | ">";
  className?: string;
}

/** The signature CLI line from pathrule.io: the exact command and a copy action. */
export function CommandChip({ command, prompt = "$", className }: CommandChipProps) {
  const ui = useUiMessages();
  return (
    <div className={cx("pr-command-chip", className)}>
      <span className="pr-command-chip__prompt" aria-hidden>
        {prompt}
      </span>
      <code className="pr-command-chip__code">{command}</code>
      <CopyButton
        value={command}
        label={ui.t("copy.command", { command })}
        text={ui.t("copy.chip")}
      />
    </div>
  );
}

/* ── Code ────────────────────────────────────────────────────────────────── */

export interface CodeBlockProps {
  code: string;
  /** File name or source shown in the header. */
  title?: string;
  /** 1-based line numbers to highlight. */
  highlight?: readonly number[];
  showLineNumbers?: boolean;
  copy?: boolean;
  className?: string;
}

/** Mono on the inset surface. Never highlighted with the accent: accent means trusted. */
export function CodeBlock({
  code,
  title,
  highlight = [],
  showLineNumbers = true,
  copy = true,
  className,
}: CodeBlockProps) {
  const ui = useUiMessages();
  const lines = code.replace(/\n$/, "").split("\n");
  return (
    <figure className={cx("pr-code", className)}>
      {title || copy ? (
        <figcaption className="pr-code__header">
          <span className="pr-code__title">{title}</span>
          {copy ? (
            <CopyButton
              value={code}
              label={title ? ui.t("copy.named", { name: title }) : ui.t("copy.code")}
              text={ui.t("copy.button")}
            />
          ) : null}
        </figcaption>
      ) : null}
      <pre className="pr-code__pre" tabIndex={0}>
        <code>
          {lines.map((line, index) => (
            <span
              key={index}
              className={cx("pr-code__line", highlight.includes(index + 1) && "pr-code__line--hl")}
            >
              {showLineNumbers ? (
                <span className="pr-code__num" aria-hidden>
                  {index + 1}
                </span>
              ) : null}
              <span className="pr-code__text">{line || " "}</span>
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}

export interface UntrustedTextProps {
  /** Raw text from outside Pathrule (runtime events, imports). Rendered as text only. */
  text: string;
  /** What the text is, e.g. "message" or "stack". */
  label: string;
  /** Where it came from, e.g. "runtime event · production". */
  source?: string;
  /** Truncate visually after this many characters; the full text stays selectable when expanded. */
  maxChars?: number;
  className?: string;
}

/**
 * Untrusted input: dashed border, inset surface, mono, plain text. Never rendered as
 * HTML or markdown, never linked, never styled with the accent.
 */
export function UntrustedText({
  text,
  label,
  source,
  maxChars = 1200,
  className,
}: UntrustedTextProps) {
  const ui = useUiMessages();
  const [expanded, setExpanded] = useState(false);
  const long = text.length > maxChars;
  const shown = long && !expanded ? `${text.slice(0, maxChars)}…` : text;
  return (
    <section
      className={cx("pr-untrusted", className)}
      aria-label={ui.t("untrusted.region", { label })}
    >
      <header className="pr-untrusted__header">
        <span className="pr-untrusted__label">{label}</span>
        <span className="pr-untrusted__flag">
          <Icon icon={TriangleAlert} size="xs" />
          {source ? ui.t("untrusted.flagWithSource", { source }) : ui.t("untrusted.flag")}
        </span>
      </header>
      <pre className="pr-untrusted__text">{shown}</pre>
      {long ? (
        <button
          type="button"
          className="pr-untrusted__more"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded
            ? ui.t("untrusted.showLess")
            : ui.t("untrusted.showAll", { count: text.length })}
        </button>
      ) : null}
    </section>
  );
}

/* ── Timeline and activity ───────────────────────────────────────────────── */

export type ActorKind = "person" | "agent" | "system";

export interface TimelineItem {
  id: string;
  title: ReactNode;
  detail?: ReactNode;
  /** ISO time; rendered relative with the absolute time on hover. */
  at: string;
  actor?: string;
  actorKind?: ActorKind;
  tone?: "neutral" | "accent" | "warning" | "danger" | "info";
}

const english = createTranslator(uiMessages);

/** English relative time ("5m ago"). Components use the provider's locale through `RelativeTime`. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  return english.relative(iso, now);
}

/** English date and time. Components use the provider's locale through `useUiMessages().dateTime`. */
export function absoluteTime(iso: string): string {
  return english.dateTime(iso);
}

/** Time element: relative text, absolute on hover, machine-readable datetime. */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const ui = useUiMessages();
  return (
    <time dateTime={iso} title={ui.dateTime(iso)} className={cx("pr-time", className)}>
      {ui.relative(iso)}
    </time>
  );
}

/** The history of one object, newest first. Distinguishes people, agents and the system. */
export function Timeline({
  items,
  className,
}: {
  items: readonly TimelineItem[];
  className?: string;
}) {
  return (
    <ol className={cx("pr-timeline", className)}>
      {items.map((item) => (
        <li
          key={item.id}
          className={cx("pr-timeline__item", `pr-timeline__item--${item.tone ?? "neutral"}`)}
        >
          <span className="pr-timeline__dot" aria-hidden />
          <div className="pr-timeline__body">
            <div className="pr-timeline__title">{item.title}</div>
            {item.detail ? <div className="pr-timeline__detail">{item.detail}</div> : null}
            <div className="pr-timeline__meta">
              {item.actor ? (
                <span
                  className={cx(
                    "pr-timeline__actor",
                    item.actorKind && `pr-timeline__actor--${item.actorKind}`,
                  )}
                >
                  {item.actor}
                  {item.actorKind ? <span className="pr-sr-only"> ({item.actorKind})</span> : null}
                </span>
              ) : null}
              <RelativeTime iso={item.at} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
