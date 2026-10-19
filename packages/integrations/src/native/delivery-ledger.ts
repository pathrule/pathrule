// SPDX-License-Identifier: Apache-2.0
// The session delivery ledger on disk (protocol/session-delivery.ts), for TypeScript channels (the
// MCP server). The hook carries its own plain-JS twin; session-delivery-contract.test.ts pins both.

import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { pathruleHome } from "@pathrule/core/storage/paths.js";

import {
  SESSION_DELIVERY_MAX_READ_BYTES,
  SESSION_DELIVERY_SCHEMA,
  foldDeliveryLedger,
  type DeliveryChannel,
  type DeliveryItem,
  type DeliveryLedgerState,
  type DeliveryProvenance,
  type DeliveryReceipt,
  type DeliveryStatus,
} from "@pathrule/protocol/session-delivery.js";
import {
  sessionKnowledgeDeliveries,
  type KnowledgeDelivery,
} from "@pathrule/protocol/delivery-stats.js";

import { deliveryLedgerPath } from "./home.js";

async function readTail(path: string, maxBytes: number): Promise<string> {
  const info = await stat(path);
  const start = Math.max(0, info.size - maxBytes);
  const handle = await open(path, "r");
  try {
    const length = info.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8");
    // A tail read starts mid-line: drop the partial first line.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

/** The current epoch's confirmed deliveries of one session. A missing ledger is an empty one. */
export async function readDeliveryLedger(
  workspaceId: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeliveryLedgerState> {
  try {
    const text = await readTail(
      deliveryLedgerPath(workspaceId, sessionId, env),
      SESSION_DELIVERY_MAX_READ_BYTES,
    );
    return foldDeliveryLedger(text.split("\n"));
  } catch {
    return foldDeliveryLedger([]);
  }
}

export interface DeliveryReceiptInput {
  item: DeliveryItem;
  provenance: DeliveryProvenance;
  status: DeliveryStatus;
  event?: string;
  reason?: string;
  repeat?: boolean;
}

/**
 * Append receipts for content this channel actually sent. Each line is one `appendFile` of a
 * complete record, so a reader in another process never sees half a receipt. Best effort: a ledger
 * that cannot be written costs at most one repeated delivery, never a failed tool call.
 */
export async function appendDeliveryReceipts(
  args: {
    workspaceId: string;
    sessionId: string;
    channel: DeliveryChannel;
    epoch: number;
    client?: string;
    receipts: DeliveryReceiptInput[];
    now?: Date;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (args.receipts.length === 0) return true;
  try {
    const path = deliveryLedgerPath(args.workspaceId, args.sessionId, env);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const at = (args.now ?? new Date()).toISOString();
    const lines = args.receipts.map((r) => {
      const receipt: DeliveryReceipt = {
        v: SESSION_DELIVERY_SCHEMA,
        type: "receipt",
        at,
        workspace_id: args.workspaceId,
        session_id: args.sessionId,
        epoch: args.epoch,
        channel: args.channel,
        ...(args.client ? { client: args.client } : {}),
        ...(r.event ? { event: r.event } : {}),
        item: r.item,
        provenance: r.provenance,
        status: r.status,
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.repeat ? { repeat: true } : {}),
      };
      return JSON.stringify(receipt);
    });
    await appendFile(path, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The one agent session a call without a session id belongs to: the single hook session of this
 * workspace active in the last five minutes. Two fresh sessions are ambiguous and answer null,
 * because receipts filed under the wrong session would suppress content the other one never got.
 */
export async function activeSessionStem(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): Promise<string | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspaceId)) return null;
  const dir = join(pathruleHome(env), "cache", workspaceId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const fresh: string[] = [];
  for (const name of names) {
    const m = name.match(/^session-([A-Za-z0-9._-]{1,128})\.json$/);
    if (!m) continue;
    try {
      if (now - (await stat(join(dir, name))).mtimeMs <= 5 * 60 * 1000) fresh.push(m[1] as string);
    } catch {
      // gone
    }
  }
  return fresh.length === 1 ? (fresh[0] as string) : null;
}

/** The content hash every channel uses for an item body (core's hook-index contentHash). */
export function deliveryContentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** The most session ledgers one statistics read opens, newest first: ledgers are never pruned. */
export const DELIVERY_STATS_MAX_SESSIONS = 5_000;

/**
 * Each session ledger of this workspace touched since `sinceMs`, newest first, with the workspace
 * items delivered into it (once per item, ./delivery-stats.ts in @pathrule/protocol). Past
 * DELIVERY_STATS_MAX_SESSIONS only the newest are opened.
 */
export async function readWorkspaceSessionDeliveries(
  workspaceId: string,
  sinceMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<{ session: string; mtime: number; deliveries: KnowledgeDelivery[] }>> {
  const dir = dirname(deliveryLedgerPath(workspaceId, "stats", env));
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const recent: Array<{ name: string; mtime: number }> = [];
  for (const name of names) {
    try {
      const mtime = (await stat(join(dir, name))).mtimeMs;
      if (mtime >= sinceMs) recent.push({ name, mtime });
    } catch {
      // removed while listing
    }
  }
  recent.sort((a, b) => b.mtime - a.mtime);
  const sessions: Array<{ session: string; mtime: number; deliveries: KnowledgeDelivery[] }> = [];
  for (const { name, mtime } of recent.slice(0, DELIVERY_STATS_MAX_SESSIONS)) {
    let text: string;
    try {
      text = await readTail(join(dir, name), SESSION_DELIVERY_MAX_READ_BYTES);
    } catch {
      continue;
    }
    const deliveries = sessionKnowledgeDeliveries(text.split("\n")).filter(
      (delivery) => Date.parse(delivery.at) >= sinceMs,
    );
    sessions.push({ session: name.slice(0, -".jsonl".length), mtime, deliveries });
  }
  return sessions;
}

/** Every workspace item delivered into this workspace's sessions since `sinceMs`. */
export async function readWorkspaceKnowledgeDeliveries(
  workspaceId: string,
  sinceMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KnowledgeDelivery[]> {
  const sessions = await readWorkspaceSessionDeliveries(workspaceId, sinceMs, env);
  return sessions.flatMap((entry) => entry.deliveries);
}
