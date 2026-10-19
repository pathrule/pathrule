// SPDX-License-Identifier: Apache-2.0
import type { LocalCapabilities, LocalCapability } from "@pathrule/protocol/local-ui-api.js";
import {
  Badge,
  Card,
  CardHeader,
  CommandChip,
  DataList,
  Page,
  PageHeader,
  StateMessage,
} from "@pathrule/ui";
import { FolderPlus } from "lucide-react";
import { useId } from "react";
import { useConsole, useRuntimeStatus } from "../app/context.js";
import { useConsoleMessages } from "../messages.js";
import { WorkspaceOverview } from "../overview/WorkspaceOverview.js";
import { PanelFooterLink } from "../overview/panel.js";
import { hrefFor } from "../router.js";

/** The Local Console's home: the current workspace's overview, or how to create one. */
export function OverviewPage() {
  const m = useConsoleMessages();
  const { workspace } = useConsole();
  if (!workspace)
    return (
      <Page>
        <div className="pr-stack pr-stack--5">
          <PageHeader title={m.t("overview.title")} description={m.t("overview.description")} />
          <Card>
            <StateMessage
              icon={FolderPlus}
              title={m.t("overview.noWorkspace")}
              description={m.t("overview.noWorkspaceDescription")}
              actions={<CommandChip command="pathrule init --local" />}
            />
          </Card>
        </div>
      </Page>
    );
  return (
    <Page>
      <WorkspaceOverview
        key={workspace.id}
        workspaceId={workspace.id}
        name={workspace.name}
        aside={<MachineCard />}
      />
    </Page>
  );
}

/** How many of the machine's workspaces the Overview names; the rest are on the Workspaces page. */
const MACHINE_WORKSPACES = 5;

/** This machine: the runtime serving the console, what it can do, and a few of its workspaces. */
function MachineCard() {
  const m = useConsoleMessages();
  const { workspaces, navigate } = useConsole();
  const status = useRuntimeStatus();
  const id = useId();
  const capabilities = Object.entries(status.capabilities) as Array<
    [keyof LocalCapabilities, LocalCapability]
  >;
  return (
    <Card className="lc-panel" aria-labelledby={id}>
      <CardHeader
        id={id}
        title={m.t("overview.machine")}
        description={m.t("overview.machineDescription")}
        actions={
          <Badge size="sm" variant="outline">
            {m.t("overview.hostMode", { mode: status.host.mode })}
          </Badge>
        }
      />
      <DataList
        label={m.t("overview.machine")}
        rows={capabilities.map(([key, capability]) => ({
          key,
          title: m.t(`overview.capability.${key}`),
          meta: capability.available ? undefined : capability.reason,
          value: (
            <Badge size="sm" tone={capability.available ? "positive" : "neutral"} variant="outline">
              {m.t(capability.available ? "overview.available" : "overview.notAvailable")}
            </Badge>
          ),
        }))}
      />
      <p className="lc-panel__section">{m.t("overview.workspaces")}</p>
      <DataList
        label={m.t("overview.workspaces")}
        onNavigate={navigate}
        rows={[...workspaces]
          // This folder's workspace first, then the others as the list names them.
          .sort((a, b) => Number(b.current) - Number(a.current))
          .slice(0, MACHINE_WORKSPACES)
          .map((entry) => ({
            key: entry.id,
            title: <span className="pr-mono">{entry.name}</span>,
            meta: <span className="pr-mono lc-path">{entry.rootPath}</span>,
            value: entry.current ? (
              <Badge size="sm" variant="outline">
                {m.t("overview.thisFolder")}
              </Badge>
            ) : undefined,
            href: hrefFor({
              name: "knowledge",
              workspaceId: entry.id,
              kind: "memory",
              archived: false,
              open: null,
            }),
          }))}
      />
      {workspaces.length > 0 ? (
        <PanelFooterLink href={hrefFor({ name: "workspaces" })} navigate={navigate}>
          {m.plural("overview.allWorkspaces", workspaces.length)}
        </PanelFooterLink>
      ) : null}
    </Card>
  );
}
