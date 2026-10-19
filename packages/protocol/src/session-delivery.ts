// SPDX-License-Identifier: Apache-2.0
/**
 * The session delivery ledger: what reached one agent session, shared by every channel that
 * delivers knowledge to it (the hook and the MCP server).
 *
 * One append-only JSON-lines file per session, `<PATHRULE_HOME>/cache/<workspace>/deliveries/
 * <session>.jsonl`. A channel appends a receipt only for content that actually left it (the hook
 * after its output was written, the MCP server when it returns a result); selection alone is never
 * a delivery. A context reset (compaction, clear, resume, fork) starts a new epoch, and only the
 * current epoch's receipts count: what the agent saw before a compaction is gone from its window.
 *
 * The hook carries a plain-JS twin of the parsing below (it cannot import), pinned by
 * `session-delivery-contract.test.ts` in @pathrule/integrations.
 */

export const SESSION_DELIVERY_SCHEMA = 1;
export const SESSION_DELIVERY_DIR = "deliveries";
/** A ledger read past this many bytes reads only its tail: a session never needs more. */
export const SESSION_DELIVERY_MAX_READ_BYTES = 512 * 1024;

export type DeliveryChannel = "hook" | "mcp";
export type DeliveryScope = "project" | "user" | "team";
export type DeliveryItemKind = "memory" | "rule" | "skill" | "protocol" | "profile" | "guidance" | "advisory";
export type DeliveryStatus = "attempted" | "confirmed" | "failed";
export type DeliveryResetReason = "startup" | "resume" | "clear" | "compact" | "fork";

export interface DeliveryItem {
  kind: DeliveryItemKind;
  id: string;
  /** Content hash or version of what was delivered; null when the channel has none. */
  hash: string | null;
  scope: DeliveryScope;
  node_path?: string | null;
}

export interface DeliveryProvenance {
  /** Where the delivered content was read from. */
  source: "hook-index" | "local-store" | "cloud" | "request";
  /** The knowledge's own authority, when the source carries one. */
  authority?: "human" | "verified" | "inferred";
}

export interface DeliveryReceipt {
  v: typeof SESSION_DELIVERY_SCHEMA;
  type: "receipt";
  at: string;
  workspace_id: string;
  session_id: string;
  epoch: number;
  channel: DeliveryChannel;
  client?: string;
  /** The event or tool that carried it (`UserPromptSubmit`, `pathrule_read_memory`). */
  event?: string;
  item: DeliveryItem;
  provenance: DeliveryProvenance;
  status: DeliveryStatus;
  /** Why a delivery failed (`provider_limit`, `write_error`). */
  reason?: string;
  /** True when the content was sent again because someone asked for it explicitly. */
  repeat?: boolean;
}

export interface DeliveryEpoch {
  v: typeof SESSION_DELIVERY_SCHEMA;
  type: "epoch";
  at: string;
  workspace_id: string;
  session_id: string;
  epoch: number;
  reason: DeliveryResetReason;
}

export type DeliveryLedgerRecord = DeliveryReceipt | DeliveryEpoch;

export interface DeliveredEntry {
  hash: string | null;
  channel: DeliveryChannel;
  at: string;
  scope: DeliveryScope;
}

export interface DeliveryLedgerState {
  epoch: number;
  /** Current-epoch confirmed deliveries, keyed by `deliveryKey(kind, id)`. */
  delivered: Map<string, DeliveredEntry>;
}

export function deliveryKey(kind: DeliveryItemKind, id: string): string {
  return `${kind}:${id}`;
}

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Whether a session id may name a ledger file as it is. Others are hashed by the caller. */
export function isSafeSessionId(id: string): boolean {
  return SAFE_SESSION_ID.test(id) && id !== "." && id !== "..";
}

function isReceipt(value: unknown): value is DeliveryReceipt {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<DeliveryReceipt>;
  return (
    r.v === SESSION_DELIVERY_SCHEMA &&
    r.type === "receipt" &&
    typeof r.epoch === "number" &&
    (r.channel === "hook" || r.channel === "mcp") &&
    !!r.item &&
    typeof r.item.kind === "string" &&
    typeof r.item.id === "string" &&
    (r.status === "attempted" || r.status === "confirmed" || r.status === "failed")
  );
}

function isEpoch(value: unknown): value is DeliveryEpoch {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<DeliveryEpoch>;
  return e.v === SESSION_DELIVERY_SCHEMA && e.type === "epoch" && typeof e.epoch === "number";
}

/**
 * Fold ledger lines into the current epoch's confirmed deliveries. The highest epoch seen wins; a
 * later `failed` receipt for an item clears an earlier confirmation of the same hash (content that a
 * provider cut was not delivered), and a malformed line is skipped, never fatal.
 */
export function foldDeliveryLedger(lines: readonly string[]): DeliveryLedgerState {
  const records: DeliveryLedgerRecord[] = [];
  let epoch = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isEpoch(parsed)) {
      epoch = Math.max(epoch, parsed.epoch);
      records.push(parsed);
    } else if (isReceipt(parsed)) {
      records.push(parsed);
    }
  }
  const delivered = new Map<string, DeliveredEntry>();
  for (const record of records) {
    if (record.type !== "receipt" || record.epoch !== epoch) continue;
    const key = deliveryKey(record.item.kind, record.item.id);
    if (record.status === "confirmed") {
      delivered.set(key, {
        hash: record.item.hash ?? null,
        channel: record.channel,
        at: record.at,
        scope: record.item.scope,
      });
    } else if (record.status === "failed") {
      const prior = delivered.get(key);
      if (prior && (prior.hash ?? null) === (record.item.hash ?? null)) delivered.delete(key);
    }
  }
  return { epoch, delivered };
}

/**
 * Whether this exact content already reached the session in the current epoch. An item delivered
 * with a different hash was edited since, so it is not delivered; when either side has no hash the
 * id alone decides.
 */
export function isDelivered(
  state: DeliveryLedgerState,
  kind: DeliveryItemKind,
  id: string,
  hash: string | null,
): boolean {
  const entry = state.delivered.get(deliveryKey(kind, id));
  if (!entry) return false;
  if (entry.hash === null || hash === null) return true;
  return entry.hash === hash;
}
