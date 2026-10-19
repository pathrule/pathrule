// SPDX-License-Identifier: Apache-2.0
// One workspace at a glance: how agents use its knowledge, where it is thin, what needs a look.
// Everything comes through the Local UI API, so `pathrule ui` and Pathrule Cloud's console render
// the same page, each from its own backend; the host fills the last card (`aside`).
import {
  DELIVERY_STATS_WINDOWS,
  type DeliveryStatsResponse,
  type DeliveryStatsWindow,
  type KnowledgeListItem,
} from "@pathrule/protocol/local-ui-api.js";
import { Button, PageHeader, SegmentedControl, useAsync, type AsyncState } from "@pathrule/ui";
import { Download } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useConsole } from "../app/context.js";
import { useLocal } from "../app/use-local.js";
import { useConsoleMessages } from "../messages.js";
import { DeliveriesCard, TopKnowledgeCard } from "./delivery-cards.js";
import { ActivityCard, CoverageCard, HealthCard } from "./knowledge-cards.js";
import type { OverviewCardData } from "./panel.js";
import { KeyFigures } from "./KeyFigures.js";
import { deliveriesByItem, deliveriesCsv, summarizeDeliveries } from "./model.js";

export interface WorkspaceOverviewProps {
  workspaceId: string;
  name: string;
  /** The last card, beside recent activity: this machine locally, the organization in Cloud. */
  aside?: ReactNode;
}

function combine(
  lists: ReadonlyArray<AsyncState<{ items: KnowledgeListItem[] }>>,
): AsyncState<KnowledgeListItem[]> {
  const failed = lists.find((list) => list.status === "error");
  if (failed && failed.status === "error") return { status: "error", error: failed.error };
  if (lists.some((list) => list.status === "loading")) return { status: "loading" };
  return {
    status: "success",
    data: lists.flatMap((list) => (list.status === "success" ? list.data.items : [])),
  };
}

export function WorkspaceOverview({ workspaceId, name, aside }: WorkspaceOverviewProps) {
  const m = useConsoleMessages();
  const { api, capabilities, navigate } = useConsole();
  const [range, setRange] = useState<DeliveryStatsWindow>(30);
  const delivery = capabilities.deliveryStats as typeof capabilities.deliveryStats | undefined;
  const deliveriesOff = delivery?.available
    ? null
    : ((delivery && !delivery.available ? delivery.reason : null) ??
      m.t("overview.deliveries.unavailable"));

  const memories = useLocal("knowledge.list", { workspaceId, kind: "memory" });
  const rules = useLocal("knowledge.list", { workspaceId, kind: "rule" });
  const skills = useLocal("knowledge.list", { workspaceId, kind: "skill" });
  const tree = useLocal("tree.get", { workspaceId });
  const stats = useAsync<DeliveryStatsResponse | null>(
    (signal) =>
      deliveriesOff
        ? Promise.resolve(null)
        : api.call("deliveries.stats", { workspaceId, days: range }, signal),
    [api, workspaceId, range, deliveriesOff],
  );

  const items = combine([memories.state, rules.state, skills.state]);
  const reloadItems = () => {
    memories.reload();
    rules.reload();
    skills.reload();
  };
  // One clock per load, so every card agrees on what "90 days ago" means.
  const now = useMemo(() => Date.now(), [items.status, stats.state.status]);
  const statsData = stats.state.status === "success" ? stats.state.data : null;
  const deliveredMap = useMemo(() => (statsData ? deliveriesByItem(statsData) : null), [statsData]);

  const data: OverviewCardData = {
    workspaceId,
    workspaceName: name,
    range,
    items,
    reloadItems,
    stats: stats.state,
    reloadStats: stats.reload,
    deliveriesOff,
    now,
  };

  const exportCsv = () => {
    if (!statsData) return;
    const url = URL.createObjectURL(new Blob([deliveriesCsv(statsData)], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = m.t("overview.exportFile", { workspace: name, days: String(range) });
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="lc-overview">
      <PageHeader
        title={m.t("overview.title")}
        description={m.t("overview.description")}
        actions={
          <>
            {deliveriesOff ? null : (
              <SegmentedControl
                label={m.t("overview.range.label")}
                value={String(range)}
                onValueChange={(value) => setRange(Number(value) as DeliveryStatsWindow)}
                options={DELIVERY_STATS_WINDOWS.map((days) => ({
                  value: String(days),
                  label: m.t(`overview.range.days.${days}`),
                }))}
              />
            )}
            <Button
              leadingIcon={Download}
              onClick={exportCsv}
              disabled={
                deliveriesOff
                  ? { reason: deliveriesOff }
                  : !statsData || summarizeDeliveries(statsData).total === 0
              }
            >
              {m.t("overview.export")}
            </Button>
          </>
        }
      />
      <KeyFigures
        workspaceId={workspaceId}
        items={items}
        stats={stats.state}
        deliveriesOff={deliveriesOff}
        range={range}
        folders={tree.state.status === "success" ? tree.state.data.nodes : null}
        now={now}
        onNavigate={navigate}
      />
      <DeliveriesCard data={data} />
      <div className="lc-overview__row">
        <TopKnowledgeCard data={data} />
        <HealthCard data={data} deliveredMap={deliveriesOff ? null : deliveredMap} />
      </div>
      <CoverageCard
        data={data}
        deliveredMap={deliveriesOff ? null : deliveredMap}
        folders={
          tree.state.status === "success"
            ? tree.state.data.nodes.filter(
                (node) => node.type === "folder" && node.status === "active",
              ).length
            : null
        }
      />
      <div className="lc-overview__row lc-overview__row--split">
        <ActivityCard workspaceId={workspaceId} />
        {aside}
      </div>
    </div>
  );
}
