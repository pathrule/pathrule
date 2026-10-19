// SPDX-License-Identifier: Apache-2.0
import type { LocalWorkspaceSummary } from "@pathrule/protocol/local-ui-api.js";
import { Page } from "@pathrule/ui";
import { Gauge, Radio } from "lucide-react";
import { useCallback } from "react";
import { useConsole, useRuntimeStatus } from "../app/context.js";
import { useConsoleMessages } from "../messages.js";
import { hrefFor } from "../router.js";
import { shortFolder } from "../workspaces/model.js";
import { WorkspaceDirectory } from "../workspaces/WorkspaceDirectory.js";

/** The person's home folder, when the Pathrule home is the default one inside it. */
function userHome(pathruleHome: string): string | null {
  const match = /^(.*)[\\/]\.pathrule[\\/]?$/.exec(pathruleHome);
  return match?.[1] ? match[1] : null;
}

/** Every workspace on this machine. */
export function WorkspacesPage() {
  const m = useConsoleMessages();
  const { workspaces, navigate } = useConsole();
  const status = useRuntimeStatus();
  const home = userHome(status.home);
  const describe = useCallback(
    (workspace: LocalWorkspaceSummary) => ({
      text: shortFolder(workspace.rootPath, home),
      kind: "folder" as const,
    }),
    [home],
  );
  const overview = useCallback(
    (workspace: LocalWorkspaceSummary) => hrefFor({ name: "overview", workspaceId: workspace.id }),
    [],
  );
  return (
    <Page>
      <WorkspaceDirectory
        scope={
          <span className="lc-ws-scope">
            {m.t("workspaces.here")}
            <span className="lc-ws-scope__count pr-tabular">{m.number(workspaces.length)}</span>
          </span>
        }
        figures={{
          countNote: m.t("workspaces.figures.countNote"),
          deliveriesLine: m.t("workspaces.figures.deliveriesLine"),
          quietAdvice: m.t("workspaces.figures.quietAdvice"),
        }}
        searchHint={m.t("workspaces.searchHint")}
        describe={describe}
        hrefFor={overview}
        actions={(workspace) => [
          {
            label: m.t("workspaces.openOverview"),
            icon: Gauge,
            onSelect: () => navigate(overview(workspace)),
          },
          {
            label: m.t("workspaces.openSignals"),
            icon: Radio,
            onSelect: () =>
              navigate(
                hrefFor({
                  name: "signals",
                  workspaceId: workspace.id,
                  view: "overview",
                  group: null,
                }),
              ),
          },
        ]}
        setupCommand="pathrule init --local"
      />
    </Page>
  );
}
