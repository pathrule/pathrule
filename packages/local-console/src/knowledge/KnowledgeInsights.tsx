// SPDX-License-Identifier: Apache-2.0
// The top of an item's panel: how often agents received it, its version and last edit, who added
// it (the person, even when an agent wrote it), what is related to it and, where the backend keeps
// it, who changed it when.
import type { KnowledgeKind, KnowledgeListItem } from "@pathrule/protocol/local-ui-api.js";
import { LoadError, RelativeTime, Swatch } from "@pathrule/ui";
import { Bot, UserRound } from "lucide-react";
import { useConsole } from "../app/context.js";
import { useLocal } from "../app/use-local.js";
import { useConsoleMessages } from "../messages.js";
import { KIND_COLORS } from "../overview/panel.js";
import { itemKey, relatedItems, type TopicIndex } from "./model.js";

export interface KnowledgeInsightsProps {
  workspaceId: string;
  item: KnowledgeListItem;
  delivered: ReadonlyMap<string, number> | null;
  previous: ReadonlyMap<string, number>;
  topics: TopicIndex;
  items: readonly KnowledgeListItem[];
  onOpenItem: (item: KnowledgeListItem) => void;
}

export function KnowledgeInsights({
  workspaceId,
  item,
  delivered,
  previous,
  topics,
  items,
  onOpenItem,
}: KnowledgeInsightsProps) {
  const m = useConsoleMessages();
  const { capabilities } = useConsole();
  const key = itemKey(item);
  const count = delivered?.get(key) ?? 0;
  const before = previous.get(key) ?? 0;
  const change = before > 0 ? (count - before) / before : null;
  const editor = item.lastEditedBy?.name ?? item.createdBy?.name ?? null;
  const author = item.createdBy?.name ?? null;
  const related = relatedItems(item, items, topics);

  return (
    <div className="lc-kn-insights">
      <div className="lc-kn-glance" role="list" aria-label={m.t("drawer.glance")}>
        <div role="listitem" className="lc-kn-glance__cell">
          <span className="lc-kn-glance__label">{m.t("drawer.delivered")}</span>
          <span className="lc-kn-glance__value">
            <span className="pr-tabular">{delivered ? m.number(count) : "—"}</span>
            {change !== null ? (
              <span
                className={
                  change < 0 ? "lc-ws-change lc-ws-change--down" : "lc-ws-change lc-ws-change--up"
                }
              >
                {change >= 0 ? "+" : "−"}
                {m.number(Math.abs(change), { style: "percent", maximumFractionDigits: 0 })}
              </span>
            ) : null}
          </span>
          <span className="lc-kn-glance__note">
            {!delivered
              ? m.t("drawer.deliveredOff")
              : count === 0
                ? m.t("drawer.deliveredNone")
                : m.t("drawer.deliveredBefore", { count: m.number(before) })}
          </span>
        </div>
        <div role="listitem" className="lc-kn-glance__cell">
          <span className="lc-kn-glance__label">{m.t("drawer.version")}</span>
          <span className="lc-kn-glance__value pr-mono">v{item.versionNumber}</span>
          <span className="lc-kn-glance__note">
            {item.versionNumber > 1
              ? m.plural("drawer.versionNote", item.versionNumber - 1)
              : m.t("drawer.neverEdited")}
          </span>
        </div>
        <div role="listitem" className="lc-kn-glance__cell">
          <span className="lc-kn-glance__label">{m.t("drawer.lastEdited")}</span>
          <span className="lc-kn-glance__value">
            <RelativeTime iso={item.updatedAt} />
          </span>
          <span className="lc-kn-glance__note">
            {editor ? m.t("drawer.by", { name: editor }) : ""}
          </span>
        </div>
      </div>

      <p className="lc-kn-provenance">
        <span
          className={
            item.addedVia === "agent"
              ? "lc-kn-provenance__icon lc-kn-provenance__icon--agent"
              : "lc-kn-provenance__icon"
          }
          aria-hidden
        >
          {item.addedVia === "agent" ? <Bot size={13} /> : <UserRound size={13} />}
        </span>
        <span>
          {author
            ? m.t(item.addedVia === "agent" ? "drawer.addedByAgent" : "drawer.addedByPerson", {
                name: author,
              })
            : m.t("drawer.addedUnknown")}
          {item.createdAt ? (
            <>
              {" · "}
              {m.t("drawer.created").toLowerCase()} <RelativeTime iso={item.createdAt} />
            </>
          ) : null}
        </span>
      </p>

      {related.length > 0 ? (
        <section className="lc-kn-related" aria-label={m.t("drawer.related")}>
          <span className="pr-section-label">
            {m.t("drawer.related")}
            <span className="lc-kn-related__hint"> · {m.t("drawer.relatedHint")}</span>
          </span>
          <ul>
            {related.map(({ item: other, why }) => (
              <li key={itemKey(other)}>
                <button
                  type="button"
                  className="lc-kn-related__item"
                  onClick={() => onOpenItem(other)}
                >
                  <Swatch color={KIND_COLORS[other.kind]} />
                  <span className="lc-kn-related__text">
                    <span className="lc-kn-related__title">{other.title}</span>
                    <span className="lc-kn-related__path pr-mono">{other.path ?? ""}</span>
                  </span>
                  <span className="lc-kn-related__why">
                    {m.t(why === "topic" ? "drawer.relatedTopic" : "drawer.relatedPath")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {capabilities.knowledgeHistory.available ? (
        <History workspaceId={workspaceId} kind={item.kind} id={item.id} />
      ) : null}
    </div>
  );
}

function History({
  workspaceId,
  kind,
  id,
}: {
  workspaceId: string;
  kind: KnowledgeKind;
  id: string;
}) {
  const m = useConsoleMessages();
  const history = useLocal("knowledge.history", { workspaceId, kind, id });
  if (history.state.status === "loading") return null;
  return (
    <section className="lc-kn-history" aria-label={m.t("drawer.history")}>
      <span className="pr-section-label">{m.t("drawer.history")}</span>
      {history.state.status === "error" ? (
        <LoadError
          compact
          title={m.t("drawer.historyError")}
          error={history.state.error}
          onRetry={history.reload}
        />
      ) : history.state.data.revisions.length === 0 ? (
        <p className="lc-kn-history__empty">{m.t("drawer.historyEmpty")}</p>
      ) : (
        <ol>
          {history.state.data.revisions.slice(0, 6).map((revision) => (
            <li key={revision.versionNumber}>
              <span className="pr-mono lc-kn-history__v">v{revision.versionNumber}</span>
              <span className="lc-kn-history__who">
                {revision.editedBy?.name ?? m.t("knowledge.unknownAuthor")}
              </span>
              <RelativeTime iso={revision.editedAt} className="lc-kn-history__when" />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
