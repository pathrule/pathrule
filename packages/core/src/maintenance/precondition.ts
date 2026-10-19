// SPDX-License-Identifier: Apache-2.0
// The precondition a maintenance proposal carries for each target: a hash of the content it was
// built against. The engine computes it when it proposes; the host recomputes it before it applies,
// so a target that changed in between is refused.
import type {
  MaintenanceContentKind,
  MaintenanceContentSnapshot,
  MaintenanceProposalOperation,
} from "@pathrule/protocol/maintenance.js";
import { maintenanceHash } from "./canonical.js";

export function maintenanceTargetKind(
  operation: MaintenanceProposalOperation,
): MaintenanceContentKind | null {
  if (operation.kind.endsWith("_memory")) return "memory";
  if (operation.kind.endsWith("_rule")) return "rule";
  if (operation.kind.endsWith("_skill")) return "skill";
  return null;
}

export function maintenancePreconditionHash(snapshot: MaintenanceContentSnapshot): string {
  return `sha256:${maintenanceHash({
    kind: snapshot.kind,
    id: snapshot.id,
    workspaceId: snapshot.workspaceId,
    label: snapshot.label,
    body: snapshot.body,
    versionId: snapshot.versionId,
    versionNumber: snapshot.versionNumber,
  })}`;
}
