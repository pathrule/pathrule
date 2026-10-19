// SPDX-License-Identifier: Apache-2.0
// The copy of a folder's Local knowledge to its Pathrule Cloud workspace, as `pathrule setup` and
// `init` run it once the folder is a Cloud folder. Local promises that its data stays on the machine,
// so nothing leaves without a separate, explicit yes: choosing Cloud for a folder never is one.
//
// - **Source:** the folder's Local workspace, dormant since the folder switched (resolveFolderMode's
//   `dormant.local`). Only that one; it is read, never written.
// - **Preview:** always said first: the items, what is kept and lost, and what does not fit the plan.
// - **Approval:** `--transfer` copies, `--no-transfer` does not. Otherwise a person at a terminal is
//   asked; anywhere else nothing is copied and the notice names the command. A no is remembered.
// - **Copy and resume:** create-only writes under ids derived from the item, so a second run copies
//   only what is missing. Every failure is reported; nothing is cut silently.
import type { CliNextStep } from "@pathrule/cli/output.js";
import { formatCount } from "@pathrule/cli/terminal/text.js";
import { localStoreExists, resolveFolderMode } from "@pathrule/core/workspace/folder-mode.js";

import { nativeCloudConfig } from "../../native/config.js";
import { knowledgeTransferVersion } from "../../native/client/project-backend.js";
import { readWorkspaceUsage, type CloudWorkspaceUsage } from "../../native/client/usage.js";
import { copyPlanned, type TransferBackend } from "./copy.js";
import {
  buildPreview,
  planItems,
  previewLines,
  transferItemId,
  type TransferPreview,
} from "./preview.js";
import { readLocalKnowledge, type LocalTransferSource } from "./source.js";
import {
  emptyTransferState,
  readTransferState,
  transferStatePath,
  writeTransferState,
  type TransferItemRecord,
  type TransferState,
} from "./state.js";

export const TRANSFER_COMMAND = "pathrule setup --cloud --transfer";
const RETRY_COMMAND = "pathrule setup --cloud";

/**
 * - `copied`: every item of the Local workspace is on Pathrule Cloud.
 * - `incomplete`: some are not (failed, too large, or not attempted); `result` says which.
 * - `declined`: the person said no now (or `--no-transfer`); `declined_earlier`: a no on file.
 * - `approval_required`: nothing could ask, and nothing was copied.
 * - `unavailable`: the workspace's Cloud does not take copies; nothing was copied.
 * - `nothing_to_copy`: the Local workspace holds no memories, rules or skills.
 */
export type TransferStatus =
  | "copied"
  | "incomplete"
  | "declined"
  | "declined_earlier"
  | "approval_required"
  | "unavailable"
  | "nothing_to_copy";

interface ItemReport {
  kind: string;
  local_id: string;
  title: string;
  code?: string;
  message?: string;
}

export interface TransferData {
  status: TransferStatus;
  source: { local_workspace_id: string; root: string };
  target: { workspace_id: string; workspace_name: string };
  state_file: string;
  preview: TransferPreview | null;
  result: {
    total: number;
    copied: number;
    copied_now: number;
    failed: ItemReport[];
    too_large: ItemReport[];
    not_attempted: ItemReport[];
  } | null;
}

export interface TransferOutcome {
  data: TransferData;
  lines: string[];
  exitCode: number;
  next: CliNextStep[];
}

export interface TransferInput {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The Cloud workspace the folder is attached to. */
  target: { workspaceId: string; name: string; organizationId: string };
  /** Its Project backend, resolved only when there is something to copy. */
  backend: () => Promise<TransferBackend>;
  /** The person's requests on Pathrule Cloud. */
  request: <T>(path: string) => Promise<T>;
  /** `--transfer` (true), `--no-transfer` (false), or neither (null). */
  answer: boolean | null;
  /**
   * Asks a person at a terminal, after showing them `preview`; null where nothing can ask. The
   * caller shows what it printed before the question first, so the preview reads in order.
   */
  ask: ((question: string, preview: readonly string[]) => Promise<boolean>) | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** The Local workspace to copy; by default the folder's dormant one (resolveFolderMode). */
  local?: { workspaceId: string; localRootPath: string } | null;
}

/** The folder's dormant Local workspace: the one it had before it became a Cloud folder. */
export function dormantLocalWorkspace(
  cwd: string,
  env: NodeJS.ProcessEnv,
  cloudWorkspaceId: string,
): { workspaceId: string; localRootPath: string } | null {
  const folder = resolveFolderMode(cwd, env, { cloudAvailable: nativeCloudConfig(env) !== null });
  const local = folder.dormant.local;
  if (!local || local.workspaceId === cloudWorkspaceId || !localStoreExists(local.workspaceId, env))
    return null;
  return { workspaceId: local.workspaceId, localRootPath: local.localRootPath };
}

async function organizationName(
  request: TransferInput["request"],
  id: string,
): Promise<string | null> {
  const { items } = await request<{ items: { id: string; name: string }[] }>("/v1/organizations");
  return items.find((o) => o.id === id)?.name ?? null;
}

const items = (n: number) => `${formatCount(n)} ${n === 1 ? "item" : "items"}`;
const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

function report(records: Array<[LocalTransferSource["items"][number], TransferItemRecord]>) {
  return records.map(([item, r]) => ({
    kind: item.kind,
    local_id: item.localId,
    title: item.title,
    ...(r.code ? { code: r.code } : {}),
    ...(r.message ? { message: r.message } : {}),
  }));
}

/**
 * Copies the folder's Local knowledge to its Cloud workspace when the person approves it; null when
 * the folder has no Local workspace to copy.
 */
export async function transferLocalKnowledge(
  input: TransferInput,
): Promise<TransferOutcome | null> {
  const { env, target } = input;
  const now = () => (input.now ?? (() => new Date()))().toISOString();
  const local =
    input.local !== undefined
      ? input.local
      : dormantLocalWorkspace(input.cwd, env, target.workspaceId);
  if (!local) return null;

  const stateFile = transferStatePath(env, local.workspaceId, target.workspaceId);
  const base = {
    source: { local_workspace_id: local.workspaceId, root: local.localRootPath },
    target: { workspace_id: target.workspaceId, workspace_name: target.name },
    state_file: stateFile,
  };
  const outcome = (
    status: TransferStatus,
    lines: string[],
    rest: Partial<Pick<TransferData, "preview" | "result">> & {
      exitCode?: number;
      next?: CliNextStep[];
    } = {},
  ): TransferOutcome => ({
    data: { status, ...base, preview: rest.preview ?? null, result: rest.result ?? null },
    lines,
    exitCode: rest.exitCode ?? 0,
    next: rest.next ?? [],
  });
  const copyLater = { label: "Copy this folder's Local knowledge", command: TRANSFER_COMMAND };
  let state: TransferState | null = await readTransferState(
    env,
    local.workspaceId,
    target.workspaceId,
  );
  const decline = async () => {
    state ??= emptyTransferState(local.workspaceId, target.workspaceId, now());
    state.declined_at = now();
    state.updated_at = state.declined_at;
    await writeTransferState(env, state);
  };

  if (input.answer === false) {
    await decline();
    return outcome("declined", [
      `This folder's Local knowledge was not copied (--no-transfer); its Local workspace stays on this machine, unchanged. To copy it later: ${TRANSFER_COMMAND}`,
    ]);
  }
  if (input.answer === null && state?.declined_at)
    return outcome("declined_earlier", [
      `You chose not to copy this folder's Local knowledge to Pathrule Cloud (${state.declined_at.slice(0, 10)}); nothing was copied. To copy it: ${TRANSFER_COMMAND}`,
    ]);

  const source = await readLocalKnowledge(env, local);
  if (source.items.length === 0)
    return outcome("nothing_to_copy", [
      "This folder's Local workspace has no memories, rules or skills to copy.",
    ]);
  const idOf = (item: LocalTransferSource["items"][number]) =>
    transferItemId(local.workspaceId, item.kind, item.localId, target.workspaceId);
  const copiedBefore = new Set(
    Object.entries(state?.items ?? {})
      .filter(([, r]) => r.status === "copied")
      .map(([id]) => id),
  );
  const pending = source.items.filter((item) => !copiedBefore.has(idOf(item)));
  const alreadyCopied = source.items.length - pending.length;
  if (pending.length === 0)
    return outcome("copied", [
      `All ${items(source.items.length)} of this folder's Local knowledge are on Pathrule Cloud in "${target.name}".`,
    ]);

  const backend = await input.backend();
  const version = knowledgeTransferVersion(backend);
  let usage: CloudWorkspaceUsage | null = null;
  let usageError: string | null = null;
  let cloudPaths: Set<string> | null = null;
  if (version > 0) {
    usage = await readWorkspaceUsage(input.request, target.workspaceId).catch((err: unknown) => {
      usageError = why(err);
      return null;
    });
    cloudPaths = await backend
      .getTree(target.workspaceId)
      .then((nodes) => new Set(nodes.map((n) => n.relativePath)))
      .catch(() => null);
  }
  const planned = planItems(
    pending,
    { local: local.workspaceId, cloud: target.workspaceId },
    usage,
  );
  const preview = buildPreview({
    planned,
    source,
    target: {
      workspace_id: target.workspaceId,
      workspace_name: target.name,
      organization_id: target.organizationId,
      organization_name: await organizationName(input.request, target.organizationId).catch(
        () => null,
      ),
    },
    usage,
    usageError,
    cloudPaths,
    alreadyCopied,
  });
  const shown = previewLines(preview);

  if (version === 0)
    return outcome(
      "unavailable",
      [
        ...shown,
        `Nothing was copied: Pathrule Cloud does not take copies of Local knowledge for "${target.name}" yet. This folder's Local workspace stays on this machine, unchanged.`,
      ],
      // Refused what the person asked for; otherwise only said.
      { preview, exitCode: input.answer === true ? 1 : 0 },
    );

  const copyable = planned.filter((p) => !p.blocked);
  // A run that stopped or failed before: the question offers to continue it.
  const unfinished = Object.values(state?.items ?? {}).some(
    (r) => r.status === "failed" || r.status === "not_attempted",
  );
  let previewShown = false;
  let approved = input.answer === true;
  if (!approved && copyable.length > 0) {
    if (!input.ask)
      return outcome(
        "approval_required",
        [
          ...shown,
          `Nothing was copied: copying needs your approval, and nothing could ask here. To copy: ${TRANSFER_COMMAND}`,
        ],
        { preview, next: [copyLater] },
      );
    const question = unfinished
      ? `Continue copying the ${items(copyable.length)} not yet on Pathrule Cloud to "${target.name}"?`
      : `Copy these ${items(copyable.length)} to "${target.name}"?`;
    approved = await input.ask(question, shown);
    previewShown = true;
    if (!approved) {
      await decline();
      return outcome(
        "declined",
        [
          `Nothing was copied, and you will not be asked again. To copy it later: ${TRANSFER_COMMAND}`,
        ],
        { preview },
      );
    }
  }

  // Approved, or nothing left that could be copied: record what cannot be, then copy the rest.
  const run: TransferState =
    state ?? emptyTransferState(local.workspaceId, target.workspaceId, now());
  run.declined_at = null;
  for (const p of planned.filter((q) => q.blocked)) {
    run.items[p.id] = {
      kind: p.item.kind,
      local_id: p.item.localId,
      title: p.item.title,
      status: "too_large",
      code: p.blocked!.reason,
      message: p.blocked!.detail,
      at: now(),
    };
  }
  run.updated_at = now();
  await writeTransferState(env, run);
  const result = await copyPlanned({
    backend,
    cloudWorkspaceId: target.workspaceId,
    planned: copyable,
    state: run,
    save: (s) => writeTransferState(env, s).then(() => undefined),
    transferredAt: now(),
    sleep: input.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now,
  });

  const records = source.items.map(
    (item) => [item, run.items[idOf(item)]] as [typeof item, TransferItemRecord | undefined],
  );
  const by = (status: TransferItemRecord["status"]) =>
    records.filter((r): r is [(typeof r)[0], TransferItemRecord] => r[1]?.status === status);
  const copied = by("copied").length;
  const failed = by("failed");
  const tooLarge = by("too_large");
  const notAttempted = by("not_attempted");
  const total = source.items.length;
  const complete = copied === total;
  const lines = [
    `Copied ${formatCount(copied)} of ${formatCount(total)} to "${target.name}"${copied !== result.copied ? ` (${formatCount(result.copied)} in this run)` : ""}.`,
  ];
  if (complete)
    lines.push(`All ${items(total)} of this folder's Local knowledge are on Pathrule Cloud.`);
  if (failed.length > 0)
    lines.push(
      `Failed (${formatCount(failed.length)}):`,
      ...failed.map(([item, r]) => `- ${item.kind} "${item.title}": ${r.code}: ${r.message}`),
    );
  if (tooLarge.length > 0)
    lines.push(
      `Cannot be copied, over a limit (${formatCount(tooLarge.length)}); nothing was shortened:`,
      ...tooLarge.map(([item, r]) => `- ${item.kind} "${item.title}": ${r.message ?? r.code}`),
    );
  if (notAttempted.length > 0) {
    const stop = notAttempted[0]![1];
    lines.push(
      `Not attempted (${formatCount(notAttempted.length)}): the copy stopped at ${stop.code}: ${stop.message}`,
      ...notAttempted.map(([item]) => `- ${item.kind} "${item.title}"`),
    );
  }
  const retry = failed.length > 0 || notAttempted.length > 0;
  if (retry)
    lines.push(
      `To copy what is missing: ${RETRY_COMMAND} (nothing already on Pathrule Cloud is copied twice or overwritten).`,
    );
  if (!complete) lines.push("Your Local workspace keeps every item, unchanged.");
  return outcome(complete ? "copied" : "incomplete", previewShown ? lines : [...shown, ...lines], {
    preview,
    result: {
      total,
      copied,
      copied_now: result.copied,
      failed: report(failed),
      too_large: report(tooLarge),
      not_attempted: report(notAttempted),
    },
    // Only a copy the person asked for fails the command; one with nothing it could send only says so.
    exitCode: !complete && (input.answer === true || previewShown) ? 1 : 0,
    next: retry ? [{ label: "Copy what is missing", command: RETRY_COMMAND }] : [],
  });
}
