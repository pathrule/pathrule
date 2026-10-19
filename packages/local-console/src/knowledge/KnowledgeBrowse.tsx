// SPDX-License-Identifier: Apache-2.0
// The knowledge page's two halves: the rail that browses by path or by topic, and the group cards
// that list what a path or a topic holds.
import type {
  KnowledgeKind,
  KnowledgeListItem,
  TopicNaming,
} from "@pathrule/protocol/local-ui-api.js";
import { Badge, Icon, RelativeTime, SegmentedControl, Swatch } from "@pathrule/ui";
import { ChevronDown, ChevronRight, Folder, Network, Search } from "lucide-react";
import { useMemo, useState, type MouseEvent } from "react";
import { useConsoleMessages } from "../messages.js";
import { KIND_COLORS } from "../overview/panel.js";
import type { HealthState } from "../overview/model.js";
import {
  CONVENTIONS,
  itemKey,
  type BrowseMode,
  type KnowledgeGroup,
  treeRows,
  type PathNode,
  type TopicEntry,
  type TopicIndex,
} from "./model.js";

function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

// ── the rail ─────────────────────────────────────────────────────────────

/** How many topics the rail lists before "Show all". */
const TOPICS_SHOWN = 10;
const KIND_ORDER: readonly KnowledgeKind[] = ["memory", "rule", "skill"];

export interface BrowseRailProps {
  browse: BrowseMode;
  onBrowse: (browse: BrowseMode) => void;
  scope: string | null;
  onScope: (scope: string | null) => void;
  /** Every folder that holds items, the root first (model.ts pathTree). */
  nodes: readonly PathNode[];
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  /** Items per topic id (and CONVENTIONS) in the current kind and status. */
  topicCounts: ReadonlyMap<string, number>;
  /** Items per topic id by kind, in the current status: what each topic holds. */
  topicMix: ReadonlyMap<string, Readonly<Record<KnowledgeKind, number>>>;
  topics: TopicIndex;
  total: number;
  /** null while topics load or where they are unavailable: `topicsNote` says why. */
  naming: TopicNaming | null;
  topicsNote: string | null;
  topicsOn: boolean;
}

export function BrowseRail(props: BrowseRailProps) {
  const m = useConsoleMessages();
  const { browse, scope } = props;
  const [filter, setFilter] = useState("");
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [allTopics, setAllTopics] = useState(false);
  const rows = useMemo(
    () => treeRows(props.nodes, props.expanded, opened, filter),
    [props.nodes, props.expanded, opened, filter],
  );
  const counted = props.topics.topics
    .map((topic) => ({ topic, count: props.topicCounts.get(topic.id) ?? 0 }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);
  const shownTopics = allTopics ? counted : counted.slice(0, TOPICS_SHOWN);
  const mixOf = (id: string) => {
    const mix = props.topicMix.get(id);
    if (!mix) return undefined;
    return KIND_ORDER.filter((kind) => mix[kind] > 0)
      .map((kind) => m.plural(`knowledge.mixCount.${kind}`, mix[kind]))
      .join(" · ");
  };

  return (
    <aside className="lc-kn-rail" aria-label={m.t("knowledge.browse")}>
      <SegmentedControl
        label={m.t("knowledge.browse")}
        size="sm"
        value={browse}
        onValueChange={props.onBrowse}
        className="lc-kn-rail__switch"
        options={[
          { value: "paths", label: m.t("knowledge.paths"), icon: Folder },
          ...(props.topicsOn
            ? [{ value: "topics" as const, label: m.t("knowledge.topics"), icon: Network }]
            : []),
        ]}
      />
      {browse === "paths" ? (
        <>
          <label className="lc-kn-filter">
            <Icon icon={Search} size="sm" />
            <span className="pr-sr-only">{m.t("knowledge.filterFolders")}</span>
            <input
              type="search"
              value={filter}
              placeholder={m.t("knowledge.filterFolders")}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <ul className="lc-kn-tree" aria-label={m.t("knowledge.paths")}>
            {rows.map((row) => {
              if (row.kind === "more")
                return (
                  <li key={`more:${row.parent}`} className="lc-kn-tree__item">
                    <span className="lc-kn-tree__row">
                      <Guides depth={row.depth} />
                      <span className="lc-kn-tree__spacer" aria-hidden />
                      <button
                        type="button"
                        className="lc-kn-tree__node lc-kn-tree__more"
                        onClick={() => setOpened((current) => new Set(current).add(row.parent))}
                      >
                        <span className="lc-kn-tree__label">
                          {m.plural("knowledge.moreFolders", row.hidden)}
                        </span>
                      </button>
                    </span>
                  </li>
                );
              const node = row.node;
              const root = node.path === "/";
              const selected = root ? scope === null || scope === "/" : scope === node.path;
              const open = props.expanded.has(node.path) || Boolean(filter.trim());
              return (
                <li key={node.path} className="lc-kn-tree__item">
                  <span
                    className={
                      selected ? "lc-kn-tree__row lc-kn-tree__row--current" : "lc-kn-tree__row"
                    }
                  >
                    <Guides depth={node.depth} />
                    {!root && node.hasChildren && !filter.trim() ? (
                      <button
                        type="button"
                        className="lc-kn-tree__toggle"
                        aria-expanded={open}
                        aria-label={m.t(open ? "knowledge.collapse" : "knowledge.expand", {
                          path: node.path,
                        })}
                        onClick={() => props.onToggle(node.path)}
                      >
                        <Icon icon={ChevronRight} size="sm" className="lc-kn-tree__chevron" />
                      </button>
                    ) : (
                      <span className="lc-kn-tree__spacer" aria-hidden />
                    )}
                    <button
                      type="button"
                      className="lc-kn-tree__node"
                      aria-current={selected ? "true" : undefined}
                      onClick={() => props.onScope(root ? null : node.path)}
                    >
                      <span className={root ? "lc-kn-tree__label" : "lc-kn-tree__label pr-mono"}>
                        {root ? m.t("knowledge.allPaths") : node.label}
                      </span>
                      <span className="lc-kn-tree__count pr-tabular">{m.number(node.count)}</span>
                    </button>
                  </span>
                </li>
              );
            })}
            {filter.trim() && rows.length <= 1 ? (
              <li className="lc-kn-tree__empty">{m.t("knowledge.noFolderMatch")}</li>
            ) : null}
          </ul>
        </>
      ) : (
        <ul className="lc-kn-topics" aria-label={m.t("knowledge.topics")}>
          <TopicButton
            label={m.t("knowledge.allTopics")}
            count={props.total}
            selected={scope === null}
            onSelect={() => props.onScope(null)}
          />
          {shownTopics.map(({ topic, count }) => (
            <TopicButton
              key={topic.id}
              label={topic.label}
              detail={mixOf(topic.id)}
              count={count}
              selected={scope === topic.id}
              onSelect={() => props.onScope(topic.id)}
            />
          ))}
          {(props.topicCounts.get(CONVENTIONS) ?? 0) > 0 ? (
            <TopicButton
              label={m.t("knowledge.conventions")}
              detail={m.t("knowledge.conventionsHint")}
              count={props.topicCounts.get(CONVENTIONS) ?? 0}
              selected={scope === CONVENTIONS}
              onSelect={() => props.onScope(CONVENTIONS)}
            />
          ) : null}
          {counted.length > TOPICS_SHOWN ? (
            <li>
              <button
                type="button"
                className="lc-kn-topics__all"
                aria-expanded={allTopics}
                onClick={() => setAllTopics((current) => !current)}
              >
                <span>
                  {allTopics
                    ? m.t("knowledge.fewerTopics")
                    : m.t("knowledge.showAllTopics", { count: m.number(counted.length) })}
                </span>
                <Icon icon={ChevronDown} size="sm" className="lc-kn-topics__chevron" />
              </button>
            </li>
          ) : null}
        </ul>
      )}
      {browse === "topics" && props.topicsNote ? (
        <p className="lc-kn-rail__note">{props.topicsNote}</p>
      ) : null}
    </aside>
  );
}

/** One line per level above a folder, so its depth reads at a glance. */
function Guides({ depth }: { depth: number }) {
  if (depth <= 1) return null;
  return (
    <>
      {Array.from({ length: depth - 1 }, (_, i) => (
        <span key={i} className="lc-kn-tree__guide" aria-hidden />
      ))}
    </>
  );
}

function TopicButton({
  label,
  detail,
  count,
  selected,
  onSelect,
}: {
  label: string;
  detail?: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const m = useConsoleMessages();
  return (
    <li>
      <button
        type="button"
        className="lc-kn-topic"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
      >
        <span className="lc-kn-topic__text">
          <span className="lc-kn-topic__label">{label}</span>
          {detail ? <span className="lc-kn-topic__detail">{detail}</span> : null}
        </span>
        <span className="lc-kn-tree__count pr-tabular">{m.number(count)}</span>
      </button>
    </li>
  );
}

// ── groups ───────────────────────────────────────────────────────────────

export interface GroupCardProps {
  group: KnowledgeGroup;
  shown: number;
  onMore: () => void;
  delivered: ReadonlyMap<string, number> | null;
  /** The largest delivery count on the page, for the bars. */
  maxDelivered: number;
  health: (item: KnowledgeListItem) => HealthState;
  topics: TopicIndex;
  browse: BrowseMode;
  openId: string | null;
  hrefFor: (item: KnowledgeListItem) => string;
  onOpen: (item: KnowledgeListItem) => void;
}

const FLAG_TONE: Partial<Record<HealthState, "info" | "warning" | "danger">> = {
  unused: "info",
  stale: "warning",
  unplaced: "danger",
};

function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const second = parts.length > 1 ? (parts[1]?.[0] ?? "") : "";
  return `${first}${second}`.toUpperCase();
}

export function GroupCard(props: GroupCardProps) {
  const m = useConsoleMessages();
  const { group } = props;
  const label =
    group.kind === "conventions"
      ? m.t("knowledge.conventions")
      : group.kind === "none"
        ? m.t(props.browse === "paths" ? "knowledge.noPath" : "knowledge.noTopic")
        : group.label;
  const rows = group.items.slice(0, props.shown);
  const rest = group.items.length - rows.length;
  return (
    <section className="lc-kn-group" aria-label={label}>
      <header className="lc-kn-group__head">
        {group.kind === "path" ? (
          <Folder size={14} aria-hidden className="lc-kn-group__icon" />
        ) : (
          <Network size={14} aria-hidden className="lc-kn-group__icon" />
        )}
        <h2 className={group.kind === "path" ? "lc-kn-group__title pr-mono" : "lc-kn-group__title"}>
          {label}
        </h2>
        <span className="lc-kn-group__sub pr-mono">
          {group.topic && group.topic.named
            ? `${group.topic.terms.join(" · ")} · ${group.topic.homePath}`
            : m.number(group.items.length)}
        </span>
        {props.delivered ? (
          <span className="lc-kn-group__delivered pr-tabular">
            {m.t("knowledge.deliveredSum", { count: m.number(group.delivered) })}
          </span>
        ) : null}
      </header>
      <div className="lc-kn-cols" aria-hidden>
        <span>{m.t("knowledge.columns.item")}</span>
        <span className="lc-kn-col--topic">{m.t("knowledge.columns.topic")}</span>
        <span className="lc-kn-col--delivered lc-kn-col--end">
          {props.delivered ? m.t("knowledge.columns.delivered") : ""}
        </span>
        <span className="lc-kn-col--added">{m.t("knowledge.columns.added")}</span>
      </div>
      <ul className="lc-kn-rows">
        {rows.map((item) => (
          <KnowledgeRow key={itemKey(item)} item={item} {...props} />
        ))}
      </ul>
      {rest > 0 ? (
        <button type="button" className="lc-kn-group__more" onClick={props.onMore}>
          {m.t("knowledge.showMore", { count: m.number(rest), group: label })}
          <ChevronDown size={12} aria-hidden />
        </button>
      ) : null}
    </section>
  );
}

function KnowledgeRow({
  item,
  delivered,
  maxDelivered,
  health,
  topics,
  openId,
  hrefFor,
  onOpen,
}: { item: KnowledgeListItem } & GroupCardProps) {
  const m = useConsoleMessages();
  const state = health(item);
  const tone = FLAG_TONE[state];
  const topic: TopicEntry | undefined = topics.byItem.get(itemKey(item));
  const count = delivered?.get(itemKey(item)) ?? 0;
  const author = item.createdBy?.name ?? null;
  const href = hrefFor(item);
  return (
    <li className={openId === item.id ? "lc-kn-row lc-kn-row--open" : "lc-kn-row"}>
      <span className="lc-kn-row__main">
        <span className="lc-kn-row__title-line">
          <Swatch color={KIND_COLORS[item.kind]} />
          <a
            className="lc-kn-row__title"
            href={href}
            onClick={(event) => {
              if (!isPlainClick(event)) return;
              event.preventDefault();
              onOpen(item);
            }}
          >
            {item.title}
          </a>
        </span>
        {/* The title has its line to itself; its state and priority lead the second line. */}
        {tone || item.priority === "high" || item.preview ? (
          <span className="lc-kn-row__meta-line">
            {tone ? (
              <Badge size="sm" tone={tone}>
                {m.t(`knowledge.healthStates.${state}`)}
              </Badge>
            ) : null}
            {item.priority === "high" ? (
              <Badge size="sm" tone="warning" variant="outline">
                {m.t("knowledge.high")}
              </Badge>
            ) : null}
            {item.preview ? <span className="lc-kn-row__preview">{item.preview}</span> : null}
          </span>
        ) : null}
      </span>
      <span className="lc-kn-col--topic lc-kn-row__topic">
        {topic ? (
          <span className="lc-kn-chip" title={topic.label}>
            {topic.label}
          </span>
        ) : null}
      </span>
      <span className="lc-kn-col--delivered lc-kn-row__delivered">
        {delivered ? (
          <>
            <span className={count ? "pr-tabular" : "pr-tabular lc-kn-row__zero"}>
              {m.number(count)}
            </span>
            <span className="lc-kn-row__bar" aria-hidden>
              <span style={{ width: `${maxDelivered ? (count / maxDelivered) * 100 : 0}%` }} />
            </span>
          </>
        ) : null}
      </span>
      <span className="lc-kn-col--added lc-kn-row__author">
        <span className="lc-kn-avatar" aria-hidden>
          {initials(author ?? "?")}
        </span>
        <span className="lc-kn-row__author-text">
          <span className="lc-kn-row__name">{author ?? m.t("knowledge.unknownAuthor")}</span>
          <span className="lc-kn-row__when">
            {m.t("knowledge.edited")} <RelativeTime iso={item.updatedAt} />
          </span>
        </span>
      </span>
    </li>
  );
}
