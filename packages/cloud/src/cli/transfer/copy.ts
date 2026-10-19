// SPDX-License-Identifier: Apache-2.0
// The copy of approved Local items to a Pathrule Cloud workspace's Project backend. Every write is
// create-only under the item's transfer id (`ifAbsent`), so a run that is retried, resumed or run
// twice never overwrites an item already on Cloud and never makes a second one. Each item's result
// is saved as soon as it is known, so a run that dies resumes where it stopped.
import type { KnowledgeBackend } from "@pathrule/core/backend/knowledge-backend.js";
import type { KnowledgeOrigin } from "@pathrule/protocol/content-types.js";
import type { NodeType } from "@pathrule/protocol/node-types.js";

import { CloudHttpError } from "../../native/client/http.js";
import type { PlannedItem } from "./preview.js";
import type { TransferItemRecord, TransferItemStatus, TransferState } from "./state.js";

/** What the copy needs of the workspace's Project backend on Pathrule Cloud. */
export type TransferBackend = Pick<
  KnowledgeBackend,
  "capabilities" | "ensureNodeForPath" | "writeMemory" | "writeRule" | "writeSkill" | "getTree"
>;

/** A refusal after which nothing more can be written: the plan is full. */
export const LIMIT_CODES: ReadonlySet<string> = new Set([
  "storage_quota_reached",
  "index_budget_reached",
  "node_limit_reached",
]);
const TOO_LARGE_CODES: ReadonlySet<string> = new Set(["item_too_large", "payload_too_large"]);
/** Retries of one write after a network failure or a server error; a refusal is final. */
const RETRIES = 2;

export interface Refusal {
  code: string;
  message: string;
  /** Every later item would meet it too: the plan is full, the session or the access is gone. */
  stop: boolean;
  tooLarge: boolean;
}

const transient = (err: unknown): boolean =>
  err instanceof CloudHttpError ? err.status >= 500 : err instanceof TypeError;

export function refusalOf(err: unknown): Refusal {
  if (err instanceof CloudHttpError) {
    const code =
      err.code ??
      (err.status === 401
        ? "not_authenticated"
        : err.status === 403
          ? "not_authorized"
          : err.status === 413
            ? "payload_too_large"
            : `http_${err.status}`);
    return {
      code,
      message: err.message,
      stop: LIMIT_CODES.has(code) || err.status === 401 || err.status === 403,
      tooLarge: TOO_LARGE_CODES.has(code) || err.status === 413,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  // fetch's TypeError: Pathrule Cloud could not be reached, even after the retries.
  if (err instanceof TypeError)
    return { code: "unreachable", message, stop: true, tooLarge: false };
  return { code: "error", message, stop: false, tooLarge: false };
}

async function withRetries<T>(run: () => Promise<T>, sleep: (ms: number) => Promise<void>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= RETRIES || !transient(err)) throw err;
      await sleep(500 * 2 ** attempt);
    }
  }
}

export interface CopyResult {
  attempted: number;
  copied: number;
  /** The refusal that stopped the run; null when it went through every item. */
  stopped: Refusal | null;
}

export async function copyPlanned(input: {
  backend: TransferBackend;
  cloudWorkspaceId: string;
  /** The items to write, none of them over a limit. */
  planned: readonly PlannedItem[];
  state: TransferState;
  save: (state: TransferState) => Promise<void>;
  transferredAt: string;
  sleep: (ms: number) => Promise<void>;
  now: () => string;
}): Promise<CopyResult> {
  const { backend, state } = input;
  const ws = input.cloudWorkspaceId;
  const nodes = new Map<string, string>();
  const record = (
    p: PlannedItem,
    status: TransferItemStatus,
    extra: Pick<TransferItemRecord, "code" | "message"> = {},
  ) => {
    const at = input.now();
    state.items[p.id] = {
      kind: p.item.kind,
      local_id: p.item.localId,
      title: p.item.title,
      status,
      ...extra,
      at,
    };
    state.updated_at = at;
  };
  const nodeFor = async (path: string, type: NodeType | null): Promise<string> => {
    const known = nodes.get(path);
    if (known) return known;
    const node = await withRetries(
      () => backend.ensureNodeForPath(ws, path, type ?? undefined),
      input.sleep,
    );
    nodes.set(path, node.id);
    return node.id;
  };
  const write = async (p: PlannedItem, nodeId: string | undefined): Promise<void> => {
    const { item } = p;
    const origin: KnowledgeOrigin = {
      kind: "local-transfer",
      transferredAt: input.transferredAt,
      sourceCreatedAt: item.createdAt,
      sourceUpdatedAt: item.updatedAt,
      ...(item.kind === "skill" ? { sourceVersion: item.version } : {}),
    };
    const common = {
      workspaceId: ws,
      id: p.id,
      ...(nodeId ? { nodeId } : {}),
      origin,
      ifAbsent: true,
    };
    if (item.kind === "memory")
      await backend.writeMemory({
        ...common,
        title: item.title,
        content: item.content,
        source: item.source,
        relatedPaths: item.relatedPaths,
      });
    else if (item.kind === "rule")
      await backend.writeRule({
        ...common,
        name: item.title,
        content: item.content,
        scopeType: item.scopeType,
        priority: item.priority,
        ...(item.constraints.length > 0 ? { constraints: item.constraints } : {}),
      });
    else
      await backend.writeSkill({
        ...common,
        name: item.title,
        content: item.content,
        description: item.description,
        source: item.source,
        githubUrl: item.githubUrl,
        tags: item.tags,
      });
  };

  let copied = 0;
  let attempted = 0;
  for (const [i, p] of input.planned.entries()) {
    attempted += 1;
    try {
      const nodeId = p.item.path === null ? undefined : await nodeFor(p.item.path, p.item.nodeType);
      await withRetries(() => write(p, nodeId), input.sleep);
      record(p, "copied");
      copied += 1;
    } catch (err) {
      const refusal = refusalOf(err);
      record(p, refusal.tooLarge ? "too_large" : "failed", {
        code: refusal.code,
        message: refusal.message,
      });
      if (refusal.stop) {
        for (const rest of input.planned.slice(i + 1))
          record(rest, "not_attempted", { code: refusal.code, message: refusal.message });
        await input.save(state);
        return { attempted, copied, stopped: refusal };
      }
    }
    await input.save(state);
  }
  return { attempted, copied, stopped: null };
}
