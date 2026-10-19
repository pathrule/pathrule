// SPDX-License-Identifier: Apache-2.0
import { Bot, CircleCheck, CircleDot, Clock, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../lib/cx.js";
import { Icon } from "../lib/icon.js";
import { useAsync } from "../lib/use-async.js";
import { Button } from "../components/button.js";
import {
  CopyButton,
  RelativeTime,
  Timeline,
  UntrustedText,
  type TimelineItem,
} from "../components/data.js";
import { Disclosure } from "../components/disclosure.js";
import { FormField, TextInput, Textarea } from "../components/forms.js";
import { Dialog } from "../components/overlay.js";
import { Alert, KeyValueList, StateMessage } from "../components/surface.js";
import { useToast } from "../components/toast.js";
import { LoadError } from "../patterns/states.js";
import { useUiMessages } from "../i18n/ui-messages.js";
import { useSignalsMessages } from "./messages.js";
import {
  agentBrief,
  siblingsAcrossEnvironments,
  type CorrectionInput,
  type CorrectionOutcome,
  type SignalHistoryEntry,
  type SignalIssue,
  type SignalsCapabilities,
} from "./model.js";
import { areaOf } from "./insights.js";
import { knowledgeText, type KnowledgeAt } from "./overview.js";
import {
  FixHolding,
  VerificationBadge,
  isManualResolution,
  verificationRules,
} from "./verification.js";

type Messages = ReturnType<typeof useSignalsMessages>;

/** At most this many characters in a fix note, as the runtime stores it. */
export const FIX_NOTE_MAX = 500;

function newAttemptId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `console-${uuid}`;
  return `console-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** What the runtime recorded about the group, newest first: stored facts and audited changes. */
function historyItems(
  m: Messages,
  issue: SignalIssue,
  history: readonly SignalHistoryEntry[] | null,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const label = (state: SignalHistoryEntry["to"]) => m.t(`verification.label.${state}`);
  items.push({
    id: "last",
    title: m.t("history.lastSeen"),
    detail: issue.release ? m.t("history.inRelease", { release: issue.release }) : undefined,
    at: issue.lastSeen,
    actor: m.t("history.runtime"),
    actorKind: "system",
    tone: issue.verification === "recurred" ? "danger" : "neutral",
  });
  if (history) {
    history.forEach((entry, index) => {
      if (entry.event === "correction") {
        items.push({
          id: `h-${index}`,
          title: m.t("history.fixRecorded"),
          detail: entry.release ? m.t("history.fixAgainst", { release: entry.release }) : undefined,
          at: entry.at,
          actor:
            issue.correction?.attemptId === entry.attemptId
              ? (issue.correction?.actor ?? undefined)
              : undefined,
          actorKind: "agent",
          tone: "info",
        });
      } else {
        items.push({
          id: `h-${index}`,
          title: entry.from
            ? m.t("history.transition", { from: label(entry.from), to: label(entry.to) })
            : m.t("history.transitionTo", { to: label(entry.to) }),
          detail: entry.release
            ? m.t("history.releaseDetail", { release: entry.release })
            : undefined,
          at: entry.at,
          actor: m.t("history.pathrule"),
          actorKind: "system",
          tone: entry.to === "verified" ? "accent" : entry.to === "recurred" ? "danger" : "info",
        });
      }
    });
  } else {
    // No audited history from this source: what the current record states, with its times.
    if (issue.evidence?.updatedAt) {
      items.push({
        id: "verification",
        title: m.t("history.verificationNow", { state: label(issue.verification) }),
        detail: issue.evidence.reason
          ? `${m.t("history.reason", { reason: issue.evidence.reason })}${issue.evidence.release ? ` · ${m.t("history.releaseDetail", { release: issue.evidence.release })}` : ""}`
          : undefined,
        at: issue.evidence.updatedAt,
        actor: m.t("history.pathrule"),
        actorKind: "system",
        tone:
          issue.verification === "verified"
            ? "accent"
            : issue.verification === "recurred"
              ? "danger"
              : "info",
      });
    }
    if (issue.evidence?.startedAt) {
      items.push({
        id: "observe",
        title: m.t("history.watching"),
        detail: issue.evidence.release ?? undefined,
        at: issue.evidence.startedAt,
        actor: m.t("history.pathrule"),
        actorKind: "system",
        tone: "info",
      });
    }
    if (issue.correction) {
      items.push({
        id: "fix",
        title: m.t("history.fixRecorded"),
        detail: issue.correction.baselineRelease
          ? m.t("history.fixAgainst", { release: issue.correction.baselineRelease })
          : undefined,
        at: issue.correction.recordedAt,
        actor: issue.correction.actor ?? undefined,
        actorKind: "agent",
        tone: "info",
      });
    }
  }
  if (issue.releaseFirstSeen && issue.release) {
    items.push({
      id: "release-first",
      title: m.t("history.releaseFirst", { release: issue.release }),
      at: issue.releaseFirstSeen,
      actor: m.t("history.runtime"),
      actorKind: "system",
    });
  }
  if (issue.workflow.handoffAt) {
    items.push({
      id: "handoff",
      title: m.t("history.handoff"),
      detail: m.t("history.handoffDetail"),
      at: issue.workflow.handoffAt,
      actor: m.t("history.policy"),
      actorKind: "system",
    });
  }
  items.push({
    id: "first",
    title: m.t("history.firstSeen"),
    at: issue.firstSeen,
    actor: m.t("history.runtime"),
    actorKind: "system",
  });
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Why a fix cannot be recorded on this group, or null when it can. */
export function fixUnavailableReason(m: Messages, issue: SignalIssue): string | null {
  if (issue.status === "declared") return m.t("fix.notForDeclared");
  if (issue.kind !== "error") return m.t("fix.notForEvents");
  if (issue.status === "resolved" && issue.verification === "verified") {
    return m.t("fix.notForResolved");
  }
  return null;
}

export interface RecordFixDialogProps {
  issue: SignalIssue;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  capabilities: SignalsCapabilities;
  record: (issue: SignalIssue, input: CorrectionInput) => Promise<CorrectionOutcome>;
  /** After any answer that changed or may have changed the group. */
  onSettled: (outcome: CorrectionOutcome) => void;
}

/**
 * A person says a fix shipped. One attempt id per opening, so a retried submit records once.
 * A refusal is explained in place; nothing claims the fix held.
 */
export function RecordFixDialog({
  issue,
  open,
  onOpenChange,
  capabilities,
  record,
  onSettled,
}: RecordFixDialogProps) {
  const m = useSignalsMessages();
  const ui = useUiMessages();
  const toast = useToast();
  const [baseline, setBaseline] = useState(issue.release ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(newAttemptId());

  useEffect(() => {
    if (open) {
      setBaseline(issue.release ?? "");
      setNote("");
      setError(null);
      attempt.current = newAttemptId();
    }
    // A new attempt only when the dialog opens, never on a re-render of the same attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    if (busy || note.length > FIX_NOTE_MAX) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await record(issue, {
        idempotencyKey: attempt.current,
        baselineRelease: baseline.trim() || undefined,
        note: note.trim() || undefined,
      });
      if (outcome.status === "refused") {
        setError(m.t(`fix.refused.${outcome.reason}`));
        if (outcome.reason !== "invalid") onSettled(outcome);
        return;
      }
      toast.show(
        outcome.status === "recorded"
          ? { title: m.t("fix.recorded"), description: m.t("fix.recordedDescription") }
          : { title: m.t("fix.replayed"), tone: "info" },
      );
      onSettled(outcome);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.t("fix.dialogTitle")}
      description={m.t("fix.dialogDescription")}
      icon={Wrench}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {ui.t("overlay.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={
              note.length > FIX_NOTE_MAX
                ? { reason: m.t("fix.noteHelp", { max: FIX_NOTE_MAX }) }
                : false
            }
            onClick={() => void submit()}
          >
            {m.t("fix.submit")}
          </Button>
        </>
      }
    >
      <form
        className="pr-stack pr-stack--4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="pr-note">{verificationRules(m, capabilities.policy)}</p>
        <FormField label={m.t("fix.baselineLabel")} description={m.t("fix.baselineHelp")} optional>
          <TextInput
            value={baseline}
            onChange={(event) => setBaseline(event.target.value)}
            mono
            maxLength={120}
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
        {!baseline.trim() ? (
          <Alert tone="warning" title={m.t("progress.blockedTitle")}>
            {m.t("fix.baselineMissing")}
          </Alert>
        ) : null}
        <FormField
          label={m.t("fix.noteFieldLabel")}
          description={m.t("fix.noteHelp", { max: FIX_NOTE_MAX })}
          error={
            note.length > FIX_NOTE_MAX ? m.t("fix.noteHelp", { max: FIX_NOTE_MAX }) : undefined
          }
          optional
        >
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} />
        </FormField>
        {error ? (
          <Alert tone="danger" title={m.t("fix.dialogTitle")}>
            {error}
          </Alert>
        ) : null}
      </form>
    </Dialog>
  );
}

export interface SignalIssueDetailProps {
  issue: SignalIssue;
  /** All groups, for the environment comparison. */
  all: readonly SignalIssue[];
  workspaceName: string;
  consoleUrl?: string;
  onOpenSibling?: (issue: SignalIssue) => void;
  capabilities?: SignalsCapabilities;
  /** Reads the group's audited history; present when the source keeps it. */
  loadHistory?: (issue: SignalIssue, signal: AbortSignal) => Promise<SignalHistoryEntry[]>;
  /** Records a fix; present when the source can. */
  recordFix?: (issue: SignalIssue, input: CorrectionInput) => Promise<CorrectionOutcome>;
  /** After a fix record changed (or may have changed) the group. */
  onChanged?: () => void;
  /** Steps the console names in the agent brief. */
  agentSteps?: readonly string[];
  /** The knowledge agents get at the group's path. */
  knowledgeAt?: KnowledgeAt;
  onNavigate?: (href: string) => void;
}

/** One group in context. Authoritative lifecycle first, untrusted runtime text clearly fenced. */
export function SignalIssueDetail({
  issue,
  all,
  workspaceName,
  consoleUrl,
  onOpenSibling,
  capabilities,
  loadHistory,
  recordFix,
  onChanged,
  agentSteps,
  knowledgeAt,
  onNavigate,
}: SignalIssueDetailProps) {
  const m = useSignalsMessages();
  const area = areaOf(issue);
  const knowledge = area && knowledgeAt ? knowledgeAt(area) : null;
  // What the hook line shows agents working at this path.
  const activeHere = issue.resolvedPath
    ? all.filter(
        (other) =>
          other.kind === "error" &&
          other.status === "active" &&
          other.environment === issue.environment &&
          other.resolvedPath === issue.resolvedPath,
      ).length
    : 0;
  const siblings = siblingsAcrossEnvironments(issue, all);
  const [briefShown, setBriefShown] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const brief = useMemo(
    () => agentBrief(issue, { workspace: workspaceName, consoleUrl, nextSteps: agentSteps }),
    [issue, workspaceName, consoleUrl, agentSteps],
  );
  const history = useAsync(
    (signal) => (loadHistory ? loadHistory(issue, signal) : Promise.resolve(null)),
    [loadHistory, issue.id, issue.revision, issue.lastSeen],
  );
  const timeline = historyItems(
    m,
    issue,
    history.state.status === "success" ? history.state.data : null,
  );
  const fixBlocked = fixUnavailableReason(m, issue);
  const workflowShown = capabilities?.workflow ?? true;

  const where =
    issue.resolvedPath ??
    (issue.mapping === "unmapped"
      ? m.t("detail.facts.unmapped")
      : issue.mapping === "invalid"
        ? m.t("detail.facts.invalid")
        : m.t("detail.facts.none"));

  // Most important first: where it stands, how often, when and where, and what to do; then what the
  // application sent, the fix and its verification; technical facts last and folded.
  return (
    <div className="pr-stack pr-stack--5">
      <section className="pr-issue-lead" aria-label={m.t("detail.summary")}>
        <p className="pr-issue-lead__state">
          {isManualResolution(issue)
            ? m.t("status.meaning.resolvedManual")
            : m.t(`status.meaning.${issue.status}`)}{" "}
          {m.t(`verification.meaning.${issue.verification}`)}
        </p>
        <dl className="pr-issue-stats">
          <div className="pr-issue-stat">
            <dt>{m.t("detail.stats.events")}</dt>
            <dd className="pr-issue-stat__value pr-tabular">{m.number(issue.occurrences)}</dd>
            <dd className="pr-issue-stat__detail">
              {issue.releaseOccurrences != null
                ? m.t("detail.stats.inRelease", { count: m.number(issue.releaseOccurrences) })
                : m.t("detail.facts.notRecorded")}
            </dd>
          </div>
          <div className="pr-issue-stat">
            <dt>{m.t("detail.stats.lastSeen")}</dt>
            <dd className="pr-issue-stat__value">
              <RelativeTime iso={issue.lastSeen} />
            </dd>
            <dd className="pr-issue-stat__detail">
              {m.t("detail.stats.firstSeen", { time: m.relative(issue.firstSeen) })}
            </dd>
          </div>
          <div className="pr-issue-stat">
            <dt>{m.t("detail.stats.where")}</dt>
            <dd
              className={cx(
                "pr-issue-stat__value",
                issue.resolvedPath && "pr-issue-stat__value--path",
              )}
              title={issue.resolvedPath ?? undefined}
            >
              {where}
            </dd>
            <dd className="pr-issue-stat__detail">
              {issue.flow
                ? m.t("detail.stats.inFlow", { flow: issue.flow, environment: issue.environment })
                : issue.environment}
            </dd>
          </div>
        </dl>
      </section>

      <section className="pr-verify-panel" aria-labelledby={`verify-${issue.id}`}>
        <div className="pr-verify-panel__head">
          <h3 id={`verify-${issue.id}`} className="pr-drawer-section__title">
            {m.t("detail.verification")}
          </h3>
          <VerificationBadge state={issue.verification} />
        </div>
        {!issue.coverage.tracked ? (
          <p className="pr-verify-panel__untracked">
            <Icon icon={CircleDot} size="xs" />{" "}
            {m.t("detail.notTracked", { reason: issue.coverage.reason })}
          </p>
        ) : null}
        <FixHolding issue={issue} policy={capabilities?.policy} />
        {issue.progress && issue.coverage.tracked ? (
          <p className="pr-note">{verificationRules(m, capabilities?.policy)}</p>
        ) : null}
        {!issue.progress && issue.evidence && Object.keys(issue.evidence.details).length ? (
          <KeyValueList
            items={Object.entries(issue.evidence.details).map(([key, value]) => ({
              key,
              value,
              mono: true,
            }))}
          />
        ) : null}
      </section>

      <section aria-labelledby={`history-${issue.id}`} className="pr-stack pr-stack--2">
        <h3 id={`history-${issue.id}`} className="pr-drawer-section__title">
          {m.t("detail.history")}
        </h3>
        {history.state.status === "error" ? (
          <LoadError
            compact
            title={m.t("detail.historyError")}
            error={history.state.error}
            onRetry={history.reload}
          />
        ) : null}
        <Timeline items={timeline} />
        <p className="pr-note">{m.t("detail.historyNote")}</p>
      </section>

      {area ? (
        <section aria-labelledby={`where-${issue.id}`} className="pr-stack pr-stack--2">
          <div className="pr-verify-panel__head">
            <h3 id={`where-${issue.id}`} className="pr-drawer-section__title">
              {m.t("detail.where")}
            </h3>
            {knowledge?.href ? (
              <a
                className="pr-link-button"
                href={knowledge.href}
                onClick={(event) => {
                  if (
                    !onNavigate ||
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  onNavigate(knowledge.href!);
                }}
              >
                {m.t("detail.openKnowledge")}
              </a>
            ) : null}
          </div>
          <p className="pr-where">
            <span className="pr-mono">{area}</span>
            {issue.flow ? (
              <span className="pr-meta"> · {m.t("areas.flow", { flow: issue.flow })}</span>
            ) : null}
          </p>
          {knowledge ? (
            knowledge.memory + knowledge.rule + knowledge.skill > 0 ? (
              <p className="pr-note">
                {m.t("detail.knowledgeHere")}: {knowledgeText(m, knowledge)}
              </p>
            ) : (
              <p className="pr-note pr-note--warning">{m.t("detail.noKnowledgeHere")}</p>
            )
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby={`handoff-${issue.id}`} className="pr-handoff">
        <h3 id={`handoff-${issue.id}`} className="pr-drawer-section__title">
          {m.t("detail.agent")}
        </h3>
        {issue.resolvedPath && activeHere > 0 ? (
          <p className="pr-note">
            {m.plural("detail.agentSees", activeHere, { path: issue.resolvedPath })}
          </p>
        ) : null}
        <div className="pr-handoff__actions">
          <CopyButton
            value={brief}
            label={m.t("detail.copyBrief")}
            text={m.t("detail.copyBrief")}
            emphasis="primary"
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setBriefShown((v) => !v)}
            aria-expanded={briefShown}
          >
            {briefShown ? m.t("detail.hideBrief") : m.t("detail.previewBrief")}
          </Button>
        </div>
        <p className="pr-note">{m.t("detail.agentNote")}</p>
        {briefShown ? <pre className="pr-handoff__preview">{brief}</pre> : null}
      </section>

      {issue.message ||
      issue.stack ||
      issue.compacted ||
      (issue.metadata && Object.keys(issue.metadata).length) ? (
        <section aria-labelledby={`sent-${issue.id}`} className="pr-stack pr-stack--2">
          <h3 id={`sent-${issue.id}`} className="pr-drawer-section__title">
            {m.t("detail.sent")}
          </h3>
          {issue.message ? (
            <UntrustedText
              label={m.t("detail.messageLabel")}
              text={issue.message}
              source={issue.environment}
            />
          ) : null}
          {issue.stack ? (
            <Disclosure summary={m.t("detail.showStack")}>
              <UntrustedText
                label={m.t("detail.stackLabel")}
                text={issue.stack}
                source={m.t("detail.stackSource")}
              />
            </Disclosure>
          ) : null}
          {issue.metadata && Object.keys(issue.metadata).length ? (
            <Disclosure summary={m.t("detail.showMetadata")}>
              <UntrustedText
                label={m.t("detail.metadataLabel")}
                text={Object.entries(issue.metadata)
                  .map(([key, value]) => `${key}: ${String(value)}`)
                  .join("\n")}
                source={issue.environment}
              />
            </Disclosure>
          ) : null}
          {issue.compacted ? (
            <StateMessage
              compact
              icon={Clock}
              title={m.t("detail.compactedTitle")}
              description={m.t("detail.compactedDescription")}
            />
          ) : null}
        </section>
      ) : null}

      {capabilities?.corrections || issue.correction ? (
        <section aria-labelledby={`fix-${issue.id}`} className="pr-stack pr-stack--3">
          <h3 id={`fix-${issue.id}`} className="pr-drawer-section__title">
            {m.t("fix.heading")}
          </h3>
          {issue.correction ? (
            <>
              <KeyValueList
                columns={2}
                items={[
                  {
                    key: m.t("fix.recordedAt"),
                    value: <RelativeTime iso={issue.correction.recordedAt} />,
                  },
                  {
                    key: m.t("fix.baseline"),
                    value: issue.correction.baselineRelease ?? m.t("fix.unknownRelease"),
                    mono: Boolean(issue.correction.baselineRelease),
                  },
                  ...(issue.correction.actor
                    ? [{ key: m.t("fix.by"), value: issue.correction.actor }]
                    : []),
                  { key: m.t("fix.attempt"), value: issue.correction.attemptId, mono: true },
                  ...(issue.correction.knowledgeRefs.length
                    ? [
                        {
                          key: m.t("fix.knowledge"),
                          value: issue.correction.knowledgeRefs.join(", "),
                          mono: true,
                        },
                      ]
                    : []),
                ]}
              />
              {issue.correction.note ? (
                <UntrustedText
                  label={m.t("fix.noteLabel")}
                  text={issue.correction.note}
                  source={m.t("fix.noteSource")}
                />
              ) : null}
            </>
          ) : (
            <p className="pr-note">{m.t("fix.none")}</p>
          )}
          {capabilities?.corrections && recordFix ? (
            <div className="pr-stack pr-stack--2">
              {fixBlocked ? <p className="pr-note">{fixBlocked}</p> : null}
              <div>
                <Button
                  size="sm"
                  leadingIcon={Wrench}
                  disabled={fixBlocked ? { reason: fixBlocked } : false}
                  onClick={() => setFixOpen(true)}
                >
                  {issue.correction ? m.t("fix.recordAgain") : m.t("fix.record")}
                </Button>
              </div>
              <RecordFixDialog
                issue={issue}
                open={fixOpen}
                onOpenChange={setFixOpen}
                capabilities={capabilities}
                record={recordFix}
                onSettled={() => {
                  onChanged?.();
                  history.reload();
                }}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      <Disclosure summary={m.t("detail.technical")}>
        <KeyValueList
          columns={2}
          items={[
            { key: m.t("detail.facts.environment"), value: issue.environment, mono: true },
            {
              key: m.t("detail.facts.release"),
              value: issue.release ?? m.t("instrumentation.releaseUnknown"),
              mono: true,
            },
            { key: m.t("detail.facts.events"), value: m.number(issue.occurrences) },
            {
              key: m.t("detail.facts.inRelease"),
              value:
                issue.releaseOccurrences != null
                  ? m.number(issue.releaseOccurrences)
                  : m.t("detail.facts.notRecorded"),
            },
            { key: m.t("detail.facts.firstSeen"), value: <RelativeTime iso={issue.firstSeen} /> },
            { key: m.t("detail.facts.lastSeen"), value: <RelativeTime iso={issue.lastSeen} /> },
            {
              key: m.t("detail.facts.flow"),
              value: issue.flow ?? m.t("detail.facts.none"),
              mono: true,
            },
            { key: m.t("detail.facts.node"), value: where, mono: Boolean(issue.resolvedPath) },
            {
              key: m.t("detail.facts.fingerprint"),
              value: issue.fingerprint,
              mono: true,
              copy: issue.fingerprint,
            },
          ]}
          renderCopy={(item) =>
            item.copy ? (
              <CopyButton value={item.copy} label={m.t("detail.facts.copy", { key: item.key })} />
            ) : null
          }
        />
      </Disclosure>

      {siblings.length > 1 ? (
        <section aria-labelledby={`envs-${issue.id}`} className="pr-stack pr-stack--2">
          <h3 id={`envs-${issue.id}`} className="pr-section-label">
            {m.t("detail.compare")}
          </h3>
          <ul className="pr-env-compare">
            {siblings.map(({ environment, issue: other }) => (
              <li
                key={other.id}
                className={cx(
                  "pr-env-compare__row",
                  other.id === issue.id && "pr-env-compare__row--current",
                )}
              >
                <span className="pr-mono">{environment}</span>
                <span className="pr-mono pr-meta">
                  {other.release ?? m.t("instrumentation.releaseUnknown")}
                </span>
                <span className="pr-tabular">{m.number(other.occurrences)}</span>
                <VerificationBadge state={other.verification} size="sm" />
                {other.id !== issue.id && onOpenSibling ? (
                  <Button size="sm" variant="ghost" onClick={() => onOpenSibling(other)}>
                    {m.t("detail.open")}
                  </Button>
                ) : (
                  <span className="pr-meta">{m.t("detail.thisGroup")}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="pr-note">{m.t("detail.compareNote")}</p>
        </section>
      ) : null}

      {workflowShown ? (
        <section aria-labelledby={`workflow-${issue.id}`} className="pr-workflow">
          <h3 id={`workflow-${issue.id}`} className="pr-section-label">
            {m.t("detail.workflow")}
          </h3>
          <ul className="pr-workflow__list">
            <li>
              <Icon icon={Bot} size="xs" />{" "}
              {issue.workflow.handoff ? (
                <>
                  {m.t("detail.handoff")}
                  {issue.workflow.handoffAt ? (
                    <>
                      {" "}
                      (<RelativeTime iso={issue.workflow.handoffAt} />)
                    </>
                  ) : null}
                </>
              ) : (
                m.t("detail.noHandoff")
              )}
            </li>
            <li>
              <Icon icon={CircleCheck} size="xs" />{" "}
              {issue.workflow.manualResolution ? m.t("detail.manual") : m.t("detail.notManual")}
            </li>
          </ul>
        </section>
      ) : null}
    </div>
  );
}
