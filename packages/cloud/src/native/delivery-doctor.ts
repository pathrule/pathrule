// SPDX-License-Identifier: Apache-2.0
// The doctor's `deliveries_report` check: whether the knowledge this machine's agent sessions
// received for the current folder reaches Pathrule Cloud's Overview.
//
// The hook writes a receipt per delivery (`cache/<ws>/deliveries/<session>.jsonl`). The Cloud counts
// only what ./delivery-reporter.ts reports, and that reports only the folders attached to the native
// account. A folder served from a local store records deliveries nobody reports, and the Cloud
// console shows none: this check says so, instead of leaving the two to disagree in silence.
import { readWorkspaceKnowledgeDeliveries } from "@pathrule/integrations/native/delivery-ledger.js";

import { indexedFoldersFor } from "./auto-attach.js";
import { readReportedDeliveries } from "./delivery-reporter.js";
import type { NativeWorkspaceEntry } from "./workspaces.js";

/** The window the check counts, the console's default range. */
export const DELIVERY_DOCTOR_WINDOW_MS = 30 * 86_400_000;

export interface DeliveryDoctorCheck {
  name: "deliveries_report";
  status: "pass" | "warn";
  detail: string;
}

/**
 * The workspace whose hook index roots this folder (the nearest root, the newest index there), for
 * a folder no attachment names: the index the hook serves it from, whatever store wrote it.
 */
export async function indexedWorkspaceFor(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  return (await indexedFoldersFor(cwd, env))[0]?.workspaceId ?? null;
}

/**
 * Whether this folder's deliveries reach Pathrule Cloud. `attached` is the native attachment
 * serving the folder, when there is one (workspaces.ts nativeWorkspaceFor).
 */
export async function deliveryReportCheck(input: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  attached: NativeWorkspaceEntry | null;
  now?: number;
}): Promise<DeliveryDoctorCheck> {
  const now = input.now ?? Date.now();
  const name = "deliveries_report" as const;
  const workspaceId =
    input.attached?.workspace_id ?? (await indexedWorkspaceFor(input.cwd, input.env));
  if (!workspaceId) {
    return { name, status: "pass", detail: "no knowledge index serves this folder yet" };
  }
  const recorded = (
    await readWorkspaceKnowledgeDeliveries(workspaceId, now - DELIVERY_DOCTOR_WINDOW_MS, input.env)
  ).length;
  if (recorded === 0) {
    return { name, status: "pass", detail: "none recorded here in 30 days" };
  }
  if (!input.attached) {
    // The next command here attaches the folder itself when the Cloud knows it (auto-attach.ts).
    return {
      name,
      status: "warn",
      detail: `${recorded} recorded here in 30 days, none reported to Pathrule Cloud: this folder is not attached yet (pathrule sync attaches it)`,
    };
  }
  const reported = await readReportedDeliveries(workspaceId, input.env);
  if (reported.items === 0) {
    return {
      name,
      status: "warn",
      detail: `${recorded} recorded here in 30 days, none reported to Pathrule Cloud yet${
        reported.pending
          ? " (a report is waiting for the Cloud's answer)"
          : " (a report goes after the next MCP tool call)"
      }`,
    };
  }
  return {
    name,
    status: "pass",
    detail: `${recorded} recorded here in 30 days, ${reported.items} reported to Pathrule Cloud`,
  };
}
