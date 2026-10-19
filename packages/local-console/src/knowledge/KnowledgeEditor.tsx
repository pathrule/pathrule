// SPDX-License-Identifier: Apache-2.0
import type { KnowledgeKind, KnowledgeRecord } from "@pathrule/protocol/local-ui-api.js";
import type { RulePriority, RuleScope } from "@pathrule/protocol/content-types.js";
import {
  Alert,
  Button,
  Combobox,
  Dialog,
  FormField,
  Select,
  TextInput,
  Textarea,
  useAsync,
  useToast,
} from "@pathrule/ui";
import { useId, useMemo, useState } from "react";
import { LocalApiError } from "../api/client.js";
import { useConsole } from "../app/context.js";
import { useConsoleMessages } from "../messages.js";
import { hookIndexNote } from "./KnowledgeDrawer.js";

export type EditorMode =
  | { kind: "create"; knowledgeKind: KnowledgeKind }
  | { kind: "edit"; record: KnowledgeRecord };

export interface KnowledgeEditorProps {
  mode: EditorMode;
  workspaceId: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}

const TITLE_MAX = 200;

export type PathProblem = "pathStart" | "pathSlashes" | "pathDots";

/** Workspace-relative folder path: "/" or "/a/b". No "..", no backslashes, no drive letters. */
export function validatePath(path: string): PathProblem | null {
  const p = path.trim();
  if (!p.startsWith("/")) return "pathStart";
  if (p.includes("\\")) return "pathSlashes";
  if (p.split("/").some((part) => part === ".." || part === ".")) return "pathDots";
  return null;
}

export function KnowledgeEditor({ mode, workspaceId, onClose, onSaved }: KnowledgeEditorProps) {
  const m = useConsoleMessages();
  const { api } = useConsole();
  const toast = useToast();
  const formId = useId();
  const kind: KnowledgeKind = mode.kind === "create" ? mode.knowledgeKind : mode.record.kind;
  const existing = mode.kind === "edit" ? mode.record : null;

  const [title, setTitle] = useState(
    existing ? (existing.kind === "memory" ? existing.item.title : existing.item.name) : "",
  );
  const [content, setContent] = useState(existing?.item.content ?? "");
  const [path, setPath] = useState("/");
  const [priority, setPriority] = useState<RulePriority>(
    existing?.kind === "rule" ? existing.item.priority : "medium",
  );
  const [scopeType, setScopeType] = useState<RuleScope>(
    existing?.kind === "rule" ? existing.item.scopeType : "folder",
  );
  const [description, setDescription] = useState(
    existing?.kind === "skill" ? (existing.item.description ?? "") : "",
  );
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const tree = useAsync(
    (signal) =>
      mode.kind === "create"
        ? api.call("tree.get", { workspaceId }, signal)
        : Promise.resolve({ nodes: [] }),
    [api, workspaceId, mode.kind],
  );
  const pathOptions = useMemo(() => {
    const nodes = tree.state.status === "success" ? tree.state.data.nodes : [];
    const folders = new Set<string>(["/"]);
    for (const node of nodes)
      if (node.type !== "file" && node.status === "active") folders.add(node.relativePath || "/");
    return [...folders].sort().map((p) => ({ value: p, label: p }));
  }, [tree.state]);

  const titleError = !title.trim()
    ? m.t("editor.titleRequired")
    : title.length > TITLE_MAX
      ? m.t("editor.titleTooLong", { max: TITLE_MAX })
      : null;
  const contentError = !content.trim() ? m.t("editor.contentRequired") : null;
  const pathProblem = mode.kind === "create" ? validatePath(path) : null;
  const pathError = pathProblem ? m.t(`editor.${pathProblem}`) : null;
  const invalid = Boolean(titleError || contentError || pathError);

  const save = async () => {
    setSubmitted(true);
    setFailure(null);
    if (invalid) return;
    setSaving(true);
    try {
      if (mode.kind === "create") {
        const result = await api.call("knowledge.create", {
          workspaceId,
          kind,
          path: path.trim(),
          title: title.trim(),
          content,
          ...(kind === "rule" ? { priority, scopeType } : {}),
          ...(kind === "skill" && description.trim() ? { description: description.trim() } : {}),
        });
        toast.show({
          title: m.t("editor.created", { kind: m.t(`kinds.title.${kind}`) }),
          description: hookIndexNote(m, result),
        });
        onSaved(result.id);
      } else if (existing) {
        const result = await api.call("knowledge.update", {
          workspaceId,
          kind,
          id: existing.item.id,
          expectedVersionId: existing.item.versionId,
          title: title.trim(),
          content,
          ...(kind === "rule" ? { priority } : {}),
          ...(kind === "skill" ? { description: description.trim() } : {}),
        });
        toast.show({ title: m.t("editor.savedVersion"), description: hookIndexNote(m, result) });
        onSaved(result.id);
      }
    } catch (error) {
      if (error instanceof LocalApiError && error.code === "conflict") {
        setFailure(m.t("editor.conflict"));
      } else {
        setFailure(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setSaving(false);
    }
  };

  const noun = m.t(`kinds.singular.${kind}`);
  const problems = [titleError, contentError, pathError].filter(Boolean).length;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      busy={saving}
      size="lg"
      title={
        mode.kind === "create"
          ? m.t("editor.newTitle", { kind: noun })
          : m.t("editor.editTitle", { kind: noun })
      }
      description={
        mode.kind === "create" ? m.t("editor.newDescription") : m.t("editor.editDescription")
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {m.t("editor.cancel")}
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={saving}>
            {mode.kind === "create" ? m.t("editor.create", { kind: noun }) : m.t("editor.save")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="pr-stack pr-stack--3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {submitted && invalid ? (
          <div role="alert" className="lc-form-summary">
            {m.plural("editor.fix", problems)}
          </div>
        ) : null}
        {failure ? (
          <Alert tone="danger" title={m.t("editor.notSaved")}>
            {failure}
          </Alert>
        ) : null}
        <FormField
          label={kind === "memory" ? m.t("editor.titleLabel") : m.t("editor.nameLabel")}
          required
          error={submitted ? titleError : undefined}
        >
          <TextInput
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            placeholder={
              kind === "rule" ? m.t("editor.rulePlaceholder") : m.t("editor.memoryPlaceholder")
            }
          />
        </FormField>
        {mode.kind === "create" ? (
          <FormField
            label={m.t("editor.ownerPath")}
            required
            description={m.t("editor.ownerPathHelp")}
            error={submitted ? pathError : undefined}
          >
            <Combobox
              value={path}
              onValueChange={setPath}
              options={pathOptions}
              creatable
              mono
              placeholder="/src/features"
            />
          </FormField>
        ) : null}
        {kind === "rule" ? (
          <div className="lc-form-row">
            <FormField label={m.t("editor.priority")} description={m.t("editor.priorityHelp")}>
              <Select
                value={priority}
                onChange={(e) => setPriority(e.target.value as RulePriority)}
                options={[
                  { value: "high", label: m.t("editor.high") },
                  { value: "medium", label: m.t("editor.medium") },
                  { value: "low", label: m.t("editor.low") },
                ]}
              />
            </FormField>
            {mode.kind === "create" ? (
              <FormField label={m.t("editor.scope")} description={m.t("editor.scopeHelp")}>
                <Select
                  value={scopeType}
                  onChange={(e) => setScopeType(e.target.value as RuleScope)}
                  options={[
                    { value: "folder", label: m.t("editor.folder") },
                    { value: "file_type", label: m.t("editor.fileType") },
                    { value: "project", label: m.t("editor.project") },
                  ]}
                />
              </FormField>
            ) : null}
          </div>
        ) : null}
        {kind === "skill" ? (
          <FormField
            label={m.t("editor.description")}
            optional
            description={m.t("editor.descriptionHelp")}
          >
            <TextInput value={description} onChange={(e) => setDescription(e.target.value)} />
          </FormField>
        ) : null}
        <FormField
          label={m.t("editor.content")}
          required
          description={m.t("editor.contentHelp")}
          error={submitted ? contentError : undefined}
        >
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={10} mono />
        </FormField>
      </form>
    </Dialog>
  );
}
