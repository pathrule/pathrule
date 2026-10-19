// SPDX-License-Identifier: Apache-2.0
import type {
  KnowledgeKind,
  KnowledgeListItem,
  KnowledgeRecord,
  KnowledgeWriteResponse,
} from "@pathrule/protocol/local-ui-api.js";
import {
  AsyncView,
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  Drawer,
  KeyValueList,
  RelativeTime,
  StateMessage,
  useAsync,
  useToast,
} from "@pathrule/ui";
import { Archive, Pencil, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useConsole } from "../app/context.js";
import { useConsoleMessages } from "../messages.js";
import { KnowledgeEditor } from "./KnowledgeEditor.js";
import { KnowledgeInsights } from "./KnowledgeInsights.js";
import type { TopicIndex } from "./model.js";

type Messages = ReturnType<typeof useConsoleMessages>;

/** What a write means for the agents, from the hook index refresh the server reported. */
export function hookIndexNote(m: Messages, result: KnowledgeWriteResponse): string {
  return m.t(`drawer.${result.hookIndex}`);
}

function titleOf(record: KnowledgeRecord): string {
  return record.kind === "memory" ? record.item.title : record.item.name;
}

export interface KnowledgeDrawerProps {
  workspaceId: string;
  kind: KnowledgeKind;
  id: string | null;
  archived: boolean;
  onClose: () => void;
  onChanged: () => void;
  /** The item as the list knows it: with these, the panel opens with its figures and relations. */
  listItem?: KnowledgeListItem | null;
  delivered?: ReadonlyMap<string, number> | null;
  previous?: ReadonlyMap<string, number>;
  topics?: TopicIndex;
  items?: readonly KnowledgeListItem[];
  onOpenItem?: (item: KnowledgeListItem) => void;
}

export function KnowledgeDrawer({
  workspaceId,
  kind,
  id,
  archived,
  onClose,
  onChanged,
  listItem,
  delivered,
  previous,
  topics,
  items,
  onOpenItem,
}: KnowledgeDrawerProps) {
  const m = useConsoleMessages();
  const { api, capabilities } = useConsole();
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const canWrite = capabilities.knowledgeWrite.available;

  const record = useAsync(
    (signal) =>
      id
        ? api.call("knowledge.read", { workspaceId, kind, id }, signal).then((r) => r.record)
        : Promise.resolve(null),
    [api, workspaceId, kind, id, version],
  );

  const loaded = record.state.status === "success" ? record.state.data : null;

  const restore = async () => {
    if (!id) return;
    setRestoring(true);
    try {
      const result = await api.call("knowledge.restore", { workspaceId, kind, id });
      toast.show({ title: m.t("drawer.restored"), description: hookIndexNote(m, result) });
      onChanged();
      onClose();
    } catch (error) {
      toast.show({
        title: m.t("drawer.restoreFailed"),
        description: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setRestoring(false);
    }
  };

  return (
    <>
      <Drawer
        open={id != null}
        onOpenChange={(open) => !open && onClose()}
        width="lg"
        eyebrow={m.t(`kinds.singular.${kind}`)}
        title={loaded ? titleOf(loaded) : m.t("drawer.loading")}
        status={
          archived ? (
            <Badge size="sm" tone="neutral" variant="outline">
              {m.t("drawer.archivedBadge")}
            </Badge>
          ) : null
        }
        description={m.t("drawer.detail", { kind: m.t(`kinds.title.${kind}`) })}
        footer={
          loaded && canWrite ? (
            archived ? (
              <Button
                variant="primary"
                leadingIcon={RotateCcw}
                loading={restoring}
                onClick={() => void restore()}
              >
                {m.t("drawer.restore")}
              </Button>
            ) : (
              <>
                <Button leadingIcon={Archive} onClick={() => setConfirmDelete(true)}>
                  {m.t("drawer.delete")}
                </Button>
                <Button variant="primary" leadingIcon={Pencil} onClick={() => setEditing(true)}>
                  {m.t("drawer.edit")}
                </Button>
              </>
            )
          ) : undefined
        }
      >
        <AsyncView resource={record} errorTitle={m.t("drawer.loadError")}>
          {(data) =>
            data == null ? (
              <StateMessage
                title={m.t("drawer.notFound")}
                description={m.t("drawer.notFoundDescription")}
              />
            ) : listItem && topics && items && onOpenItem ? (
              <div className="pr-stack pr-stack--5">
                <KnowledgeInsights
                  workspaceId={workspaceId}
                  item={listItem}
                  delivered={delivered ?? null}
                  previous={previous ?? new Map()}
                  topics={topics}
                  items={items}
                  onOpenItem={onOpenItem}
                />
                <KnowledgeBody record={data} compact />
              </div>
            ) : (
              <KnowledgeBody record={data} />
            )
          }
        </AsyncView>
      </Drawer>
      {editing && loaded ? (
        <KnowledgeEditor
          mode={{ kind: "edit", record: loaded }}
          workspaceId={workspaceId}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setVersion((v) => v + 1);
            onChanged();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={
          loaded
            ? m.t("drawer.deleteTitle", { title: titleOf(loaded) })
            : m.t("drawer.deleteFallback")
        }
        description={m.t("drawer.deleteDescription")}
        confirmLabel={m.t("drawer.delete")}
        icon={Archive}
        onConfirm={async () => {
          if (!loaded || !id) return;
          const result = await api.call("knowledge.delete", {
            workspaceId,
            kind,
            id,
            expectedVersionId: loaded.item.versionId,
          });
          toast.show({ title: m.t("drawer.deleted"), description: hookIndexNote(m, result) });
          onChanged();
          onClose();
        }}
      />
    </>
  );
}

/** `compact`: the figures above already say the version, the dates and the people. */
function KnowledgeBody({
  record,
  compact = false,
}: {
  record: KnowledgeRecord;
  compact?: boolean;
}) {
  const m = useConsoleMessages();
  const { itemIds } = useConsole();
  const item = record.item;
  const paths = record.kind === "memory" ? (record.path ? [record.path] : []) : record.paths;
  const meta = [
    {
      key: record.kind === "memory" ? m.t("drawer.ownerPath") : m.t("drawer.attachedTo"),
      value: paths.length ? paths.join(", ") : m.t("drawer.notPlaced"),
      mono: paths.length > 0,
    },
    ...(record.kind === "rule"
      ? [
          { key: m.t("drawer.priority"), value: record.item.priority },
          { key: m.t("drawer.scope"), value: record.item.scopeType },
        ]
      : []),
    ...(record.kind === "skill" && record.item.tags.length
      ? [{ key: m.t("drawer.tags"), value: record.item.tags.join(", ") }]
      : []),
    ...(compact
      ? []
      : [
          { key: m.t("drawer.version"), value: `v${item.versionNumber}`, mono: true },
          { key: m.t("drawer.updated"), value: <RelativeTime iso={item.updatedAt} /> },
          { key: m.t("drawer.created"), value: <RelativeTime iso={item.createdAt} /> },
          ...(item.lastEditedBy
            ? [{ key: m.t("drawer.lastEditedBy"), value: item.lastEditedBy }]
            : []),
        ]),
    ...(itemIds !== false
      ? [{ key: m.t("drawer.id"), value: item.id, mono: true, copy: item.id }]
      : []),
  ];
  return (
    <div className="pr-stack pr-stack--5">
      {record.kind === "skill" && record.item.description ? (
        <p className="lc-description">{record.item.description}</p>
      ) : null}
      <section aria-label={m.t("drawer.contentRegion")} className="lc-content">
        <div className="lc-content__head">
          <span className="pr-section-label">{m.t("drawer.content")}</span>
          <CopyButton
            value={item.content}
            label={m.t("drawer.copyContent")}
            text={m.t("drawer.copy")}
          />
        </div>
        <div className="lc-content__body">
          {item.content || <span className="pr-muted">{m.t("drawer.empty")}</span>}
        </div>
      </section>
      <KeyValueList
        items={meta}
        renderCopy={(entry) =>
          entry.copy ? (
            <CopyButton value={entry.copy} label={m.t("drawer.copyField", { field: entry.key })} />
          ) : null
        }
      />
    </div>
  );
}
