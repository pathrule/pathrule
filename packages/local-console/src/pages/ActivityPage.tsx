// SPDX-License-Identifier: Apache-2.0
// What agents did in a workspace: entries grouped into work sessions by day, where the work landed
// and whether knowledge was there for it, the kind of work and the agents. Agents write these
// entries themselves; the page claims nothing more.
import type { ActivityWindow, LocalActivityEntry } from "@pathrule/protocol/local-ui-api.js";
import {
  AsyncView,
  Banner,
  Button,
  Card,
  EmptyPanel,
  FilterChip,
  MetricCard,
  MetricGrid,
  Page,
  PageHeader,
  SearchInput,
  SegmentedControl,
  Select,
  Sparkbars,
} from "@pathrule/ui";
import { History, SearchX, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import {
  AgentsCard,
  MixCard,
  SessionCard,
  WhereCard,
  clientLabel,
  domainLabel,
  durationText,
} from "../activity/ActivityParts.js";
import "../activity/activity.css";
import {
  agentsOf,
  domainMix,
  foldersTouched,
  matchesEntry,
  perDay,
  personKey,
  sessionsByDay,
  workSessions,
  type ActivityFilter,
  type WorkSession,
} from "../activity/model.js";
import { SessionDrawer } from "../activity/SessionDrawer.js";
import { useConsole } from "../app/context.js";
import { useLocal } from "../app/use-local.js";
import { useConsoleMessages } from "../messages.js";
import { useActiveKnowledge } from "../signals/knowledge-at.js";

const WINDOWS: readonly ActivityWindow[] = [7, 30, 90];
const SESSIONS_STEP = 20;
const NO_FILTER: ActivityFilter = { query: "", domain: null, person: null, client: null };

export function ActivityPage() {
  const m = useConsoleMessages();
  const { api, workspace } = useConsole();
  const workspaceId = workspace!.id;
  const [days, setDays] = useState<ActivityWindow>(7);
  const [filter, setFilter] = useState<ActivityFilter>(NO_FILTER);
  const [shown, setShown] = useState(SESSIONS_STEP);
  const [openId, setOpenId] = useState<string | null>(null);
  const activity = useLocal("activity.recent", { workspaceId, days, limit: 1000 });
  const knowledge = useActiveKnowledge(api, workspaceId);
  const [now] = useState(() => Date.now());

  return (
    <Page>
      <div className="pr-stack pr-stack--5">
        <PageHeader
          title={m.t("activity.title")}
          description={m.t("activity.description")}
          actions={
            <SegmentedControl
              label={m.t("activity.range")}
              size="sm"
              value={String(days) as "7" | "30" | "90"}
              onValueChange={(value) => {
                setDays(Number(value) as ActivityWindow);
                setShown(SESSIONS_STEP);
              }}
              options={WINDOWS.map((window) => ({
                value: String(window) as "7" | "30" | "90",
                label: m.t(`activity.days.d${window}`),
              }))}
            />
          }
        />
        <AsyncView resource={activity} errorTitle={m.t("activity.error")}>
          {(data) => (
            <ActivityBody
              entries={data.entries}
              truncated={data.truncated === true}
              days={days}
              now={now}
              knowledge={knowledge}
              filter={filter}
              onFilter={(next) => {
                setFilter(next);
                setShown(SESSIONS_STEP);
              }}
              shown={shown}
              onMore={() => setShown((count) => count + SESSIONS_STEP)}
              openId={openId}
              onOpen={setOpenId}
            />
          )}
        </AsyncView>
      </div>
    </Page>
  );
}

function ActivityBody({
  entries,
  truncated,
  days,
  now,
  knowledge,
  filter,
  onFilter,
  shown,
  onMore,
  openId,
  onOpen,
}: {
  entries: LocalActivityEntry[];
  truncated: boolean;
  days: ActivityWindow;
  now: number;
  knowledge: ReturnType<typeof useActiveKnowledge>;
  filter: ActivityFilter;
  onFilter: (filter: ActivityFilter) => void;
  shown: number;
  onMore: () => void;
  openId: string | null;
  onOpen: (id: string | null) => void;
}) {
  const m = useConsoleMessages();
  const sessions = useMemo(() => workSessions(entries), [entries]);
  const folders = useMemo(
    () => foldersTouched(sessions, knowledge, now),
    [sessions, knowledge, now],
  );
  const uncoveredFolders = useMemo(
    () =>
      new Set(
        folders
          .filter((row) => row.folder !== "/" && row.knowledge.state === "none")
          .map((row) => row.folder),
      ),
    [folders],
  );
  const visible = useMemo(
    () => workSessions(entries.filter((entry) => matchesEntry(entry, filter))),
    [entries, filter],
  );
  const byDay = useMemo(() => sessionsByDay(visible.slice(0, shown)), [visible, shown]);
  const mix = useMemo(() => domainMix(entries), [entries]);
  const agents = useMemo(() => agentsOf(entries), [entries]);
  const people = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of entries)
      map.set(personKey(entry), entry.person?.name ?? m.t("activity.you"));
    return [...map.entries()];
  }, [entries, m]);
  const domainCounts = useMemo(() => domainMix(entries), [entries]);
  const open = sessions.find((session) => session.id === openId) ?? null;

  if (entries.length === 0) {
    return (
      <Card>
        <EmptyPanel
          icon={History}
          title={m.t("activity.none")}
          description={m.t("activity.noneDescription")}
          ghost={{ columns: ["18%", "52%", "64px"], rows: 4 }}
        />
      </Card>
    );
  }

  const uncoveredOf = (session: WorkSession) =>
    session.folders.find((folder) => uncoveredFolders.has(folder)) ?? null;
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
  const dayLabel = (day: string) =>
    day === today
      ? m.t("activity.today")
      : day === yesterday
        ? m.t("activity.yesterday")
        : m.dateTime(`${day}T12:00:00Z`, { weekday: "long", month: "short", day: "numeric" });

  return (
    <>
      {truncated ? (
        <Banner tone="info">
          {m.t("activity.truncated", { count: m.number(entries.length) })}
        </Banner>
      ) : null}
      <ActivityFigures
        entries={entries}
        sessions={sessions}
        folders={folders}
        uncovered={uncoveredFolders}
        knowledgeKnown={knowledge != null}
        days={days}
        now={now}
      />
      <div className="lc-ac-filters" role="group" aria-label={m.t("activity.filters")}>
        <span className="lc-ac-filters__search">
          <SearchInput
            value={filter.query}
            onValueChange={(query) => onFilter({ ...filter, query })}
            placeholder={m.t("activity.findHint")}
            aria-label={m.t("activity.find")}
          />
        </span>
        <span className="lc-ac-filters__chips">
          <FilterChip
            selected={filter.domain === null}
            count={m.number(entries.length)}
            onSelectedChange={() => onFilter({ ...filter, domain: null })}
          >
            {m.t("activity.allDomains")}
          </FilterChip>
          {domainCounts.map((part) => (
            <FilterChip
              key={part.domain}
              selected={filter.domain === part.domain}
              count={m.number(part.count)}
              onSelectedChange={(on) => onFilter({ ...filter, domain: on ? part.domain : null })}
            >
              {domainLabel(m, part.domain)}
            </FilterChip>
          ))}
        </span>
        {people.length > 1 ? (
          <Select
            size="sm"
            aria-label={m.t("activity.who")}
            value={filter.person ?? ""}
            onChange={(event) => onFilter({ ...filter, person: event.target.value || null })}
            options={[
              { value: "", label: m.t("activity.everyone") },
              ...people.map(([id, name]) => ({ value: id, label: name })),
            ]}
          />
        ) : null}
        {agents.length > 1 ? (
          <Select
            size="sm"
            aria-label={m.t("activity.agent")}
            value={filter.client ?? ""}
            onChange={(event) => onFilter({ ...filter, client: event.target.value || null })}
            options={[
              { value: "", label: m.t("activity.allAgents") },
              ...agents.map((agent) => ({
                value: agent.client,
                label: clientLabel(m, agent.client),
              })),
            ]}
          />
        ) : null}
      </div>
      <div className="lc-ac-layout">
        <div className="lc-ac-days">
          {visible.length === 0 ? (
            <Card>
              <EmptyPanel
                icon={SearchX}
                title={m.t("activity.noMatch")}
                description={m.t("activity.noMatchLine")}
                ghost={{ columns: ["18%", "52%", "64px"], rows: 3 }}
                actions={
                  <Button size="sm" onClick={() => onFilter(NO_FILTER)}>
                    {m.t("activity.clear")}
                  </Button>
                }
              />
            </Card>
          ) : (
            byDay.map(({ day, sessions: list }) => (
              <section key={day} className="lc-ac-day" aria-label={dayLabel(day)}>
                <h2 className="lc-ac-day__title">
                  <span>{dayLabel(day)}</span>
                  <span className="lc-ac-day__summary">
                    {m.t("activity.daySummary", {
                      sessions: m.plural("activity.sessionsCount", list.length),
                      entries: m.plural(
                        "activity.entries",
                        list.reduce((sum, session) => sum + session.entries.length, 0),
                      ),
                    })}
                  </span>
                </h2>
                {list.map((session) => (
                  <SessionCard
                    key={session.id}
                    session={session}
                    uncovered={uncoveredOf(session)}
                    href="#"
                    onOpen={() => onOpen(session.id)}
                  />
                ))}
              </section>
            ))
          )}
          {visible.length > shown ? (
            <Button size="sm" variant="secondary" onClick={onMore}>
              {m.t("knowledge.showMore", {
                count: m.number(Math.min(SESSIONS_STEP, visible.length - shown)),
                group: m.t("activity.title").toLowerCase(),
              })}
            </Button>
          ) : null}
        </div>
        <aside className="lc-ac-side">
          <WhereCard rows={folders} />
          <MixCard parts={mix} />
          <AgentsCard rows={agents} />
        </aside>
      </div>
      <SessionDrawer
        session={open}
        knowledge={knowledge}
        uncovered={open ? open.folders.filter((folder) => uncoveredFolders.has(folder)) : []}
        onClose={() => onOpen(null)}
      />
    </>
  );
}

function ActivityFigures({
  entries,
  sessions,
  folders,
  uncovered,
  knowledgeKnown,
  days,
  now,
}: {
  entries: readonly LocalActivityEntry[];
  sessions: readonly WorkSession[];
  folders: ReturnType<typeof foldersTouched>;
  uncovered: ReadonlySet<string>;
  knowledgeKnown: boolean;
  days: ActivityWindow;
  now: number;
}) {
  const m = useConsoleMessages();
  const dayOf = (iso: string) => iso.slice(0, 10);
  const label = (day: string) => m.dateTime(`${day}T12:00:00Z`, { month: "short", day: "numeric" });
  const shownDays = Math.min(days, 30);
  const entriesPerDay = perDay(
    shownDays,
    now,
    (day) => entries.filter((entry) => dayOf(entry.createdAt) === day).length,
  );
  const sessionsPerDay = perDay(
    shownDays,
    now,
    (day) => sessions.filter((session) => dayOf(session.end) === day).length,
  );
  const uncoveredPerDay = perDay(
    shownDays,
    now,
    (day) =>
      sessions.filter(
        (session) =>
          dayOf(session.end) === day && session.folders.some((folder) => uncovered.has(folder)),
      ).length,
  );
  const meanMs = sessions.length
    ? sessions.reduce(
        (sum, session) => sum + (Date.parse(session.end) - Date.parse(session.start)),
        0,
      ) / sessions.length
    : 0;
  const top = folders[0];
  const older = folders.filter((row) => row.knowledge.state === "older").length;
  const sessionsUnit = (value: number) => m.plural("activity.sessionsCount", value);
  return (
    <MetricGrid label={m.t("activity.kpi.label")}>
      <MetricCard
        label={m.t("activity.kpi.logged")}
        value={m.number(entries.length)}
        visual={
          <Sparkbars
            format={(value) => m.plural("activity.entries", value)}
            bars={entriesPerDay.map(({ day, value }) => ({
              key: day,
              value,
              color: "neutral",
              label: label(day),
            }))}
          />
        }
        detail={[
          m.t("activity.kpi.loggedLine", {
            count: m.number(entries.length / days, { maximumFractionDigits: 1 }),
          }),
          m.t("activity.kpi.loggedLine2"),
        ]}
      />
      <MetricCard
        label={m.t("activity.kpi.sessions")}
        value={m.number(sessions.length)}
        visual={
          <Sparkbars
            format={sessionsUnit}
            bars={sessionsPerDay.map(({ day, value }) => ({
              key: day,
              value,
              color: "neutral",
              label: label(day),
            }))}
          />
        }
        detail={[
          m.t("activity.kpi.sessionsLine", { duration: durationText(meanMs) }),
          m.t("activity.kpi.sessionsLine2", {
            count: m.number(sessions.length ? entries.length / sessions.length : 0, {
              maximumFractionDigits: 1,
            }),
          }),
        ]}
      />
      <MetricCard
        label={m.t("activity.kpi.folders")}
        value={m.number(folders.length)}
        visual={
          <Sparkbars
            format={sessionsUnit}
            bars={folders.slice(0, 10).map((row) => ({
              key: row.folder,
              value: row.sessions,
              color: "neutral",
              label: row.folder,
            }))}
          />
        }
        detail={
          top
            ? [
                m.t("activity.kpi.foldersLine", { folder: top.folder }),
                m.t("activity.kpi.foldersLine2", {
                  count: m.number(top.sessions),
                  total: m.number(sessions.length),
                }),
              ]
            : [m.t("activity.kpi.noneLine"), m.t("activity.kpi.noneLine2")]
        }
      />
      <MetricCard
        label={m.t("activity.kpi.uncovered")}
        value={knowledgeKnown ? m.number(uncovered.size) : "…"}
        empty={knowledgeKnown && uncovered.size === 0}
        status={
          uncovered.size
            ? { label: m.t("activity.kpi.review"), tone: "warning", icon: TriangleAlert }
            : undefined
        }
        visual={
          <Sparkbars
            format={sessionsUnit}
            bars={uncoveredPerDay.map(({ day, value }) => ({
              key: day,
              value,
              color: value ? "warning" : "track",
              label: label(day),
              note: value ? m.t("activity.kpi.uncoveredNote") : m.t("activity.kpi.coveredNote"),
            }))}
          />
        }
        detail={
          uncovered.size
            ? [
                m.t("activity.kpi.uncoveredLine"),
                older
                  ? m.plural("activity.kpi.uncoveredOlder", older)
                  : m.t("activity.kpi.uncoveredAllCurrent"),
              ]
            : [m.t("activity.kpi.uncoveredNone"), m.t("activity.kpi.uncoveredNoneLine")]
        }
      />
    </MetricGrid>
  );
}
