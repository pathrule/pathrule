// SPDX-License-Identifier: Apache-2.0
// The Signals overview: the app's connection per environment, four figures, what needs a fix by
// area of the code, the fixes a newer release is proving, and what each release did. The two
// tables share one column grid, so their status and bar columns line up.
import { Folder, Layers } from "lucide-react";
import { type MouseEvent, type ReactNode } from "react";
import { Badge, Dot, type Tone } from "../components/badge.js";
import { SegmentBar, Sparkbars, type ChartColor } from "../components/charts.js";
import { RelativeTime } from "../components/data.js";
import { EmptyPanel } from "../components/lists.js";
import { Card, CardHeader, MetricCard, MetricGrid } from "../components/surface.js";
import { DataTable, type Column } from "../components/table.js";
import { cx } from "../lib/cx.js";
import { issueTitle, type SignalIssue, type VerificationPolicy } from "./model.js";
import type {
  AreaGroup,
  Connection,
  FixState,
  ProofProgress,
  ReleaseRow,
  SignalsFigures,
} from "./insights.js";
import { fixState, recentCount } from "./insights.js";
import { useSignalsMessages } from "./messages.js";

type Messages = ReturnType<typeof useSignalsMessages>;

/** The knowledge agents get at a path, as the console counts it. */
export interface KnowledgeAtPath {
  memory: number;
  rule: number;
  skill: number;
  /** Where the console shows that knowledge. */
  href?: string;
}

export type KnowledgeAt = (path: string) => KnowledgeAtPath | null;

const STATE_TONE: Record<FixState, Tone | "muted"> = {
  open: "neutral",
  recurred: "danger",
  waiting: "muted",
  observing: "info",
  quiet: "warning",
  verified: "positive",
  event: "muted",
};

/** Where a fix stands, as a dot and a word: color never stands alone. */
export function FixStateLabel({ state }: { state: FixState }) {
  const m = useSignalsMessages();
  return (
    <span className={cx("pr-fixstate", `pr-fixstate--${state}`)}>
      <Dot tone={STATE_TONE[state]} />
      {m.t(`fixState.${state}`)}
    </span>
  );
}

/** "8 memories · 2 rules", or a warning that agents get nothing there. */
export function knowledgeText(m: Messages, knowledge: KnowledgeAtPath | null): string | null {
  if (!knowledge) return null;
  const parts = (["memory", "rule", "skill"] as const)
    .filter((kind) => knowledge[kind] > 0)
    .map((kind) => m.plural(`knowledgeCount.${kind}`, knowledge[kind]));
  return parts.length ? parts.join(" · ") : m.t("areas.noKnowledge");
}

function follow(href: string | undefined, onNavigate?: (href: string) => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (!href || !onNavigate) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    onNavigate(href);
  };
}

/** How many rows a summary card shows; the full lists live on their own tabs. */
const SUMMARY_ROWS = 6;

/* ── Connection ──────────────────────────────────────────────────────────── */

const CONNECTION_TONE: Record<Connection["state"], Tone | "muted"> = {
  receiving: "positive",
  quiet: "warning",
  silent: "muted",
};

export function ConnectionStrip({
  connections,
  now,
}: {
  connections: readonly Connection[];
  now: number;
}) {
  const m = useSignalsMessages();
  if (connections.length === 0) return null;
  return (
    <section className="pr-connections" aria-label={m.t("connection.label")}>
      {connections.map((connection) => (
        <div key={connection.environment} className="pr-connection">
          <span className="pr-connection__head">
            <Dot tone={CONNECTION_TONE[connection.state]} />
            <span className="pr-connection__env">{environmentName(connection.environment)}</span>
            <span className="pr-connection__release pr-mono">
              {connection.release ?? m.t("connection.noRelease")}
            </span>
          </span>
          {connection.hours ? (
            <Sparkbars
              className="pr-sparkbars--dense"
              format={(value) => m.t(value ? "connection.heard" : "connection.notHeard")}
              bars={connection.hours.map((heard, index) => {
                const at = new Date(Math.floor(now / 3_600_000 - (71 - index)) * 3_600_000);
                return {
                  key: String(index),
                  value: heard ? 1 : 0,
                  color: heard ? "positive" : "track",
                  label: m.dateTime(at.toISOString(), { dateStyle: "medium", timeStyle: "short" }),
                };
              })}
            />
          ) : null}
          <span className="pr-connection__foot">
            <span>
              {connection.lastSeen
                ? m.t(`connection.${connection.state}`, { time: m.relative(connection.lastSeen) })
                : m.t("connection.never")}
            </span>
            {connection.coverage != null ? (
              <span className="pr-mono">
                {m.t("connection.coverage", {
                  percent: m.number(connection.coverage, {
                    style: "percent",
                    maximumFractionDigits: 0,
                  }),
                })}
              </span>
            ) : null}
          </span>
        </div>
      ))}
    </section>
  );
}

/** "production" reads "Production"; an environment the app names itself keeps its name. */
export function environmentName(environment: string): string {
  return environment ? environment.charAt(0).toUpperCase() + environment.slice(1) : environment;
}

/* ── Figures ─────────────────────────────────────────────────────────────── */

function duration(m: Messages, ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1)
    return m.number(Math.max(1, Math.round(ms / 60_000)), { style: "unit", unit: "minute" });
  if (hours < 48) return m.number(Math.round(hours * 10) / 10, { style: "unit", unit: "hour" });
  return m.number(Math.round((hours / 24) * 10) / 10, { style: "unit", unit: "day" });
}

export function SignalsKeyFigures({ figures }: { figures: SignalsFigures }) {
  const m = useSignalsMessages();
  const open = figures.needFix + figures.waitForProof;
  const proving = figures.observing + figures.quiet + figures.waiting;
  const issues = (value: number) => m.plural("figures.issues", value);
  const fixes = (value: number) => m.plural("figures.fixes", value);
  const others = Math.max(0, figures.recordedFixes - figures.cameBack);
  return (
    <MetricGrid label={m.t("figures.label")}>
      <MetricCard
        label={m.t("figures.open")}
        value={m.number(open)}
        empty={open === 0}
        visual={
          <SegmentBar
            size="sm"
            format={issues}
            segments={[
              {
                key: "fix",
                value: figures.needFix,
                color: "danger",
                label: m.t("figures.needFix"),
              },
              {
                key: "wait",
                value: figures.waitForProof,
                color: "info",
                label: m.t("figures.waitForProof"),
              },
            ]}
          />
        }
        detail={
          open
            ? [
                m.t("figures.openLine", {
                  needFix: m.number(figures.needFix),
                  wait: m.number(figures.waitForProof),
                }),
                m.plural("figures.openAreas", figures.areas),
              ]
            : [m.t("figures.openNone"), m.t("figures.openNoneLine")]
        }
      />
      <MetricCard
        label={m.t("figures.cameBack")}
        value={m.number(figures.cameBack)}
        empty={figures.cameBack === 0}
        status={figures.cameBack ? { label: m.t("figures.recurred"), tone: "danger" } : undefined}
        visual={
          <SegmentBar
            size="sm"
            format={fixes}
            segments={[
              {
                key: "back",
                value: figures.cameBack,
                color: "danger",
                label: m.t("figures.cameBack"),
              },
              { key: "rest", value: others, color: "track", label: m.t("figures.otherFixes") },
            ]}
          />
        }
        detail={
          figures.cameBack
            ? [
                m.t("figures.cameBackLine", {
                  count: m.number(figures.cameBack),
                  total: m.number(figures.recordedFixes),
                }),
                figures.cameBackIn
                  ? m.t("figures.cameBackIn", { release: figures.cameBackIn })
                  : m.t("figures.otherFixes"),
              ]
            : [m.t("figures.cameBackNone"), m.t("figures.cameBackNoneLine")]
        }
      />
      <MetricCard
        label={m.t("figures.proving")}
        value={m.number(proving)}
        empty={proving === 0}
        visual={
          <SegmentBar
            size="sm"
            format={fixes}
            segments={[
              {
                key: "observing",
                value: figures.observing,
                color: "info",
                label: m.t("fixState.observing"),
              },
              {
                key: "quiet",
                value: figures.quiet,
                color: "warning",
                label: m.t("fixState.quiet"),
              },
              {
                key: "waiting",
                value: figures.waiting,
                color: "neutral",
                label: m.t("fixState.waiting"),
              },
            ]}
          />
        }
        detail={
          proving
            ? [
                m.t("figures.provingLine", {
                  observing: m.number(figures.observing),
                  quiet: m.number(figures.quiet),
                  waiting: m.number(figures.waiting),
                }),
                figures.next?.release
                  ? figures.next.minutesLeft
                    ? m.t("figures.provingNext", {
                        release: figures.next.release,
                        minutes: m.number(figures.next.minutesLeft),
                      })
                    : m.t("figures.provingSoon", { release: figures.next.release })
                  : m.t("figures.provingWaiting"),
              ]
            : [m.t("figures.provingNone"), m.t("figures.provingNoneLine")]
        }
      />
      <MetricCard
        label={m.t("figures.proven")}
        value={m.number(figures.proven)}
        empty={figures.proven === 0}
        visual={
          <SegmentBar
            size="sm"
            format={fixes}
            segments={[
              {
                key: "proven",
                value: figures.proven,
                color: "positive",
                label: m.t("figures.proven"),
              },
              {
                key: "rest",
                value: Math.max(0, figures.recordedFixes - figures.proven),
                color: "track",
                label: m.t("figures.notProven"),
              },
            ]}
          />
        }
        detail={
          figures.proven
            ? [
                m.t("figures.provenLine"),
                figures.medianProofMs != null
                  ? m.t("figures.provenMedian", { time: duration(m, figures.medianProofMs) })
                  : m.t("figures.provenNoMedian"),
              ]
            : [m.t("figures.provenNone"), m.t("figures.provenNoMedian")]
        }
      />
    </MetricGrid>
  );
}

/* ── The two tables on one grid ──────────────────────────────────────────── */

/** Status, a third fact and a bar with its words: the same widths in both tables. */
const STATUS_WIDTH = "160px";
const THIRD_WIDTH = "152px";
const BAR_WIDTH = "368px";

function Bar({
  share,
  color,
  children,
}: {
  share: number;
  color: ChartColor;
  children: ReactNode;
}) {
  return (
    <span className="pr-rowbar">
      <span className="pr-rowbar__track" aria-hidden>
        <SegmentBar
          size="sm"
          track
          scale={share}
          segments={[{ key: "value", value: share > 0 ? 1 : 0, color }]}
        />
      </span>
      <span className="pr-rowbar__text">{children}</span>
    </span>
  );
}

function IssueCell({ issue, meta }: { issue: SignalIssue; meta: ReactNode }) {
  return (
    <span className="pr-signal-row">
      <span className="pr-signal-row__title">{issueTitle(issue)}</span>
      <span className="pr-signal-row__meta">{meta}</span>
    </span>
  );
}

export interface BrokenByAreaProps {
  areas: readonly AreaGroup[];
  environment: string;
  knowledgeAt?: KnowledgeAt;
  onNavigate?: (href: string) => void;
  onOpen: (issue: SignalIssue) => void;
  onShowAll: () => void;
}

export function BrokenByArea({
  areas,
  environment,
  knowledgeAt,
  onNavigate,
  onOpen,
  onShowAll,
}: BrokenByAreaProps) {
  const m = useSignalsMessages();
  // A summary: the first few issues; the Issues tab holds them all.
  const every = areas.flatMap((area) => area.issues.map((issue) => ({ issue, area })));
  const rows = every.slice(0, SUMMARY_ROWS);
  const most = Math.max(1, ...rows.map((row) => recentCount(row.issue)));
  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: "issue",
      header: m.t("areas.issue"),
      render: ({ issue }) => (
        <IssueCell
          issue={issue}
          meta={issue.flow ? m.t("areas.flow", { flow: issue.flow }) : m.t("areas.noFlow")}
        />
      ),
    },
    {
      key: "status",
      header: m.t("areas.status"),
      width: STATUS_WIDTH,
      render: ({ issue }) => <FixStateLabel state={fixState(issue)} />,
    },
    {
      key: "seen",
      header: m.t("areas.lastSeen"),
      width: THIRD_WIDTH,
      hideOnMobile: true,
      render: ({ issue }) => <RelativeTime iso={issue.lastSeen} className="pr-signal-row__time" />,
    },
    {
      key: "events",
      header: m.t("areas.events"),
      width: BAR_WIDTH,
      render: ({ issue }) => (
        <Bar share={recentCount(issue) / most} color="neutral">
          {issue.release && issue.releaseOccurrences != null
            ? m.t("areas.inRelease", {
                count: m.number(issue.releaseOccurrences),
                release: issue.release,
              })
            : m.plural("areas.eventsUnit", issue.occurrences)}
        </Bar>
      ),
    },
  ];
  return (
    <Card aria-labelledby="signals-areas">
      <CardHeader
        id="signals-areas"
        title={m.t("areas.title")}
        description={m.t("areas.description")}
        actions={
          <button type="button" className="pr-link-button" onClick={onShowAll}>
            {m.t("areas.all")}
          </button>
        }
      />
      {rows.length === 0 ? (
        <EmptyPanel
          icon={Folder}
          title={m.t("areas.noneTitle")}
          description={m.t("areas.noneLine", { environment: environmentName(environment) })}
          ghost={{ columns: ["44%", "120px", "96px", "160px"], rows: 3 }}
        />
      ) : (
        <DataTable
          caption={m.t("areas.caption")}
          columns={columns}
          rows={rows}
          rowKey={({ issue }) => issue.id}
          onRowClick={({ issue }) => onOpen(issue)}
          rowGroup={({ area }) => ({
            key: area.path ?? "",
            heading: (
              <AreaHeading
                area={area}
                knowledge={area.path && knowledgeAt ? knowledgeAt(area.path) : null}
                onNavigate={onNavigate}
              />
            ),
          })}
        />
      )}
      {every.length > rows.length ? (
        <div className="pr-card-foot">
          <button type="button" className="pr-link-button" onClick={onShowAll}>
            {m.plural("areas.allCount", every.length)}
          </button>
        </div>
      ) : null}
    </Card>
  );
}

function AreaHeading({
  area,
  knowledge,
  onNavigate,
}: {
  area: AreaGroup;
  knowledge: KnowledgeAtPath | null;
  onNavigate?: (href: string) => void;
}) {
  const m = useSignalsMessages();
  const text = knowledgeText(m, knowledge);
  const none = knowledge != null && knowledge.memory + knowledge.rule + knowledge.skill === 0;
  return (
    <span className="pr-area">
      <Folder size={13} aria-hidden className="pr-area__icon" />
      <span className="pr-area__path pr-mono">{area.path ?? m.t("areas.unmapped")}</span>
      <span className="pr-area__count">· {m.plural("areas.count", area.issues.length)}</span>
      {text ? (
        knowledge?.href ? (
          <a
            className={cx("pr-area__knowledge", none && "pr-area__knowledge--none")}
            href={knowledge.href}
            aria-label={m.t("areas.openKnowledge", { path: area.path ?? "" })}
            onClick={follow(knowledge.href, onNavigate)}
          >
            <Layers size={12} aria-hidden />
            {text}
          </a>
        ) : (
          <span className={cx("pr-area__knowledge", none && "pr-area__knowledge--none")}>
            <Layers size={12} aria-hidden />
            {text}
          </span>
        )
      ) : null}
    </span>
  );
}

const PROOF_COLOR: Partial<Record<FixState, ChartColor>> = {
  observing: "info",
  quiet: "warning",
  waiting: "neutral",
};

/** What a fix still needs, in words: "18 min, 1 success to go". */
export function proofText(m: Messages, progress: ProofProgress): string {
  if (progress.blocked) return m.t("proving.blocked");
  if (progress.state === "waiting") return m.t("proving.waiting");
  if (progress.state === "quiet") {
    return progress.quietForMs != null
      ? m.t("proving.quietFor", { time: duration(m, progress.quietForMs) })
      : m.t("fixState.quiet");
  }
  const parts = [
    progress.minutesLeft ? m.plural("proving.minutes", progress.minutesLeft) : null,
    progress.envelopesLeft ? m.plural("proving.envelopes", progress.envelopesLeft) : null,
    progress.successesLeft ? m.plural("proving.successes", progress.successesLeft) : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? m.t("proving.toGo", { parts: parts.join(", ") }) : m.t("proving.checking");
}

export interface FixesBeingProvenProps {
  rows: ReadonlyArray<{ issue: SignalIssue; progress: ProofProgress }>;
  policy?: VerificationPolicy;
  onOpen: (issue: SignalIssue) => void;
  onShowAll: () => void;
}

export function FixesBeingProven({ rows: every, onOpen, onShowAll }: FixesBeingProvenProps) {
  const m = useSignalsMessages();
  const rows = every.slice(0, SUMMARY_ROWS);
  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: "fix",
      header: m.t("proving.fix"),
      render: ({ issue }) => (
        <IssueCell
          issue={issue}
          meta={[
            issue.flow ? m.t("areas.flow", { flow: issue.flow }) : null,
            issue.correction
              ? m.t("proving.recorded", { time: m.relative(issue.correction.recordedAt) })
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      ),
    },
    {
      key: "status",
      header: m.t("areas.status"),
      width: STATUS_WIDTH,
      render: ({ progress }) => <FixStateLabel state={progress.state} />,
    },
    {
      key: "release",
      header: m.t("proving.release"),
      width: THIRD_WIDTH,
      hideOnMobile: true,
      render: ({ issue }) => (
        <span className="pr-release-step pr-mono">
          <span>{issue.correction?.baselineRelease ?? "—"}</span>
          <span aria-hidden>→</span>
          <span>{issue.progress?.candidateRelease ?? m.t("proving.nextRelease")}</span>
        </span>
      ),
    },
    {
      key: "left",
      header: m.t("proving.left"),
      width: BAR_WIDTH,
      render: ({ progress }) => (
        <Bar share={progress.share} color={PROOF_COLOR[progress.state] ?? "neutral"}>
          {proofText(m, progress)}
        </Bar>
      ),
    },
  ];
  return (
    <Card aria-labelledby="signals-proving">
      <CardHeader
        id="signals-proving"
        title={m.t("proving.title")}
        description={m.t("proving.description")}
        actions={
          <button type="button" className="pr-link-button" onClick={onShowAll}>
            {m.t("proving.all")}
          </button>
        }
      />
      {rows.length === 0 ? (
        <EmptyPanel
          title={m.t("proving.noneTitle")}
          description={m.t("proving.noneLine")}
          ghost={{ columns: ["44%", "120px", "96px", "160px"], rows: 2 }}
        />
      ) : (
        <DataTable
          caption={m.t("proving.caption")}
          columns={columns}
          rows={rows}
          rowKey={({ issue }) => issue.id}
          onRowClick={({ issue }) => onOpen(issue)}
        />
      )}
      {every.length > rows.length ? (
        <div className="pr-card-foot">
          <button type="button" className="pr-link-button" onClick={onShowAll}>
            {m.plural("proving.allCount", every.length)}
          </button>
        </div>
      ) : null}
    </Card>
  );
}

/* ── Releases ────────────────────────────────────────────────────────────── */

function Count({ value, tone }: { value: number; tone: "danger" | "positive" }) {
  const m = useSignalsMessages();
  return (
    <span className={cx("pr-tabular", value > 0 ? `pr-count--${tone}` : "pr-count--zero")}>
      {m.number(value)}
    </span>
  );
}

export function ReleasesCard({
  rows: every,
  environment,
}: {
  rows: readonly ReleaseRow[];
  environment: string;
}) {
  const m = useSignalsMessages();
  const rows = every.slice(0, SUMMARY_ROWS);
  const most = Math.max(1, ...rows.map((row) => row.envelopes));
  const columns: Column<ReleaseRow>[] = [
    {
      key: "release",
      header: m.t("releases.release"),
      render: (row) => (
        <span className="pr-release-name">
          <span className="pr-mono">{row.release ?? m.t("releases.unnamed")}</span>
          {row.latest ? (
            <Badge size="sm" tone="accent">
              {m.t("releases.live")}
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: "traffic",
      header: m.t("releases.traffic"),
      width: BAR_WIDTH,
      render: (row) => (
        <Bar share={row.envelopes / most} color="neutral">
          {m.plural("releases.envelopes", row.envelopes)}
        </Bar>
      ),
    },
    {
      key: "new",
      header: m.t("releases.newIssues"),
      align: "end",
      width: "112px",
      render: (row) => <Count value={row.newIssues} tone="danger" />,
    },
    {
      key: "proven",
      header: m.t("releases.proven"),
      align: "end",
      width: "112px",
      render: (row) => <Count value={row.proven} tone="positive" />,
    },
    {
      key: "back",
      header: m.t("releases.cameBack"),
      align: "end",
      width: "112px",
      render: (row) => <Count value={row.cameBack} tone="danger" />,
    },
    {
      key: "seen",
      header: m.t("releases.seen"),
      align: "end",
      width: "112px",
      hideOnMobile: true,
      render: (row) => <RelativeTime iso={row.lastSeen} className="pr-signal-row__time" />,
    },
  ];
  return (
    <Card aria-labelledby="signals-releases">
      <CardHeader
        id="signals-releases"
        title={m.t("releases.title")}
        description={m.t("releases.description", { environment: environmentName(environment) })}
      />
      {rows.length === 0 ? (
        <EmptyPanel
          title={m.t("releases.noneTitle")}
          description={m.t("releases.noneLine")}
          ghost={{ columns: ["16%", "160px", "40px", "40px", "40px", "56px"], rows: 3 }}
        />
      ) : (
        <DataTable
          caption={m.t("releases.caption", { environment: environmentName(environment) })}
          columns={columns}
          rows={rows}
          rowKey={(row) => `${row.release ?? ""}:${row.firstSeen}`}
        />
      )}
      {every.length > rows.length ? (
        <p className="pr-card-foot pr-card-foot--note">
          {m.t("releases.latestOf", {
            shown: m.number(rows.length),
            count: m.number(every.length),
          })}
        </p>
      ) : null}
    </Card>
  );
}
