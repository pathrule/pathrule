// SPDX-License-Identifier: Apache-2.0
import { Card, CardHeader, CodeBlock, CommandChip, KeyValueList, Page } from "@pathrule/ui";
import { SignalsWorkspace, signalsView, type SignalsView } from "@pathrule/ui/signals";
import { useMemo } from "react";
import { useConsole, useRuntimeStatus } from "../app/context.js";
import { useConsoleMessages } from "../messages.js";
import { hrefFor } from "../router.js";
import { useKnowledgeAt } from "../signals/knowledge-at.js";
import { localSignalsSource } from "../signals/local-source.js";

const SDK_EXAMPLE = `import { pathrule } from "@pathrule/signals";
import { pathruleLocal } from "@pathrule/signals/local";

pathrule.init({
  destination: pathruleLocal(),
  environment: "development",
  release: process.env.npm_package_version ?? null,
});

// Errors, linked to the workspace path and the flow they belong to:
pathrule.error(error, { node: "/src/api", flow: "login" });
`;

/**
 * How an application reaches this workspace, from what the runtime reports: the host that
 * receives, the folder that decides the workspace, and the SDK's real local destination.
 */
function LocalSetup() {
  const { workspace } = useConsole();
  const status = useRuntimeStatus();
  const m = useConsoleMessages();
  const hostUp = status.host.mode !== "degraded";
  return (
    <Card>
      <CardHeader title={m.t("signals.setup.title")} meta={m.t("signals.setup.meta")} />
      <div className="pr-card__body pr-stack pr-stack--3">
        <KeyValueList
          items={[
            {
              key: m.t("signals.setup.destination"),
              value: hostUp
                ? m.t("signals.setup.destinationReady")
                : m.t("signals.setup.destinationDown"),
            },
            ...(workspace
              ? [
                  {
                    key: m.t("signals.setup.workspace"),
                    value: m.t("signals.setup.workspaceNote", { folder: workspace.rootPath }),
                  },
                ]
              : []),
          ]}
        />
        <p className="pr-note">{m.t("signals.setup.sdk")}</p>
        <CodeBlock code={SDK_EXAMPLE} title={m.t("signals.setup.codeTitle")} />
        <p className="pr-note">{m.t("signals.setup.release")}</p>
        <p className="pr-note">{m.t("signals.setup.browser")}</p>
        <p className="pr-note">{m.t("signals.setup.read")}</p>
        <CommandChip command="pathrule instrument events" />
        <p className="pr-note">{m.t("signals.setup.noAccount")}</p>
      </div>
    </Card>
  );
}

/** The shared Signals Workspace over the runtime events Pathrule Local stores for a workspace. */
export function SignalsPage({ view, group }: { view: SignalsView; group: string | null }) {
  const { api, capabilities, workspace, navigate } = useConsole();
  const m = useConsoleMessages();
  const capability = capabilities.runtimeEvents;
  const text = useMemo(
    () => ({
      eventsNotVerified: m.t("signals.eventsNotVerified"),
      retention: m.t("signals.retention"),
    }),
    [m],
  );
  const source = useMemo(
    () => (workspace ? localSignalsSource({ api, workspace, capability, text }) : null),
    [api, workspace, capability, text],
  );
  const knowledgeAt = useKnowledgeAt(api, workspace?.id ?? null, (path) =>
    hrefFor({
      name: "knowledge",
      workspaceId: workspace!.id,
      kind: "all",
      archived: false,
      open: null,
      path,
    }),
  );
  if (!workspace || !source) return null;
  // Opening a group or a view is a step back can undo; closing a group replaces it.
  const go = (nextView: SignalsView, nextGroup: string | null) =>
    navigate(
      hrefFor({ name: "signals", workspaceId: workspace.id, view: nextView, group: nextGroup }),
      { replace: nextView === view && nextGroup === null },
    );
  return (
    <Page>
      <SignalsWorkspace
        source={source}
        workspaceName={workspace.name}
        view={signalsView(view)}
        knowledgeAt={knowledgeAt}
        onNavigate={(href) => navigate(href)}
        onViewChange={(next) => go(next, null)}
        openIssueId={group}
        onOpenIssueChange={(id) => go(view, id)}
        consoleUrl={(issue) =>
          `${window.location.origin}${hrefFor({ name: "signals", workspaceId: workspace.id, view: "issues", group: issue.id })}`
        }
        setup={<LocalSetup />}
        agentSteps={(issue) => [
          m.t("signals.agent.read", { id: issue.id }),
          ...(issue.kind === "error" && issue.revision != null
            ? [m.t("signals.agent.record", { id: issue.id, revision: issue.revision })]
            : []),
        ]}
      />
    </Page>
  );
}
