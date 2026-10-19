// SPDX-License-Identifier: Apache-2.0
/**
 * The hook's delivery ledger becomes the backend's delivery ledger.
 *
 * The standalone hook cannot open the database, so it appends what it delivered to
 * `<cache>/<workspace>/remedy-deliveries.jsonl`. Observation joins an agent's tool events to the
 * atoms delivered to that session through the `remedy_deliveries` table, which nothing but tests
 * wrote before this: every live observation found no delivered atom and was skipped. Draining the
 * file into the table first, in the same pass that ingests the observations, closes that gap.
 *
 * The file is claimed by an atomic rename before it is read, so two concurrent drains never count
 * a delivery twice, and a hook appending meanwhile writes a fresh file for the next pass. Lines
 * are metadata only (an atom fingerprint, a session id, a path), exactly what the table holds.
 */
import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const HOOK_DELIVERY_LEDGER = "remedy-deliveries.jsonl";

export interface DeliveryRecorder {
  recordRemedyDelivery(input: { workspaceId: string; atomId: string; sessionId?: string | null; path?: string | null; event?: string }): Promise<void>;
}

export async function drainHookDeliveries(store: DeliveryRecorder, workspaceId: string, cacheDir: string): Promise<number> {
  const file = join(cacheDir, HOOK_DELIVERY_LEDGER);
  if (!existsSync(file)) return 0;
  const claimed = `${file}.${process.pid}.${Date.now()}.draining`;
  try {
    renameSync(file, claimed);
  } catch {
    return 0; // another drain claimed it, or it vanished: nothing of ours to read
  }
  let raw = "";
  try {
    raw = readFileSync(claimed, "utf8");
  } catch {
    return 0;
  }
  let recorded = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec["workspace_id"] !== workspaceId || typeof rec["atom_id"] !== "string" || rec["atom_id"] === "") continue;
    if (rec["event"] !== undefined && rec["event"] !== "delivered") continue;
    await store.recordRemedyDelivery({
      workspaceId,
      atomId: rec["atom_id"],
      sessionId: typeof rec["session_id"] === "string" ? rec["session_id"] : null,
      path: typeof rec["path"] === "string" ? rec["path"] : null,
      event: "delivered",
    });
    recorded += 1;
  }
  try {
    unlinkSync(claimed);
  } catch {
    // best effort: a leftover claimed file is never read again
  }
  return recorded;
}
