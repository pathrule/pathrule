// SPDX-License-Identifier: Apache-2.0
/**
 * Navigation ROI aggregator (pure).
 *
 * Consumes the hook's `navigation.jsonl` lines (route "emitted"/"followed"
 * events + per-session "session" summaries) and produces the numbers the ROI
 * surface shows: route accuracy, routed-vs-unrouted session profiles, and the
 * measured deltas. All measurement comes from the user's OWN sessions — no
 * synthetic benchmark required. Pure and deterministic: no I/O, no clock.
 */

export interface NavigationEvent {
  t: "emitted" | "followed" | "session";
  session_id?: string | null;
  paths?: string[];
  path?: string;
  file_tool_count?: number;
  routed?: boolean;
  followed?: boolean;
  prompts?: number;
  duration_s?: number | null;
}

export interface NavigationRoiSummary {
  routes_emitted: number;
  routes_followed: number;
  /** followed / emitted, 0..1. The headline routing-quality metric. */
  route_accuracy: number;
  sessions_total: number;
  sessions_routed: number;
  sessions_unrouted: number;
  avg_tools_routed: number | null;
  avg_tools_unrouted: number | null;
  avg_duration_routed_s: number | null;
  avg_duration_unrouted_s: number | null;
  /** (unrouted - routed) / unrouted, 0..1; null until both cohorts exist. */
  tool_reduction: number | null;
  duration_reduction: number | null;
}

export function parseNavigationLines(jsonl: string): NavigationEvent[] {
  const out: NavigationEvent[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as NavigationEvent;
      if (o && (o.t === "emitted" || o.t === "followed" || o.t === "session")) out.push(o);
    } catch {
      /* skip malformed telemetry lines */
    }
  }
  return out;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function reduction(unrouted: number | null, routed: number | null): number | null {
  if (unrouted === null || routed === null || unrouted <= 0) return null;
  return Math.max(0, (unrouted - routed) / unrouted);
}

export function summarizeNavigationRoi(events: NavigationEvent[]): NavigationRoiSummary {
  const emitted = events.filter((e) => e.t === "emitted").length;
  const followed = events.filter((e) => e.t === "followed").length;
  const sessions = events.filter((e) => e.t === "session");
  const routed = sessions.filter((s) => s.routed === true);
  const unrouted = sessions.filter((s) => s.routed !== true);

  const tools = (xs: NavigationEvent[]) =>
    mean(xs.map((s) => s.file_tool_count).filter((v): v is number => typeof v === "number"));
  const durations = (xs: NavigationEvent[]) =>
    mean(xs.map((s) => s.duration_s).filter((v): v is number => typeof v === "number"));

  const avgToolsRouted = tools(routed);
  const avgToolsUnrouted = tools(unrouted);
  const avgDurRouted = durations(routed);
  const avgDurUnrouted = durations(unrouted);

  return {
    routes_emitted: emitted,
    routes_followed: followed,
    route_accuracy: emitted > 0 ? Math.min(1, followed / emitted) : 0,
    sessions_total: sessions.length,
    sessions_routed: routed.length,
    sessions_unrouted: unrouted.length,
    avg_tools_routed: avgToolsRouted,
    avg_tools_unrouted: avgToolsUnrouted,
    avg_duration_routed_s: avgDurRouted,
    avg_duration_unrouted_s: avgDurUnrouted,
    tool_reduction: reduction(avgToolsUnrouted, avgToolsRouted),
    duration_reduction: reduction(avgDurUnrouted, avgDurRouted),
  };
}
