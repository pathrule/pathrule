// SPDX-License-Identifier: Apache-2.0
// What every Overview card shares: the data they read, the kind colors and the card frame.
import type {
  DeliveryStatsResponse,
  DeliveryStatsWindow,
  KnowledgeKind,
  KnowledgeListItem,
} from "@pathrule/protocol/local-ui-api.js";
import { Card, EmptyPanel, Icon, Skeleton, type AsyncState, type ChartColor } from "@pathrule/ui";
import { ArrowRight, Lock } from "lucide-react";
import type { ReactNode } from "react";

export const KIND_COLORS: Record<KnowledgeKind, ChartColor> = {
  memory: "viz-1",
  rule: "viz-2",
  skill: "viz-3",
};

export interface OverviewCardData {
  workspaceId: string;
  workspaceName: string;
  range: DeliveryStatsWindow;
  /** All active items of the three kinds, or the lists' load state. */
  items: AsyncState<KnowledgeListItem[]>;
  reloadItems: () => void;
  /** Delivery statistics; `null` data where the backend records none (see `deliveriesOff`). */
  stats: AsyncState<DeliveryStatsResponse | null>;
  reloadStats: () => void;
  /** The backend's reason when delivery statistics are unavailable, else null. */
  deliveriesOff: string | null;
  now: number;
}

/** A card that fills its row's height, labelled by its header; `anchor` makes it a link target. */
export function Panel({
  id,
  anchor,
  children,
}: {
  id: string;
  anchor?: string;
  children: ReactNode;
}) {
  return (
    <Card id={anchor} className="lc-panel" aria-labelledby={id}>
      {children}
    </Card>
  );
}

/**
 * A card's way to the whole list it samples ("View all", "All activity"): the last line of the card, so
 * cards side by side end on the same line. A plain click stays in the app; a modified one opens a tab.
 */
export function PanelFooterLink({
  href,
  navigate,
  children,
}: {
  href: string;
  navigate: (href: string) => void;
  children: ReactNode;
}) {
  return (
    <a
      className="lc-panel__footer-link"
      href={href}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      <span>{children}</span>
      <Icon icon={ArrowRight} size="sm" />
    </a>
  );
}

export function Loading() {
  return (
    <div className="lc-panel__body" aria-busy="true">
      <Skeleton shape="row" />
      <Skeleton shape="row" />
      <Skeleton shape="row" />
    </div>
  );
}

export function Unavailable({ title, reason }: { title: string; reason: string }) {
  return <EmptyPanel icon={Lock} title={title} description={reason} />;
}
