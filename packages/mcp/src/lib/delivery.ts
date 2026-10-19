// SPDX-License-Identifier: Apache-2.0
// The MCP server's side of the session delivery ledger (protocol/session-delivery.ts).
//
// What a tool returns to the agent is delivered: the server records it, so the hook does not inject
// the same body again on the next prompt. A body the hook already delivered in this session is
// returned by reference from `get_context`'s passive preload, but never withheld from an explicit
// read: a person or agent asking for an item by id always gets it.
import {
  activeSessionStem,
  appendDeliveryReceipts,
  deliveryContentHash,
  readDeliveryLedger,
} from "@pathrule/integrations/native/delivery-ledger.js";
import { isDelivered, type DeliveryItemKind, type DeliveryScope } from "@pathrule/protocol/session-delivery.js";

import { resolveClientId } from "../client-identity.js";

/** The session a call belongs to: the id it passed, else the one active hook session. */
export async function deliverySession(workspaceId: string | null | undefined, sessionId?: string | null): Promise<string | null> {
  if (!workspaceId) return null;
  const given = sessionId?.trim();
  if (given) return given;
  return activeSessionStem(workspaceId).catch(() => null);
}

/** Whether this exact body already reached the session in its current epoch, by any channel. */
export async function alreadyDelivered(
  workspaceId: string,
  session: string,
  kind: DeliveryItemKind,
  id: string,
  content: string,
): Promise<boolean> {
  const state = await readDeliveryLedger(workspaceId, session);
  return isDelivered(state, kind, id, deliveryContentHash(content));
}

export interface McpDelivery {
  kind: DeliveryItemKind;
  id: string;
  content: string;
  scope?: DeliveryScope;
  nodePath?: string | null;
}

/** Record bodies a tool result carried. Best effort: never fails the tool call. */
export async function recordMcpDeliveries(args: {
  workspaceId: string | null | undefined;
  session: string | null;
  event: string;
  items: McpDelivery[];
  repeat?: boolean;
}): Promise<void> {
  if (!args.workspaceId || !args.session || args.items.length === 0) return;
  try {
    const state = await readDeliveryLedger(args.workspaceId, args.session);
    await appendDeliveryReceipts({
      workspaceId: args.workspaceId,
      sessionId: args.session,
      channel: "mcp",
      epoch: state.epoch,
      client: resolveClientId() ?? undefined,
      receipts: args.items.map((item) => ({
        item: {
          kind: item.kind,
          id: item.id,
          hash: deliveryContentHash(item.content),
          scope: item.scope ?? "project",
          node_path: item.nodePath ?? null,
        },
        provenance: { source: "request" },
        status: "confirmed",
        event: args.event,
        ...(args.repeat ? { repeat: true } : {}),
      })),
    });
  } catch {
    // a ledger that cannot be written costs at most one repeated delivery
  }
}

/** Record an explicit read by id (never suppressed): the body reached the agent. */
export async function recordExplicitRead(
  workspaceId: string | null | undefined,
  kind: "memory" | "rule" | "skill",
  item: { id: string; content: string; node_path?: string | null },
  event: string,
): Promise<void> {
  if (!workspaceId || typeof item.content !== "string") return;
  await recordMcpDeliveries({
    workspaceId,
    session: await deliverySession(workspaceId),
    event,
    items: [{ kind, id: item.id, content: item.content, nodePath: item.node_path ?? null }],
  });
}
