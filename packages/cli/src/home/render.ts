// SPDX-License-Identifier: Apache-2.0
// The project home as lines of text: pure, so every width, colour and glyph set is
// tested without a terminal. Facts render as they are: a measured number with its scope, "reading…"
// while it loads, and an unavailable or unmeasured fact as words, never as a zero.
import type { Style } from "../terminal/style.js";
import {
  formatAgo,
  formatCount,
  padEnd,
  tildePath,
  truncate,
  visibleWidth,
} from "../terminal/text.js";
import type { AgentFact, Fact, HomeSnapshot, IntelligenceFact } from "./facts.js";

export interface RenderContext {
  style: Style;
  columns: number;
  now: number;
  /** The person's home directory, shown as `~`. */
  homeDir: string | undefined;
  /** A short terminal: context on one line and no activity, so the home fits and can redraw. */
  compact?: boolean;
  /** Plain text for screen readers and logs: no decorative rules. */
  plain?: boolean;
}

/** Below this width the home stacks every section in one column with short labels. */
export const NARROW_COLUMNS = 60;
/** From this width the store sections sit side by side. */
export const WIDE_COLUMNS = 100;

const LABEL = 14;
/** The newest activity entries the one-column home shows. */
const ACTIVITY_SHOWN = 5;

function row(ctx: RenderContext, label: string, value: string): string[] {
  const { style } = ctx;
  if (ctx.columns < NARROW_COLUMNS)
    return label ? [style.dim(label), `  ${value}`] : [`  ${value}`];
  return [`${style.dim(padEnd(label, LABEL))}${value}`];
}

function factText<T>(fact: Fact<T>, ctx: RenderContext, show: (value: T) => string): string {
  const { style } = ctx;
  switch (fact.state) {
    case "measured":
      return show(fact.value);
    case "loading":
      return style.dim(`reading${style.glyph.ellipsis}`);
    case "not_measured":
      return `${style.dim("not measured")}`;
    case "unavailable":
      return style.dim(`unavailable ${style.glyph.dot} ${fact.reason}`);
    case "deferred":
      return style.dim(`not read yet ${style.glyph.dot} ${fact.reason}`);
  }
}

export function modeTitle(mode: IntelligenceFact["mode"]): string {
  switch (mode) {
    case "cloud":
      return "Pathrule Cloud";
    case "local":
      return "Local";
    case "unset":
      return "not chosen yet";
  }
}

function modeLine(snapshot: HomeSnapshot, ctx: RenderContext): string[] {
  const { style } = ctx;
  const { intelligence, account } = snapshot;
  const dot = ` ${style.glyph.dot} `;
  const change = style.dim(`${dot}change: m`);
  const lines: string[] = [];
  if (intelligence.mode === "cloud") {
    const signed =
      account.state === "signed_in"
        ? style.ok(`${style.glyph.ok} signed in`)
        : account.state === "session_stored"
          ? style.dim("sign-in stored, not checked")
          : account.state === "unknown"
            ? style.warn(`${style.glyph.warn} sign-in unavailable`)
            : style.warn(`${style.glyph.warn} not signed in`);
    lines.push(
      ...row(ctx, "Mode", `${style.strong("Pathrule Cloud")}${dot}${signed}${change}`),
    );
    if (account.state !== "signed_in") lines.push(...row(ctx, "", style.dim(account.detail)));
  } else if (intelligence.mode === "local") {
    lines.push(
      ...row(
        ctx,
        "Mode",
        `${style.strong("Local")}${dot}on this machine, no account, open source${change}`,
      ),
    );
  } else {
    lines.push(
      ...row(ctx, "Mode", `${style.warn("not chosen yet")}${style.dim(`${dot}choose: m`)}`),
    );
  }
  for (const capability of intelligence.capabilities.filter((c) => c.state === "unavailable")) {
    lines.push(
      ...row(
        ctx,
        "",
        style.warn(`${style.glyph.warn} ${capability.title} unavailable: ${capability.detail}`),
      ),
    );
  }
  const base =
    intelligence.mode === "cloud" ? "cloud" : intelligence.mode === "unset" ? null : "local";
  if (base && intelligence.agentsMode && intelligence.agentsMode !== base) {
    lines.push(
      ...row(
        ctx,
        "",
        style.warn(
          `${style.glyph.warn} Your agents still use ${intelligence.agentsMode === "cloud" ? "Pathrule Cloud" : "Local"}; re-point them with Mode (m).`,
        ),
      ),
    );
  }
  return lines;
}

function connectionText(
  agent: AgentFact,
  ctx: RenderContext,
  mode: "local" | "cloud" | null,
): string {
  const { style } = ctx;
  if (agent.connections.length > 0) {
    const where = agent.connections
      .map((c) => {
        const scope =
          c.scope === "user"
            ? "all projects"
            : `project ${tildePath(c.projectRoot ?? "", ctx.homeDir)}`;
        const channel =
          c.channel === "native-plugin"
            ? "plugin"
            : c.channel === "settings-hook"
              ? "hooks"
              : c.channel;
        const partial = c.status === "partial" ? style.warn(" partial: repair") : "";
        const other =
          mode && c.mode !== mode
            ? style.warn(` uses ${c.mode === "cloud" ? "Cloud" : "Local"}`)
            : "";
        return `${channel}, ${scope}${other}${partial}`;
      })
      .join("; ");
    return `${style.ok(style.glyph.ok)} ${agent.name} ${style.dim(where)}`;
  }
  if (agent.support === "native-plugin") {
    return `${style.dim(style.glyph.pending)} ${agent.name} ${style.dim("found, not connected")}`;
  }
  return `${style.dim(style.glyph.off)} ${agent.name} ${style.dim(agent.support === "mcp-and-hooks-via-cli" ? "via pathrule install" : "not supported yet")}`;
}

function agentLines(snapshot: HomeSnapshot, ctx: RenderContext): string[] {
  const shown = snapshot.integrations.agents.filter((a) => a.detected || a.connections.length > 0);
  if (shown.length === 0) {
    return row(ctx, "Agents", ctx.style.dim("no supported coding agent found on this machine"));
  }
  const chosen = snapshot.intelligence.mode;
  const mode = chosen === "cloud" ? "cloud" : chosen === "unset" ? null : "local";
  return shown.flatMap((agent, i) =>
    row(ctx, i === 0 ? "Agents" : "", connectionText(agent, ctx, mode)),
  );
}

function workspaceLine(snapshot: HomeSnapshot, ctx: RenderContext): string[] {
  const { style } = ctx;
  const ws = snapshot.workspace;
  if (ws.problem) {
    return row(
      ctx,
      "Workspace",
      style.warn(`${style.glyph.warn} could not be read: ${ws.problem}`),
    );
  }
  if (ws.kind === "none") {
    return row(
      ctx,
      "Workspace",
      `${style.dim("none for")} ${tildePath(snapshot.cwd, ctx.homeDir)}${ws.isProject ? style.dim(` ${style.glyph.dot} a project; connecting an agent creates one`) : ""}`,
    );
  }
  const where = ws.relativePath ? ` ${style.dim(ws.relativePath)}` : "";
  const kind = ws.kind === "mirror" ? style.dim(` ${style.glyph.dot} Cloud workspace`) : "";
  return row(
    ctx,
    "Workspace",
    `${style.strong(ws.name ?? "workspace")}${where}  ${style.dim(tildePath(ws.root ?? "", ctx.homeDir))}${kind}`,
  );
}

/** The header: brand, title and version, with a rule under it. */
export function renderHeader(title: string, ctx: RenderContext, version?: string): string[] {
  const { style } = ctx;
  const left = `${style.accent(style.glyph.brand)} ${style.strong("Pathrule")}${title ? `  ${style.dim(title)}` : ""}`;
  const right = version ? style.dim(`v${version}`) : "";
  const gap = ctx.columns - visibleWidth(left) - visibleWidth(right);
  const top = right && gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : left;
  return ctx.plain ? [top] : [top, style.dim(style.glyph.rule.repeat(ctx.columns))];
}

function section(title: string, note: string | null, ctx: RenderContext): string {
  const { style } = ctx;
  return note ? `${style.strong(title)}  ${style.dim(note)}` : style.strong(title);
}

function stat(ctx: RenderContext, label: string, value: number | string, note = ""): string {
  const { style } = ctx;
  const n = typeof value === "number" ? formatCount(value) : value;
  return `  ${padEnd(label, 11)}${padEnd(n, 7)}${note ? style.dim(note) : ""}`.trimEnd();
}

function knowledgeBlock(snapshot: HomeSnapshot, ctx: RenderContext): string[] {
  const { style } = ctx;
  const fact = snapshot.knowledge;
  const lines = [section("Knowledge", fact.state === "measured" ? "this workspace" : null, ctx)];
  if (fact.state !== "measured") return [...lines, `  ${factText(fact, ctx, () => "")}`];
  const k = fact.value;
  const archived = (n: number) => (n > 0 ? `${formatCount(n)} archived` : "");
  lines.push(stat(ctx, "Memories", k.memories.active, archived(k.memories.archived)));
  lines.push(stat(ctx, "Rules", k.rules.active, archived(k.rules.archived)));
  lines.push(stat(ctx, "Skills", k.skills.active, archived(k.skills.archived)));
  if (k.memories.active + k.rules.active + k.skills.active === 0) {
    lines.push(style.dim("  Empty so far: your agents add knowledge as you work."));
  }
  return lines;
}

function agentIrBlock(snapshot: HomeSnapshot, ctx: RenderContext): string[] {
  const fact = snapshot.agentIr;
  const lines = [section("Agent IR", fact.state === "measured" ? "knowledge atoms" : null, ctx)];
  if (fact.state !== "measured") return [...lines, `  ${factText(fact, ctx, () => "")}`];
  lines.push(stat(ctx, "Verified", fact.value.approved, "approved by a person"));
  lines.push(stat(ctx, "Candidates", fact.value.proposed, "awaiting your review"));
  return lines;
}

function signalsBlock(snapshot: HomeSnapshot, ctx: RenderContext): string[] {
  const { style } = ctx;
  const fact = snapshot.signals;
  const lines = [section("Signals", fact.state === "measured" ? "runtime events" : null, ctx)];
  if (fact.state !== "measured") return [...lines, `  ${factText(fact, ctx, () => "")}`];
  const s = fact.value;
  if (s.groups === 0 && s.declared === 0) {
    return [...lines, style.dim("  none received")];
  }
  lines.push(stat(ctx, "Groups", s.groups, s.active > 0 ? `${formatCount(s.active)} active` : ""));
  lines.push(stat(ctx, "Last event", s.lastSeen ? formatAgo(s.lastSeen, ctx.now) : "none"));
  return lines;
}

function deliveryBlock(snapshot: HomeSnapshot, ctx: RenderContext): string[] {
  const { style } = ctx;
  const fact = snapshot.deliveries;
  const lines = [section("Delivery", fact.state === "measured" ? "confirmed receipts" : null, ctx)];
  if (fact.state !== "measured") return [...lines, `  ${factText(fact, ctx, () => "")}`];
  const d = fact.value;
  if (d.items === 0) return [...lines, style.dim("  no confirmed delivery yet")];
  lines.push(
    stat(
      ctx,
      "Items",
      d.items,
      `in ${formatCount(d.sessions)} agent session${d.sessions === 1 ? "" : "s"}`,
    ),
  );
  lines.push(
    stat(
      ctx,
      "Channels",
      "",
      `hook ${formatCount(d.byChannel.hook)} ${style.glyph.dot} MCP ${formatCount(d.byChannel.mcp)}`,
    ),
  );
  if (d.lastAt) lines.push(stat(ctx, "Last", formatAgo(d.lastAt, ctx.now)));
  if (d.sessionsRead < d.sessionsTotal) {
    lines.push(
      style.dim(
        `  newest ${formatCount(d.sessionsRead)} of ${formatCount(d.sessionsTotal)} sessions read`,
      ),
    );
  }
  return lines;
}

function contextBlock(snapshot: HomeSnapshot, ctx: RenderContext): string[] {
  const { style } = ctx;
  const c = snapshot.context;
  if (
    ctx.compact &&
    [c.deliveredTokens, c.agentIrTokens, c.compression].every((f) => f.state === "not_measured")
  ) {
    return [
      `${style.strong("Context")}  ${style.dim("tokens, Agent IR size and compression: not measured")}`,
    ];
  }
  const line = (
    label: string,
    fact: Fact<number> | HomeSnapshot["context"]["compression"],
    value: () => string,
  ) => {
    const text =
      fact.state === "measured"
        ? value()
        : fact.state === "not_measured"
          ? `${style.dim("not measured")} ${style.dim(`${style.glyph.dot} ${fact.reason}`)}`
          : factText(fact, ctx, () => "");
    return `  ${padEnd(label, 18)}${text}`;
  };
  return [
    section("Context", null, ctx),
    line("Delivered tokens", c.deliveredTokens, () =>
      c.deliveredTokens.state === "measured" ? formatCount(c.deliveredTokens.value) : "",
    ),
    line("Agent IR size", c.agentIrTokens, () =>
      c.agentIrTokens.state === "measured" ? `${formatCount(c.agentIrTokens.value)} tokens` : "",
    ),
    line("Compression", c.compression, () =>
      c.compression.state === "measured"
        ? `${c.compression.value.savedPercent}% smaller (${formatCount(c.compression.value.deliveredTokens)} of ${formatCount(c.compression.value.baselineTokens)} tokens, ${c.compression.value.tokenizer})`
        : "",
    ),
  ];
}

function activityBlock(snapshot: HomeSnapshot, ctx: RenderContext): string[] {
  const { style } = ctx;
  const fact = snapshot.activity;
  if (fact.state === "unavailable" && snapshot.workspace.kind !== "local") return [];
  const lines = [
    section(
      "Recent activity",
      fact.state === "measured" ? "logged by agents, not verified" : null,
      ctx,
    ),
  ];
  if (fact.state !== "measured") return [...lines, `  ${factText(fact, ctx, () => "")}`];
  if (fact.value.length === 0) return [...lines, style.dim("  nothing logged yet")];
  for (const item of fact.value.slice(0, ACTIVITY_SHOWN)) {
    const when = padEnd(formatAgo(item.at, ctx.now), 11);
    const path = item.path ? `${style.dim(item.path)}  ` : "";
    lines.push(
      truncate(
        `  ${style.dim(when)}${path}${item.summary.replace(/\s+/g, " ")}`,
        ctx.columns,
        style.glyph.ellipsis,
      ),
    );
  }
  return lines;
}

/** Two blocks side by side, the left one padded to `leftWidth`. */
function sideBySide(left: string[], right: string[], leftWidth: number): string[] {
  const height = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < height; i += 1) {
    out.push(
      `${padEnd(truncate(left[i] ?? "", leftWidth - 2), leftWidth)}${right[i] ?? ""}`.trimEnd(),
    );
  }
  return out;
}

/** The home's body: who and where, then what the workspace holds and what reached the agents. */
export function renderHome(snapshot: HomeSnapshot, ctx: RenderContext): string[] {
  const lines = [
    ...renderHeader("Project home", ctx, snapshot.cliVersion),
    ...workspaceLine(snapshot, ctx),
    ...modeLine(snapshot, ctx),
    ...agentLines(snapshot, ctx),
    "",
  ];
  const knowledge = knowledgeBlock(snapshot, ctx);
  const atoms = agentIrBlock(snapshot, ctx);
  const signals = signalsBlock(snapshot, ctx);
  const delivery = deliveryBlock(snapshot, ctx);
  if (ctx.columns >= WIDE_COLUMNS) {
    const half = Math.floor(ctx.columns / 2);
    lines.push(...sideBySide(knowledge, atoms, half), "");
    lines.push(...sideBySide(delivery, signals, half), "");
  } else {
    lines.push(...knowledge, "", ...atoms, "", ...delivery, "", ...signals, "");
  }
  lines.push(...contextBlock(snapshot, ctx), "");
  const activity = ctx.compact ? [] : activityBlock(snapshot, ctx);
  if (activity.length > 0) lines.push(...activity, "");
  return fit(lines, ctx);
}

/** Every line cut to the width: the home never relies on the terminal to wrap a line it redraws. */
function fit(lines: string[], ctx: RenderContext): string[] {
  // Plain text is printed once and never redrawn: the terminal may wrap it, and nothing is cut.
  if (ctx.plain) return lines;
  return lines.map((line) => truncate(line, ctx.columns, ctx.style.glyph.ellipsis));
}

export interface HomeAction {
  id: string;
  key: string;
  label: string;
}

/** The actions of the home for this snapshot, in bar order. */
export function homeActions(snapshot: HomeSnapshot): HomeAction[] {
  const cloud = snapshot.intelligence.mode === "cloud";
  const actions: HomeAction[] = [
    { id: "knowledge", key: "k", label: "Knowledge" },
    { id: "agents", key: "a", label: "Agents" },
    { id: "console", key: "c", label: "Console" },
    { id: "diagnostics", key: "d", label: "Diagnostics" },
    { id: "mode", key: "m", label: "Mode" },
  ];
  if (cloud && snapshot.account.state !== "signed_in") {
    actions.push({
      id: "sign-in",
      key: "s",
      label: snapshot.account.state === "session_stored" ? "Check sign-in" : "Sign in",
    });
  }
  actions.push(
    { id: "refresh", key: "r", label: "Refresh" },
    { id: "quit", key: "q", label: "Quit" },
  );
  return actions;
}

/**
 * The action bar: every action with its key, the selected one highlighted, wrapped to the width.
 * The last line says how to move.
 */
export function renderActions(
  actions: readonly HomeAction[],
  selected: number,
  ctx: RenderContext,
  notice: string | null = null,
): string[] {
  const { style } = ctx;
  const items = actions.map((action, i) => {
    const text = `${action.key} ${action.label}`;
    return i === selected ? style.selected(text) : style.unselected(text);
  });
  const lines = ctx.plain ? [] : [style.dim(style.glyph.rule.repeat(ctx.columns))];
  let current = "";
  for (const item of items) {
    const candidate = current ? `${current} ${item}` : item;
    if (current && visibleWidth(candidate) > ctx.columns) {
      lines.push(current);
      current = item;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  if (ctx.plain) {
    lines.push("Type the letter of an action, then Enter. q quits.");
    return fit(lines, ctx);
  }
  const move = style.glyph.arrow === "->" ? "left/right" : "←→";
  lines.push(
    notice
      ? style.warn(notice)
      : style.dim(
          `${move} move ${style.glyph.dot} Enter or key opens ${style.glyph.dot} q quit ${style.glyph.dot} pathrule --help for all commands`,
        ),
  );
  return fit(lines, ctx);
}
