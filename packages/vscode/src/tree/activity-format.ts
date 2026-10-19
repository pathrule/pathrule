// SPDX-License-Identifier: Apache-2.0
// Pure activity-feed row formatting (design spec §2 view inventory).

import type { Activity } from "@pathrule/core";

export interface ActivityRowModel {
  label: string;
  description: string;
  tooltip: string;
}

export function activityRow(activity: Activity, nowMs: number): ActivityRowModel {
  const label = activity.taskSummary?.trim() || fallbackLabel(activity);
  const when = relativeTime(Date.parse(activity.createdAt), nowMs);
  const where = activity.nodePath && activity.nodePath !== "/" ? activity.nodePath : "";
  return {
    label,
    description: [when, where].filter(Boolean).join(" · "),
    tooltip: [activity.domain, activity.action].filter(Boolean).join("/") || "activity",
  };
}

function fallbackLabel(activity: Activity): string {
  const pair = [activity.domain, activity.action].filter(Boolean).join(" ");
  return pair || "Activity";
}

export function relativeTime(thenMs: number, nowMs: number): string {
  if (!Number.isFinite(thenMs)) return "";
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.round(d / 7);
  return `${w}w ago`;
}
