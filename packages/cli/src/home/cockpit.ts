// SPDX-License-Identifier: Apache-2.0
// The project home once Pathrule is set up: a full-screen cockpit of panels, laid out
// to the terminal's size. Pure, so every size, colour and glyph set is tested without a terminal.
//
//   header      brand, workspace, mode, version
//   Knowledge   what the workspace holds, and where (the busiest paths as bars)   | Agents
//   Context     confirmed deliveries over the last 24 hours                        | Needs you
//   Activity    what agents logged, newest first
//   key bar     every action with its key
//
// The facts are the home's (./facts.ts) and keep its rules: a measured number with its scope,
// "reading…" while it loads, and a missing fact as words with its reason, never as a zero.
import { drawPanel, sideBySide, spread, type Panel, type PanelTone } from "../terminal/box.js";
import type { Style } from "../terminal/style.js";
import {
  formatAgo,
  formatCount,
  padEnd,
  tildePath,
  truncate,
  visibleWidth,
} from "../terminal/text.js";
import type { AgentFact, Fact, HomeSnapshot, PathCount } from "./facts.js";
import type { HomeAction } from "./render.js";

export interface CockpitContext {
  style: Style;
  columns: number;
  rows: number;
  now: number;
  homeDir: string | undefined;
}

export const COCKPIT_PANELS = ["knowledge", "agents", "context", "attention", "activity"] as const;
export type CockpitPanel = (typeof COCKPIT_PANELS)[number];

export interface CockpitState {
  /** The panel Tab has moved to; Enter opens it. */
  focus: CockpitPanel;
  /** A one-line message in place of the key hints (an unknown key, a finished action). */
  notice?: string | null;
}

/** The smallest terminal the cockpit lays out for; smaller ones get the linear home. */
export const COCKPIT_MIN_COLUMNS = 80;
export const COCKPIT_MIN_ROWS = 22;
/** Wider terminals get a cockpit this wide: panels stretched further only spread the same lines. */
export const COCKPIT_MAX_COLUMNS = 160;

/** Lines the Knowledge panel always gets (totals and a few bars), and the most it takes. */
const KNOWLEDGE_MIN = 7;
const KNOWLEDGE_MAX = 14;

export function fitsCockpit(columns: number, rows: number): boolean {
  return columns >= COCKPIT_MIN_COLUMNS && rows >= COCKPIT_MIN_ROWS;
}

// ── Facts as panel text ──────────────────────────────────────────────────────

/** A fact that is not measured, as the words a panel shows instead of its content. */
function missing<T>(fact: Fact<T>, style: Style): string[] | null {
  switch (fact.state) {
    case "measured":
      return null;
    case "loading":
      return [style.dim(`reading${style.glyph.ellipsis}`)];
    case "deferred":
      return [style.dim("not read yet"), style.dim("r reads it (starts the local Pathrule host)")];
    case "not_measured":
      return [style.dim(`not measured ${style.glyph.dot} ${fact.reason}`)];
    case "unavailable":
      return [style.dim(fact.reason)];
  }
}

/** Workspace paths grouped to their first two segments ("/packages/cli"), busiest first. */
export function busiestAreas(paths: readonly PathCount[]): Array<{ area: string; items: number }> {
  const totals = new Map<string, number>();
  for (const p of paths) {
    const segments = p.path.split("/").filter(Boolean);
    const area = segments.length === 0 ? "/" : `/${segments.slice(0, 2).join("/")}`;
    totals.set(area, (totals.get(area) ?? 0) + p.memories + p.rules + p.skills);
  }
  return [...totals.entries()]
    .filter(([, items]) => items > 0)
    .map(([area, items]) => ({ area, items }))
    .sort((a, b) => b.items - a.items || a.area.localeCompare(b.area));
}

function knowledgeLines(
  snapshot: HomeSnapshot,
  ctx: CockpitContext,
  inner: number,
  room: number,
): string[] {
  const { style } = ctx;
  const fact = snapshot.knowledge;
  const absent = missing(fact, style);
  if (absent || fact.state !== "measured") {
    const lines = absent ?? [];
    if (snapshot.workspace.kind === "mirror") lines.push(style.dim("c opens it in Pathrule Web"));
    return lines;
  }
  const k = fact.value;
  const count = (n: number, one: string, many: string) =>
    `${style.strong(formatCount(n))} ${style.dim(n === 1 ? one : many)}`;
  const totals = [
    count(k.memories.active, "memory", "memories"),
    count(k.rules.active, "rule", "rules"),
    count(k.skills.active, "skill", "skills"),
  ].join("   ");
  const archived = k.memories.archived + k.rules.archived + k.skills.archived;
  const lines = [
    spread(totals, archived > 0 ? style.dim(`${formatCount(archived)} archived`) : "", inner),
  ];
  if (k.memories.active + k.rules.active + k.skills.active === 0) {
    lines.push("", style.dim("Empty so far: your agents add knowledge as you work."));
    return lines;
  }
  if (snapshot.paths.state !== "measured") return lines;
  const areas = busiestAreas(snapshot.paths.value);
  if (areas.length === 0) return lines;
  lines.push("");
  // The bars that fit, keeping a line for "+ n more" when some do not.
  const left = Math.max(1, room - lines.length);
  const shown = areas.length <= left ? areas.length : Math.max(1, left - 1);
  const top = areas.slice(0, shown);
  const labelWidth = Math.min(
    22,
    Math.max(...top.map((a) => visibleWidth(a.area.slice(1) || "/"))),
  );
  const countWidth = Math.max(...top.map((a) => formatCount(a.items).length));
  const barWidth = Math.max(4, inner - labelWidth - countWidth - 4);
  const max = top[0]!.items;
  for (const { area, items } of top) {
    const filled = Math.max(1, Math.round((items / max) * barWidth));
    const label = padEnd(
      truncate(area.slice(1) || "/", labelWidth, style.glyph.ellipsis),
      labelWidth,
    );
    const bar = `${style.accent(style.glyph.bar.full.repeat(filled))}${style.line(style.glyph.bar.empty.repeat(barWidth - filled))}`;
    lines.push(`${label}  ${bar}  ${formatCount(items).padStart(countWidth)}`);
  }
  if (areas.length > shown) lines.push(style.dim(`+ ${formatCount(areas.length - shown)} more`));
  return lines;
}

function agentLine(agent: AgentFact, style: Style, mode: "local" | "cloud" | null): string {
  const name = padEnd(agent.name, 13);
  if (agent.connections.length > 0) {
    const partial = agent.connections.some((c) => c.status === "partial");
    const other = mode ? agent.connections.find((c) => c.mode !== mode) : undefined;
    const c = agent.connections[0]!;
    const channel =
      c.channel === "native-plugin"
        ? "plugin"
        : c.channel === "settings-hook"
          ? "hooks"
          : c.channel;
    const scope =
      agent.connections.length > 1
        ? `${agent.connections.length} setups`
        : c.scope === "user"
          ? "all projects"
          : "this project";
    if (partial)
      return `${style.warn(style.glyph.warn)} ${name}${style.warn("partial")} ${style.dim(`${style.glyph.dot} a repairs`)}`;
    if (other)
      return `${style.warn(style.glyph.warn)} ${name}${style.warn(`uses ${other.mode === "cloud" ? "Cloud" : "Local"}`)} ${style.dim(`${style.glyph.dot} m`)}`;
    return `${style.accent(style.glyph.live)} ${style.strong(name)}${style.dim(`${channel} ${style.glyph.dot} ${scope}`)}`;
  }
  if (agent.support === "native-plugin") {
    return `${style.dim(style.glyph.pending)} ${name}${style.dim(`found ${style.glyph.dot} a connects`)}`;
  }
  return `${style.dim(style.glyph.pending)} ${name}${style.dim("pathrule install")}`;
}

function agentsLines(snapshot: HomeSnapshot, ctx: CockpitContext): string[] {
  const { style } = ctx;
  const agents = snapshot.integrations.agents;
  const shown = agents.filter(
    (a) => (a.detected || a.connections.length > 0) && a.support !== "not-yet",
  );
  const later = agents.filter((a) => a.support === "not-yet").map((a) => a.name);
  // A connection runs no edition of its own: the folder's edition decides, so none is "the other".
  const lines = shown.map((agent) => agentLine(agent, style, null));
  if (lines.length === 0) lines.push(style.dim("No supported coding agent found here."));
  if (later.length > 0) lines.push(style.dim(`not yet: ${later.join(", ")}`));
  return lines;
}

function sparkline(hourly: readonly number[], style: Style, width: number): string {
  const max = Math.max(...hourly);
  const per = Math.max(1, Math.floor(width / hourly.length));
  return hourly
    .map((n) => {
      if (n === 0 || max === 0) return style.line(style.glyph.spark[0]!.repeat(per));
      const level = Math.min(7, Math.max(1, Math.ceil((n / max) * 7)));
      return style.accent(style.glyph.spark[level]!.repeat(per));
    })
    .join("");
}

function contextLines(snapshot: HomeSnapshot, ctx: CockpitContext, inner: number): string[] {
  const { style } = ctx;
  const fact = snapshot.deliveries;
  const absent = missing(fact, style);
  if (absent || fact.state !== "measured") return absent ?? [];
  const d = fact.value;
  if (d.items === 0) {
    return [
      sparkline(d.hourly, style, inner),
      style.dim("No confirmed delivery yet: your agents get context"),
      style.dim("from their next prompt."),
    ];
  }
  const last = d.lastAt ? formatAgo(d.lastAt, ctx.now) : "unknown";
  const spark = sparkline(d.hourly, style, inner);
  return [
    spark,
    spread(style.dim("24 h ago"), style.dim("now"), visibleWidth(spark)),
    `${style.strong(formatCount(d.items))} ${style.dim(`item${d.items === 1 ? "" : "s"} in`)} ${style.strong(formatCount(d.sessions))} ${style.dim(`session${d.sessions === 1 ? "" : "s"} ${style.glyph.dot} last ${last}`)}`,
    style.dim(
      `hook ${formatCount(d.byChannel.hook)} ${style.glyph.dot} MCP ${formatCount(d.byChannel.mcp)}${d.sessionsRead < d.sessionsTotal ? ` ${style.glyph.dot} newest ${formatCount(d.sessionsRead)} of ${formatCount(d.sessionsTotal)} sessions` : ""}`,
    ),
  ];
}

export interface AttentionItem {
  tone: "warn" | "info";
  text: string;
  /** The key that acts on it. */
  key?: string;
  hint?: string;
}

/** What needs the person now, from the facts alone: warnings first, then optional steps. */
export function attentionItems(snapshot: HomeSnapshot): AttentionItem[] {
  const items: AttentionItem[] = [];
  const { intelligence, account, workspace } = snapshot;
  if (workspace.problem)
    items.push({ tone: "warn", text: "Workspace could not be read", key: "d", hint: "shows why" });
  if (intelligence.mode === "unset")
    items.push({ tone: "warn", text: "Mode not chosen", key: "m", hint: "chooses" });
  if (
    intelligence.mode === "cloud" &&
    (account.state === "signed_out" || account.state === "unknown")
  ) {
    items.push({
      tone: "warn",
      text: "Not signed in to Pathrule Cloud",
      key: "s",
      hint: "signs in",
    });
  }
  for (const capability of intelligence.capabilities.filter((c) => c.state === "unavailable")) {
    items.push({
      tone: "warn",
      text: `${capability.title} unavailable`,
      key: "d",
      hint: "shows why",
    });
  }
  const base =
    intelligence.mode === "cloud" ? "cloud" : intelligence.mode === "unset" ? null : "local";
  if (base && intelligence.agentsMode && intelligence.agentsMode !== base) {
    items.push({
      tone: "warn",
      text: `Agents still use ${intelligence.agentsMode === "cloud" ? "Cloud" : "Local"}`,
      key: "m",
      hint: "re-points",
    });
  }
  const agents = snapshot.integrations.agents;
  if (agents.some((a) => a.connections.some((c) => c.status === "partial"))) {
    items.push({ tone: "warn", text: "An agent connection is partial", key: "a", hint: "repairs" });
  }
  if (agents.every((a) => a.connections.length === 0)) {
    items.push({ tone: "warn", text: "No agent connected", key: "a", hint: "connects" });
  }
  if (snapshot.refreshes.state === "measured" && snapshot.refreshes.value > 0) {
    const n = snapshot.refreshes.value;
    items.push({
      tone: "info",
      text: `${formatCount(n)} refresh task${n === 1 ? "" : "s"} waiting`,
      hint: "your agent resolves them",
    });
  }
  if (snapshot.agentIr.state === "measured" && snapshot.agentIr.value.proposed > 0) {
    const n = snapshot.agentIr.value.proposed;
    items.push({
      tone: "info",
      text: `${formatCount(n)} knowledge atom${n === 1 ? "" : "s"} to review`,
      key: "c",
      hint: "console",
    });
  }
  return items;
}

function attentionLines(items: readonly AttentionItem[], ctx: CockpitContext): string[] {
  const { style } = ctx;
  if (items.length === 0) return [`${style.accent(style.glyph.ok)} Nothing needs you.`];
  return items.map((item) => {
    const mark =
      item.tone === "warn" ? style.warn(style.glyph.warn) : style.dim(style.glyph.pending);
    const act = item.key
      ? `${style.chip(item.key)} ${style.dim(item.hint ?? "")}`
      : style.dim(item.hint ?? "");
    return `${mark} ${item.text}  ${act}`.trimEnd();
  });
}

function activityLines(snapshot: HomeSnapshot, ctx: CockpitContext, inner: number): string[] {
  const { style } = ctx;
  const fact = snapshot.activity;
  const absent = missing(fact, style);
  if (absent || fact.state !== "measured") return absent ?? [];
  if (fact.value.length === 0) {
    return [
      style.dim("Nothing logged yet."),
      style.dim("Your agents log what they change here as they finish their work."),
    ];
  }
  return fact.value.map((item) => {
    const when = style.dim(padEnd(formatAgo(item.at, ctx.now), 11));
    const path = item.path ? style.dim(item.path) : "";
    const room = inner - 11 - (path ? visibleWidth(path) + 2 : 0);
    const summary = truncate(
      item.summary.replace(/\s+/g, " "),
      Math.max(10, room),
      style.glyph.ellipsis,
    );
    return spread(`${when}${summary}`, path, inner);
  });
}

// ── Layout ───────────────────────────────────────────────────────────────────

function header(snapshot: HomeSnapshot, ctx: CockpitContext): string {
  const { style } = ctx;
  const ws = snapshot.workspace;
  const brand = `${style.accent(style.glyph.brand)} ${style.strong("pathrule")}`;
  const where =
    ws.kind === "none"
      ? style.dim(tildePath(snapshot.cwd, ctx.homeDir))
      : `${style.strong(ws.name ?? "workspace")}${ws.relativePath ? ` ${style.dim(ws.relativePath)}` : ""}  ${style.dim(tildePath(ws.root ?? "", ctx.homeDir))}`;
  const mode = snapshot.intelligence.mode;
  const modeText =
    mode === "cloud"
      ? `${style.accent(style.glyph.live)} Cloud`
      : mode === "local"
        ? `${style.accent(style.glyph.live)} Local ${style.dim("open source")}`
        : style.warn(`${style.glyph.warn} mode not chosen`);
  return spread(
    `${brand} ${style.line(style.glyph.box.v)} ${where}`,
    `${modeText}   ${style.dim(`v${snapshot.cliVersion}`)}`,
    ctx.columns,
  );
}

const PANEL_ACTION: Record<CockpitPanel, string> = {
  knowledge: "k",
  agents: "a",
  context: "d",
  attention: "",
  activity: "c",
};

/** Shorter labels, for a key bar that does not fit with the full ones. */
const SHORT_LABEL: Record<string, string> = {
  knowledge: "know",
  diagnostics: "diag",
  "sign-in": "sign in",
};

/**
 * Every action with its key, always: the hint goes first when space runs short, then the spacing,
 * then the labels shorten, and only on the narrowest terminal are the keys shown alone.
 */
function keyBar(actions: readonly HomeAction[], state: CockpitState, ctx: CockpitContext): string {
  const { style } = ctx;
  if (state.notice) return style.warn(state.notice);
  const fits = (text: string) => visibleWidth(text) <= ctx.columns;
  const bar = (label: (a: HomeAction) => string, gap: string, joiner: string) =>
    actions.map((a) => `${style.chip(a.key)}${joiner}${style.dim(label(a))}`).join(gap);
  const full = (a: HomeAction) => a.label.toLowerCase();
  const short = (a: HomeAction) => SHORT_LABEL[a.id] ?? full(a);
  const hint = style.dim(`tab panels ${style.glyph.dot} enter opens`);
  const roomy = bar(full, "  ", " ");
  if (visibleWidth(roomy) + visibleWidth(hint) + 2 <= ctx.columns) {
    return spread(roomy, hint, ctx.columns);
  }
  for (const candidate of [roomy, bar(full, " ", ""), bar(short, " ", "")]) {
    if (fits(candidate)) return candidate;
  }
  return actions.map((a) => style.chip(a.key)).join(" ");
}

/**
 * The cockpit as exactly `ctx.rows` lines of at most `ctx.columns` cells. The caller checks
 * `fitsCockpit` first; below that size the linear home is the right screen.
 */
export function renderCockpit(
  snapshot: HomeSnapshot,
  actions: readonly HomeAction[],
  state: CockpitState,
  ctx: CockpitContext,
): string[] {
  const { style } = ctx;
  const width = ctx.columns;
  const leftWidth = Math.floor((width - 1) * 0.6);
  const rightWidth = width - 1 - leftWidth;
  const area = ctx.rows - 3; // header, a blank line, the key bar
  const tone = (panel: CockpitPanel, warn = false): PanelTone =>
    state.focus === panel ? "focus" : warn ? "warn" : "normal";
  const keyNote = (panel: CockpitPanel) => (PANEL_ACTION[panel] ? PANEL_ACTION[panel] : undefined);

  // Every panel first gets what it needs: Knowledge its totals and a few bars, Context and Needs
  // you their lines, Activity its entries. Rows left over show more of the busiest paths, and the
  // rest goes to Activity, so the panels always fill the screen to the key bar.
  const agents = agentsLines(snapshot, ctx);
  const attention = attentionItems(snapshot);
  const context = contextLines(snapshot, ctx, leftWidth - 4);
  const needs = attentionLines(attention, ctx);
  const secondHeight = Math.max(context.length, Math.min(needs.length, 6), 3) + 2;
  const activity = activityLines(snapshot, ctx, width - 4);
  const allKnowledge = knowledgeLines(snapshot, ctx, leftWidth - 4, Number.MAX_SAFE_INTEGER);
  let firstContent = Math.max(agents.length, Math.min(allKnowledge.length, KNOWLEDGE_MIN), 3);
  const spare = area - (firstContent + 2) - secondHeight;
  const activityNeed = Math.min(Math.max(1, activity.length) + 2, Math.max(0, spare));
  firstContent += Math.max(
    0,
    Math.min(spare - activityNeed, Math.min(allKnowledge.length, KNOWLEDGE_MAX) - firstContent),
  );
  const knowledge = knowledgeLines(snapshot, ctx, leftWidth - 4, firstContent);
  const firstHeight = firstContent + 2;
  const activityHeight = area - firstHeight - secondHeight;

  const panel = (p: Panel, w: number, h: number) => drawPanel(style, p, w, h);
  const knowledgeNote = snapshot.knowledge.state === "measured" ? "this workspace" : undefined;
  const rows: string[] = [header(snapshot, ctx), ""];
  rows.push(
    ...sideBySide(
      [
        panel(
          {
            title: "Knowledge",
            note: [knowledgeNote, keyNote("knowledge")].filter(Boolean).join("  "),
            lines: knowledge,
            tone: tone("knowledge"),
          },
          leftWidth,
          firstHeight,
        ),
        panel(
          { title: "Agents", note: keyNote("agents"), lines: agents, tone: tone("agents") },
          rightWidth,
          firstHeight,
        ),
      ],
      [leftWidth, rightWidth],
    ),
  );
  const warnings = attention.filter((a) => a.tone === "warn").length;
  rows.push(
    ...sideBySide(
      [
        panel(
          { title: "Context delivered", note: "last 24 h", lines: context, tone: tone("context") },
          leftWidth,
          secondHeight,
        ),
        panel(
          {
            title: "Needs you",
            note: attention.length > 0 ? formatCount(attention.length) : undefined,
            lines: needs,
            tone: tone("attention", warnings > 0),
          },
          rightWidth,
          secondHeight,
        ),
      ],
      [leftWidth, rightWidth],
    ),
  );
  if (activityHeight >= 3) {
    rows.push(
      ...panel(
        {
          title: "Activity",
          note:
            snapshot.activity.state === "measured" ? "logged by agents, not verified" : undefined,
          lines: activity,
          tone: tone("activity"),
        },
        width,
        activityHeight,
      ),
    );
  }
  while (rows.length < ctx.rows - 1) rows.push("");
  rows.push(keyBar(actions, state, ctx));
  return rows.slice(0, ctx.rows).map((line) => truncate(line, width, style.glyph.ellipsis));
}
