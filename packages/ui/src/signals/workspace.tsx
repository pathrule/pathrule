// SPDX-License-Identifier: Apache-2.0
// The Signals page: what broke in an application, where in the code, and whether the fix held.
// Three views: Overview (figures, what needs a fix by area, fixes being proven, releases), Issues
// (every group, found and narrowed) and Setup (readiness, usage, keys, sending, retention).
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Button } from "../components/button.js";
import { SegmentedControl, TabPanel, Tabs } from "../components/navigation.js";
import { ConfirmDialog, Drawer } from "../components/overlay.js";
import { Banner, StateMessage } from "../components/surface.js";
import { useToast } from "../components/toast.js";
import { PageHeader } from "../layouts/app-shell.js";
import { useAsync } from "../lib/use-async.js";
import { AsyncView, CapabilityUnavailable, LoadError } from "../patterns/states.js";
import { Activity } from "lucide-react";
import { SignalIssueDetail } from "./detail.js";
import {
  brokenByArea,
  connections as connectionsOf,
  environmentsOf,
  fixesBeingProven,
  liveGroups,
  readiness,
  releaseRows as releaseRowsOf,
  signalsFigures,
} from "./insights.js";
import { IssueBrowser } from "./issues.js";
import { useSignalsMessages } from "./messages.js";
import {
  compareIssues,
  isDeclared,
  issueTitle,
  type CorrectionInput,
  type CorrectionOutcome,
  type CreatedIngestKey,
  type EnvironmentCoverage,
  type IngestKeySummary,
  type ReleaseCoverage,
  type SignalHistoryEntry,
  type SignalIssue,
  type SignalsCapabilities,
  type SignalsUsage,
} from "./model.js";
import {
  BrokenByArea,
  ConnectionStrip,
  environmentName,
  FixesBeingProven,
  ReleasesCard,
  SignalsKeyFigures,
  type KnowledgeAt,
} from "./overview.js";
import {
  CreateKeyDialog,
  IngestKeysPanel,
  KeptCard,
  openChecks,
  ReadinessCard,
  UsageCard,
} from "./setup.js";
import { StatusBadge } from "./verification.js";

/** Groups a source returned, and whether it returned all it has. */
export interface SignalIssueList {
  issues: SignalIssue[];
  truncated: boolean;
}

/**
 * Where the Signals Workspace reads from. Each console provides one: the Local Console's
 * reads the local runtime through its loopback API; Pathrule Cloud's reads the managed
 * backend under the signed-in person's authorization. Optional methods mean the capability
 * does not exist for this source, and the UI does not offer it.
 */
export interface SignalsSource {
  capabilities: SignalsCapabilities;
  /** Every group, declared points included (shown under Instrumentation). */
  listIssues(signal: AbortSignal): Promise<SignalIssue[] | SignalIssueList>;
  listCoverage?(signal: AbortSignal): Promise<EnvironmentCoverage[]>;
  listReleases?(signal: AbortSignal): Promise<ReleaseCoverage[]>;
  listKeys?(signal: AbortSignal): Promise<IngestKeySummary[]>;
  revokeKey?(key: IngestKeySummary): Promise<void>;
  /** Creates an ingest key for this workspace; the secret is returned once. */
  createKey?(label: string): Promise<CreatedIngestKey>;
  /** The organization's usage this month. */
  getUsage?(signal: AbortSignal): Promise<SignalsUsage>;
  /** One group's audited history, newest first. */
  getHistory?(issue: SignalIssue, signal: AbortSignal): Promise<SignalHistoryEntry[]>;
  /** Records a fix: compare-and-set on the group's revision, once per idempotency key. */
  recordCorrection?(issue: SignalIssue, input: CorrectionInput): Promise<CorrectionOutcome>;
}

export type SignalsView = "overview" | "issues" | "setup";

export const SIGNALS_VIEWS: readonly SignalsView[] = ["overview", "issues", "setup"];

/** A view a link names, older names included: Instrumentation became Setup; Verification and Activity live in the overview. */
export function signalsView(value: string | null | undefined): SignalsView {
  if (value === "issues" || value === "setup") return value;
  if (value === "instrumentation") return "setup";
  return "overview";
}

export interface SignalsWorkspaceProps {
  source: SignalsSource;
  workspaceName: string;
  /** Link back to a group, included in its agent brief. */
  consoleUrl?: string | ((issue: SignalIssue) => string | undefined);
  /** Cloud-only additions (team settings), rendered under Setup. */
  managedPanels?: ReactNode;
  /** When the person may not manage keys, the reason shown on the key panel. */
  keysReadOnlyReason?: string;
  /** How to connect an application to this source, shown under Setup. */
  setup?: ReactNode;
  /** The knowledge agents get at a path, for the areas of the code issues happen in. */
  knowledgeAt?: KnowledgeAt;
  /** SPA navigation for the links to knowledge; modified clicks still follow them. */
  onNavigate?: (href: string) => void;
  /** Steps the console can name in the agent brief (the tools that read or record a group). */
  agentSteps?: (issue: SignalIssue) => readonly string[];
  /** The view, when the console keeps it (in the URL). Uncontrolled otherwise. */
  view?: SignalsView;
  onViewChange?: (view: SignalsView) => void;
  /** The open group, when the console keeps it (in the URL). Uncontrolled otherwise. */
  openIssueId?: string | null;
  onOpenIssueChange?: (id: string | null) => void;
}

function normalizeList(result: SignalIssue[] | SignalIssueList): SignalIssueList {
  return Array.isArray(result) ? { issues: result, truncated: false } : result;
}

export function SignalsWorkspace({
  source,
  workspaceName,
  consoleUrl,
  managedPanels,
  keysReadOnlyReason,
  setup,
  agentSteps,
  knowledgeAt,
  onNavigate,
  view: controlledView,
  onViewChange,
  openIssueId: controlledOpen,
  onOpenIssueChange,
}: SignalsWorkspaceProps) {
  const m = useSignalsMessages();
  const [localView, setLocalView] = useState<SignalsView>("overview");
  const [localOpen, setLocalOpen] = useState<string | null>(null);
  const [chosenEnvironment, setEnvironment] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<IngestKeySummary | null>(null);
  const [creating, setCreating] = useState(false);
  const toast = useToast();
  const view = controlledView ?? localView;
  const openId = controlledOpen !== undefined ? controlledOpen : localOpen;
  const setView = (next: SignalsView) => {
    setLocalView(next);
    onViewChange?.(next);
  };
  const setOpenId = (next: string | null) => {
    setLocalOpen(next);
    onOpenIssueChange?.(next);
  };
  const caps = source.capabilities;
  const issues = useAsync(
    async (signal) =>
      caps.read ? normalizeList(await source.listIssues(signal)) : { issues: [], truncated: false },
    [source],
  );
  const coverage = useAsync(
    (signal): Promise<EnvironmentCoverage[]> =>
      caps.coverage && source.listCoverage ? source.listCoverage(signal) : Promise.resolve([]),
    [source],
  );
  const releases = useAsync(
    (signal): Promise<ReleaseCoverage[]> =>
      caps.releases && source.listReleases ? source.listReleases(signal) : Promise.resolve([]),
    [source],
  );
  const keys = useAsync(
    (signal) =>
      caps.ingestKeys.list && source.listKeys ? source.listKeys(signal) : Promise.resolve([]),
    [source],
  );
  const loadUsage = useMemo(
    () =>
      caps.usage && source.getUsage
        ? (signal: AbortSignal): Promise<SignalsUsage> => source.getUsage!(signal)
        : null,
    [caps.usage, source],
  );
  const loadHistory = useMemo(
    () =>
      caps.history && source.getHistory
        ? (issue: SignalIssue, signal: AbortSignal) => source.getHistory!(issue, signal)
        : undefined,
    [caps.history, source],
  );
  const recordFix = useMemo(
    () =>
      caps.corrections && source.recordCorrection
        ? (issue: SignalIssue, input: CorrectionInput) => source.recordCorrection!(issue, input)
        : undefined,
    [caps.corrections, source],
  );
  const createKey = useMemo(
    () =>
      caps.ingestKeys.create && source.createKey && !keysReadOnlyReason
        ? (label: string): Promise<CreatedIngestKey> => source.createKey!(label)
        : null,
    [caps.ingestKeys.create, source, keysReadOnlyReason],
  );

  const now = Date.now();
  const all = issues.state.status === "success" ? issues.state.data.issues : null;
  const coverageRows = coverage.state.status === "success" ? coverage.state.data : [];
  const releaseList = releases.state.status === "success" ? releases.state.data : [];
  const environments = useMemo(() => environmentsOf(all ?? [], coverageRows), [all, coverageRows]);
  const environment =
    chosenEnvironment && environments.includes(chosenEnvironment)
      ? chosenEnvironment
      : (environments[0] ?? "production");
  const groups = useMemo(() => (all ? liveGroups(all).sort(compareIssues) : []), [all]);
  const here = useMemo(
    () => groups.filter((issue) => issue.environment === environment),
    [groups, environment],
  );
  const checks = useMemo(
    () => readiness(all ?? [], coverageRows, now),
    // `now` moves every render; the checks follow the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, coverageRows],
  );
  const open = groups.find((issue) => issue.id === openId) ?? null;
  const reloadAll = useCallback(() => {
    issues.reload();
    coverage.reload();
    releases.reload();
    keys.reload();
  }, [issues, coverage, releases, keys]);

  if (!caps.read) {
    return (
      <div className="pr-stack pr-stack--5">
        <PageHeader title={m.t("title")} description={m.t("lead")} />
        <CapabilityUnavailable
          title={m.t("unavailable.title")}
          reason={caps.unavailableReason ?? m.t("unavailable.fallback")}
        />
        {setup}
      </div>
    );
  }

  const truncated = issues.state.status === "success" && issues.state.data.truncated;
  const declared = all ? all.filter(isDeclared).length : 0;
  const linkFor = (issue: SignalIssue) =>
    typeof consoleUrl === "function" ? consoleUrl(issue) : consoleUrl;
  const openIssue = (issue: SignalIssue) => setOpenId(issue.id);
  const firstRun =
    all !== null && groups.length === 0 && declared === 0 && coverageRows.length === 0;

  return (
    <div className="pr-stack pr-stack--5">
      <PageHeader
        title={m.t("title")}
        description={m.t("lead")}
        actions={
          environments.length > 1 ? (
            <SegmentedControl
              label={m.t("environment")}
              size="sm"
              value={environment}
              onValueChange={setEnvironment}
              options={environments.map((env) => ({ value: env, label: environmentName(env) }))}
            />
          ) : undefined
        }
      />
      {caps.coverage ? (
        coverage.state.status === "error" ? (
          <LoadError
            compact
            title={m.t("connection.label")}
            error={coverage.state.error}
            onRetry={coverage.reload}
          />
        ) : (
          <ConnectionStrip connections={connectionsOf(coverageRows, now)} now={now} />
        )
      ) : null}
      <Tabs
        label={m.t("views")}
        idPrefix="signals"
        value={view}
        onValueChange={setView}
        items={[
          { value: "overview", label: m.t("tabs.overview") },
          { value: "issues", label: m.t("tabs.issues"), count: all ? here.length : undefined },
          {
            value: "setup",
            label: m.t("tabs.setup"),
            count: all && openChecks(checks) > 0 ? openChecks(checks) : undefined,
          },
        ]}
      />
      {truncated ? (
        <Banner tone="info">{m.t("truncated", { count: groups.length + declared })}</Banner>
      ) : null}

      {view === "overview" ? (
        <TabPanel idPrefix="signals" value="overview" className="pr-stack pr-stack--4">
          <AsyncView resource={issues} errorTitle={m.t("loadError")}>
            {() =>
              firstRun ? (
                <StateMessage
                  icon={Activity}
                  title={m.t("empty.title")}
                  description={m.t("empty.description")}
                  actions={
                    <Button size="sm" onClick={() => setView("setup")}>
                      {m.t("empty.action")}
                    </Button>
                  }
                />
              ) : (
                <>
                  <SignalsKeyFigures figures={signalsFigures(here, caps.policy, now)} />
                  <BrokenByArea
                    areas={brokenByArea(here)}
                    environment={environment}
                    knowledgeAt={knowledgeAt}
                    onNavigate={onNavigate}
                    onOpen={openIssue}
                    onShowAll={() => setView("issues")}
                  />
                  <FixesBeingProven
                    rows={fixesBeingProven(here, caps.policy, now)}
                    onOpen={openIssue}
                    onShowAll={() => setView("issues")}
                  />
                  {caps.releases ? (
                    releases.state.status === "error" ? (
                      <LoadError
                        title={m.t("releases.title")}
                        error={releases.state.error}
                        onRetry={releases.reload}
                      />
                    ) : (
                      <ReleasesCard
                        rows={releaseRowsOf(releaseList, groups, environment)}
                        environment={environment}
                      />
                    )
                  ) : null}
                </>
              )
            }
          </AsyncView>
        </TabPanel>
      ) : null}

      {view === "issues" ? (
        <TabPanel idPrefix="signals" value="issues">
          <AsyncView resource={issues} errorTitle={m.t("loadError")}>
            {() => (
              <IssueBrowser
                issues={here}
                environment={environment}
                knowledgeAt={knowledgeAt}
                onOpen={openIssue}
              />
            )}
          </AsyncView>
        </TabPanel>
      ) : null}

      {view === "setup" ? (
        <TabPanel idPrefix="signals" value="setup" className="pr-signals-setup">
          <div className="pr-stack pr-stack--4">
            {all ? <ReadinessCard checks={checks} /> : null}
            {setup}
          </div>
          <div className="pr-stack pr-stack--4">
            {loadUsage ? <UsageCard load={loadUsage} /> : null}
            {caps.ingestKeys.list ? (
              keys.state.status === "error" ? (
                <LoadError
                  title={m.t("keys.title")}
                  error={keys.state.error}
                  onRetry={keys.reload}
                />
              ) : (
                <IngestKeysPanel
                  keys={keys.state.status === "success" ? keys.state.data : []}
                  onCreate={createKey ? () => setCreating(true) : undefined}
                  onRevoke={
                    caps.ingestKeys.revoke && source.revokeKey && !keysReadOnlyReason
                      ? (key) => setRevoking(key)
                      : undefined
                  }
                  readOnlyReason={keysReadOnlyReason}
                />
              )
            ) : null}
            <KeptCard retention={caps.retention} />
            {managedPanels}
          </div>
        </TabPanel>
      ) : null}

      <Drawer
        open={open != null}
        onOpenChange={(next) => !next && setOpenId(null)}
        width="lg"
        eyebrow={
          open ? `${m.t(`kind.${open.kind}`)} · ${environmentName(open.environment)}` : undefined
        }
        title={open ? issueTitle(open) : ""}
        status={open && open.status !== "active" ? <StatusBadge issue={open} /> : null}
        description={m.t("detail.description")}
      >
        {open ? (
          <SignalIssueDetail
            issue={open}
            all={groups}
            workspaceName={workspaceName}
            consoleUrl={linkFor(open)}
            onOpenSibling={(other) => setOpenId(other.id)}
            capabilities={caps}
            loadHistory={loadHistory}
            recordFix={recordFix}
            onChanged={reloadAll}
            agentSteps={agentSteps?.(open)}
            knowledgeAt={knowledgeAt}
            onNavigate={onNavigate}
          />
        ) : null}
      </Drawer>

      {createKey ? (
        <CreateKeyDialog
          open={creating}
          onOpenChange={setCreating}
          create={createKey}
          onCreated={keys.reload}
        />
      ) : null}

      <ConfirmDialog
        open={revoking != null}
        onOpenChange={(next) => !next && setRevoking(null)}
        tone="danger"
        title={
          revoking
            ? m.t("keys.revokeTitle", { prefix: revoking.prefix })
            : m.t("keys.revokeFallbackTitle")
        }
        description={m.t("keys.revokeDescription")}
        confirmLabel={m.t("keys.revokeConfirm")}
        onConfirm={async () => {
          if (!revoking || !source.revokeKey) return;
          await source.revokeKey(revoking);
          toast.show({ title: m.t("keys.revokedToast", { prefix: revoking.prefix }) });
          keys.reload();
        }}
      />
    </div>
  );
}
