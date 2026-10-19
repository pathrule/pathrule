// SPDX-License-Identifier: Apache-2.0
// The Activity page's pieces: a work session as a card, the sessions of one day, and the three
// cards beside them (where work landed, the kind of work, the agents and how well they log).
import type { LocalActivityEntry } from "@pathrule/protocol/local-ui-api.js";
import {
  Avatar,
  Card,
  CardHeader,
  Dot,
  EmptyPanel,
  SegmentBar,
  Swatch,
  type ChartColor,
} from "@pathrule/ui";
import { TriangleAlert } from "lucide-react";
import type { MouseEvent } from "react";
import { useConsoleMessages } from "../messages.js";
import type { AgentRow, FolderRow, WorkSession } from "./model.js";

type Messages = ReturnType<typeof useConsoleMessages>;

const DOMAIN_COLORS: Record<string, ChartColor> = {
  backend: "viz-1",
  ui: "viz-3",
  database: "viz-2",
  test: "viz-4",
  docs: "viz-5",
};

export function domainColor(domain: string): ChartColor {
  return DOMAIN_COLORS[domain] ?? "neutral";
}

const DOMAINS = ["backend", "ui", "database", "test", "docs", "infra", "config", "other"] as const;
const CLIENTS = [
  "claude-code",
  "codex",
  "cursor",
  "windsurf",
  "copilot",
  "cloud-connector",
  "other",
  "unknown",
] as const;

export function domainLabel(m: Messages, domain: string): string {
  return (DOMAINS as readonly string[]).includes(domain)
    ? m.t(`activity.domain.${domain as (typeof DOMAINS)[number]}`)
    : domain;
}

export function clientLabel(m: Messages, client: string | null): string {
  const key = client ?? "unknown";
  return (CLIENTS as readonly string[]).includes(key)
    ? m.t(`activity.client.${key as (typeof CLIENTS)[number]}`)
    : key;
}

/** "1h 18m", "25m", "under a minute" never: a session of one entry reads "1m". */
export function durationText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function clock(m: Messages, iso: string): string {
  return m.dateTime(iso, { hour: "2-digit", minute: "2-digit" });
}

export function personName(
  m: Messages,
  session: { personName: string | null; personId: string },
): string {
  return (
    session.personName ?? (session.personId === "local" ? m.t("activity.you") : session.personId)
  );
}

/** Parts of the kind of work, each named on hover. */
export function MixBar({
  parts,
  size = "sm",
  label,
}: {
  parts: ReadonlyArray<{ domain: string; count: number }>;
  size?: "sm" | "md";
  label?: string;
}) {
  const m = useConsoleMessages();
  return (
    <SegmentBar
      size={size}
      label={label}
      format={(value) => m.plural("activity.entries", value)}
      segments={parts.map((part) => ({
        key: part.domain,
        value: part.count,
        color: domainColor(part.domain),
        label: domainLabel(m, part.domain),
      }))}
    />
  );
}

export function SessionCard({
  session,
  uncovered,
  href,
  onOpen,
}: {
  session: WorkSession;
  /** A folder of the session where agents had no knowledge. */
  uncovered: string | null;
  href: string;
  onOpen: () => void;
}) {
  const m = useConsoleMessages();
  const name = personName(m, session);
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    onOpen();
  };
  return (
    <article className="lc-ac-session">
      <div className="lc-ac-session__head">
        <span className="lc-ac-session__time pr-mono">
          {clock(m, session.start)}–{clock(m, session.end)} ·{" "}
          {durationText(Date.parse(session.end) - Date.parse(session.start))}
        </span>
        <span className="lc-ac-session__who">
          {session.personId === "local" ? null : <Avatar name={name} size={20} />}
          <span>{name}</span>
          <span className="lc-ac-session__agent">
            {m.t("activity.with", { agent: clientLabel(m, session.client) })}
          </span>
        </span>
        {uncovered ? (
          <span className="lc-ac-session__uncovered">
            <TriangleAlert size={12} aria-hidden />
            {m.t("activity.uncoveredChip", { path: uncovered })}
          </span>
        ) : null}
      </div>
      <a className="lc-ac-session__title" href={href} onClick={open}>
        {session.title ?? m.t("activity.none")}
      </a>
      {session.subjects.length ? (
        <span className="lc-ac-session__subjects">
          {session.subjects.map((subject) => (
            <span key={subject} className="lc-ac-chip pr-mono">
              {subject}
            </span>
          ))}
        </span>
      ) : null}
      <div className="lc-ac-session__foot">
        <span>{m.plural("activity.entries", session.entries.length)}</span>
        {session.files.length ? (
          <span>{m.plural("activity.filesCount", session.files.length)}</span>
        ) : null}
        <span className="lc-ac-session__folders">
          {session.folders.slice(0, 3).map((folder) => (
            <span key={folder} className="pr-mono">
              {folder}
            </span>
          ))}
        </span>
        <span className="lc-ac-session__mix">
          <MixBar parts={session.domains} label={m.t("activity.sessionMix")} />
        </span>
      </div>
    </article>
  );
}

const FOLDER_TONE = { none: "danger", older: "warning", current: "positive" } as const;

export function WhereCard({ rows }: { rows: readonly FolderRow[] }) {
  const m = useConsoleMessages();
  const most = Math.max(1, ...rows.map((row) => row.sessions));
  return (
    <Card aria-labelledby="activity-where">
      <CardHeader
        id="activity-where"
        title={m.t("activity.where.title")}
        description={m.t("activity.where.description")}
      />
      {rows.length === 0 ? (
        <EmptyPanel
          title={m.t("activity.where.empty")}
          ghost={{ columns: ["52%", "48px"], rows: 3 }}
        />
      ) : (
        <ul className="lc-ac-where">
          {rows.slice(0, 8).map((row) => (
            <li key={row.folder} className="lc-ac-where__row">
              <span className="lc-ac-where__line">
                <span className="lc-ac-where__path pr-mono">{row.folder}</span>
                <span className="lc-ac-where__count pr-tabular">
                  {m.plural("activity.sessionsCount", row.sessions)}
                </span>
              </span>
              <SegmentBar
                size="sm"
                track
                scale={row.sessions / most}
                segments={[{ key: "sessions", value: 1, color: "neutral" }]}
              />
              <span className={`lc-ac-where__note lc-ac-where__note--${row.knowledge.state}`}>
                <Dot tone={FOLDER_TONE[row.knowledge.state]} />
                {row.knowledge.state === "none"
                  ? m.t("activity.where.none")
                  : row.knowledge.state === "older"
                    ? m.t("activity.where.older", {
                        items: m.plural("activity.where.items", row.knowledge.items),
                        older: m.number(row.knowledge.older),
                      })
                    : m.t("activity.where.current", {
                        items: m.plural("activity.where.items", row.knowledge.items),
                      })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** How many kinds of work the mix names; the rest are summed into "Other". */
const MIX_PARTS = 5;
/** How many agents the Agents card names; the rest are counted. */
const AGENT_ROWS = 5;

/** The largest parts, and the rest as one "other" part (with any "other" already there). */
export function foldMix(parts: ReadonlyArray<{ domain: string; count: number }>) {
  const sorted = [...parts].sort((a, b) => b.count - a.count);
  if (sorted.length <= MIX_PARTS + 1) return sorted;
  const keep = sorted.filter((part) => part.domain !== "other").slice(0, MIX_PARTS);
  const rest = sorted.filter((part) => !keep.includes(part)).reduce((n, part) => n + part.count, 0);
  return [...keep, { domain: "other", count: rest }];
}

export function MixCard({
  parts: all,
}: {
  parts: ReadonlyArray<{ domain: string; count: number }>;
}) {
  const m = useConsoleMessages();
  const parts = foldMix(all);
  return (
    <Card aria-labelledby="activity-mix" padded>
      <div className="pr-stack pr-stack--3">
        <div>
          <h2 id="activity-mix" className="pr-card__title">
            {m.t("activity.mix.title")}
          </h2>
          <p className="pr-card__description">{m.t("activity.mix.description")}</p>
        </div>
        <MixBar
          parts={parts}
          size="md"
          label={m.t("activity.mix.label", {
            parts: parts.map((part) => `${domainLabel(m, part.domain)} ${part.count}`).join(", "),
          })}
        />
        <ul className="lc-ac-legend">
          {parts.map((part) => (
            <li key={part.domain}>
              <Swatch color={domainColor(part.domain)} />
              <span>{domainLabel(m, part.domain)}</span>
              <span className="lc-ac-legend__count pr-tabular">{m.number(part.count)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export function AgentsCard({ rows }: { rows: readonly AgentRow[] }) {
  const m = useConsoleMessages();
  return (
    <Card aria-labelledby="activity-agents" padded>
      <div className="pr-stack pr-stack--3">
        <div>
          <h2 id="activity-agents" className="pr-card__title">
            {m.t("activity.agents.title")}
          </h2>
          <p className="pr-card__description">{m.t("activity.agents.description")}</p>
        </div>
        <ul className="lc-ac-agents">
          {rows.slice(0, AGENT_ROWS).map((row) => (
            <li key={row.client} className="lc-ac-agents__row">
              <Avatar name={clientLabel(m, row.client)} kind="agent" size={20} />
              <span className="lc-ac-agents__name">{clientLabel(m, row.client)}</span>
              <span className="lc-ac-agents__entries pr-tabular">
                {m.plural("activity.entries", row.entries)}
              </span>
              <span
                className={
                  row.withFiles === 0
                    ? "lc-ac-agents__quality lc-ac-agents__quality--none"
                    : row.withFiles < 0.5
                      ? "lc-ac-agents__quality lc-ac-agents__quality--low"
                      : "lc-ac-agents__quality"
                }
              >
                {row.withFiles === 0
                  ? m.t("activity.agents.noFiles")
                  : m.t("activity.agents.files", {
                      percent: m.number(row.withFiles, {
                        style: "percent",
                        maximumFractionDigits: 0,
                      }),
                    })}
              </span>
            </li>
          ))}
        </ul>
        {rows.length > AGENT_ROWS ? (
          <p className="lc-ac-more">{m.plural("activity.agents.more", rows.length - AGENT_ROWS)}</p>
        ) : null}
      </div>
    </Card>
  );
}

/** "Backend · update" for one entry. */
export function entryKind(m: Messages, entry: LocalActivityEntry): string {
  const domain = entry.domain ? domainLabel(m, entry.domain) : null;
  return domain && entry.action
    ? m.t("activity.session.kind", { domain, action: entry.action })
    : (domain ?? entry.action ?? "");
}
