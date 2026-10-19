// SPDX-License-Identifier: Apache-2.0
// The Issues tab: every group in the chosen environment, found by text and narrowed by where its
// fix stands. A row opens the group.
import { SearchX } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../components/button.js";
import { RelativeTime } from "../components/data.js";
import { EmptyPanel } from "../components/lists.js";
import { FilterChip, Pagination } from "../components/navigation.js";
import { SearchInput } from "../components/forms.js";
import { Card } from "../components/surface.js";
import { DataTable, type Column } from "../components/table.js";
import { fixState, recentCount, areaOf, type FixState } from "./insights.js";
import { useSignalsMessages } from "./messages.js";
import { issueTitle, type SignalIssue } from "./model.js";
import { environmentName, FixStateLabel, knowledgeText, type KnowledgeAt } from "./overview.js";

/** The fix states the chips narrow to; "proving" covers waiting, observing and quiet. */
export type IssueChip = "all" | "recurred" | "open" | "proving" | "verified";

export const ISSUE_CHIPS: readonly IssueChip[] = ["all", "recurred", "open", "proving", "verified"];

const PAGE_SIZE = 25;

export function chipOf(state: FixState): IssueChip | null {
  switch (state) {
    case "recurred":
    case "open":
    case "verified":
      return state;
    case "waiting":
    case "observing":
    case "quiet":
      return "proving";
    default:
      return null;
  }
}

/** Matches a group by any of the words in `query`: title, message, path, flow or release. */
export function matchesIssue(issue: SignalIssue, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [
    issueTitle(issue),
    issue.label,
    issue.message,
    issue.resolvedPath,
    issue.declaredPath,
    issue.flow,
    issue.release,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((word) => hay.includes(word));
}

export interface IssueBrowserProps {
  issues: readonly SignalIssue[];
  environment: string;
  knowledgeAt?: KnowledgeAt;
  onOpen: (issue: SignalIssue) => void;
}

export function IssueBrowser({ issues, environment, knowledgeAt, onOpen }: IssueBrowserProps) {
  const m = useSignalsMessages();
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<IssueChip>("all");
  const [page, setPage] = useState(1);
  const counts = useMemo(() => {
    const out: Record<IssueChip, number> = {
      all: issues.length,
      recurred: 0,
      open: 0,
      proving: 0,
      verified: 0,
    };
    for (const issue of issues) {
      const key = chipOf(fixState(issue));
      if (key) out[key] += 1;
    }
    return out;
  }, [issues]);
  const shown = useMemo(
    () =>
      issues.filter(
        (issue) =>
          (chip === "all" || chipOf(fixState(issue)) === chip) && matchesIssue(issue, query),
      ),
    [issues, chip, query],
  );
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const rows = shown.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const columns: Column<SignalIssue>[] = [
    {
      key: "issue",
      header: m.t("issueList.issue"),
      render: (issue) => (
        <span className="pr-signal-row">
          <span className="pr-signal-row__title pr-mono">{issueTitle(issue)}</span>
          <span className="pr-signal-row__meta">
            {issue.flow
              ? m.t("issueList.kindFlow", {
                  kind: m.t(issue.kind === "error" ? "issueList.error" : "issueList.event"),
                  flow: issue.flow,
                })
              : m.t(issue.kind === "error" ? "issueList.error" : "issueList.event")}
          </span>
        </span>
      ),
    },
    {
      key: "where",
      header: m.t("issueList.where"),
      width: "26%",
      hideOnMobile: true,
      render: (issue) => {
        const path = areaOf(issue);
        const knowledge = path && knowledgeAt ? knowledgeAt(path) : null;
        return (
          <span className="pr-signal-row">
            <span className="pr-signal-row__path pr-mono">{path ?? m.t("areas.unmapped")}</span>
            {knowledge ? (
              <span className="pr-signal-row__meta">{knowledgeText(m, knowledge)}</span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "latest",
      header: m.t("issueList.latest"),
      width: "152px",
      align: "end",
      render: (issue) => (
        <span className="pr-signal-row pr-signal-row--end">
          <span className="pr-tabular">
            {issue.release
              ? m.t("areas.inRelease", {
                  count: m.number(recentCount(issue)),
                  release: issue.release,
                })
              : m.number(recentCount(issue))}
          </span>
          <span className="pr-signal-row__meta">
            {m.t("issueList.allTime", { count: m.number(issue.occurrences) })}
          </span>
        </span>
      ),
    },
    {
      key: "fix",
      header: m.t("issueList.fix"),
      width: "168px",
      render: (issue) => <FixStateLabel state={fixState(issue)} />,
    },
    {
      key: "seen",
      header: m.t("issueList.lastSeen"),
      width: "112px",
      hideOnMobile: true,
      render: (issue) => <RelativeTime iso={issue.lastSeen} className="pr-signal-row__time" />,
    },
  ];

  const pick = (next: IssueChip) => {
    setChip(next);
    setPage(1);
  };

  return (
    <div className="pr-stack pr-stack--3">
      <div className="pr-issue-finder">
        <span className="pr-issue-finder__search">
          <SearchInput
            value={query}
            onValueChange={(value) => {
              setQuery(value);
              setPage(1);
            }}
            placeholder={m.t("issueList.findHint")}
            aria-label={m.t("issueList.find")}
          />
        </span>
        <div className="pr-issue-finder__chips" role="group" aria-label={m.t("issueList.chips")}>
          {ISSUE_CHIPS.map((key) => (
            <FilterChip
              key={key}
              selected={chip === key}
              count={m.number(counts[key])}
              onSelectedChange={() => pick(chip === key && key !== "all" ? "all" : key)}
            >
              {key === "all"
                ? m.t("issueList.all")
                : key === "proving"
                  ? m.t("issueList.proving")
                  : m.t(`fixState.${key}`)}
            </FilterChip>
          ))}
        </div>
      </div>
      <Card>
        {shown.length === 0 ? (
          <EmptyPanel
            icon={SearchX}
            title={m.t("empty.noMatch")}
            description={m.t("empty.noMatchDescription")}
            ghost={{ columns: ["40%", "22%", "96px", "120px", "64px"], rows: 3 }}
            actions={
              query || chip !== "all" ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    pick("all");
                  }}
                >
                  {m.t("empty.clear")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <DataTable
            caption={m.t("issueList.caption", { environment: environmentName(environment) })}
            columns={columns}
            rows={rows}
            rowKey={(issue) => issue.id}
            onRowClick={onOpen}
            rowTone={(issue) => (fixState(issue) === "recurred" ? "danger" : undefined)}
          />
        )}
      </Card>
      {shown.length > PAGE_SIZE ? (
        <Pagination
          page={current}
          pageSize={PAGE_SIZE}
          total={shown.length}
          onPageChange={setPage}
          label={m.t("issueList.find")}
        />
      ) : null}
    </div>
  );
}
