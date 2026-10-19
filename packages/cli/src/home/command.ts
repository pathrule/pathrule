// SPDX-License-Identifier: Apache-2.0
// `pathrule home`, and bare `pathrule` when a person is at a terminal: the project home.
//
//   pathrule home           the home in a terminal; printed once when piped
//   pathrule home --json    the same facts as one envelope
//
// In a terminal it paints at once from files (./snapshot.ts quick facts), then fills in what the
// store, the delivery ledgers and the account say, in place. On a machine where nothing is set up
// it welcomes and offers the first run (./first-run.ts) on the setup rail. Once set up, a terminal
// large enough gets the full-screen cockpit (./cockpit.ts) and its knowledge browser
// (./browser.ts); a smaller one gets the same facts as one column. Its actions are the CLI's own
// commands (knowledge lists, `pathrule integrations`, the Local Console, doctor, the mode switch)
// and run on the rail, in the normal screen. It never starts or wraps a coding agent, and it writes
// nothing by being shown.
import { homedir } from "node:os";

import { memoryCommand, ruleCommand, skillCommand } from "../commands/content-local.js";
import { doctorCommand } from "../commands/doctor.js";
import { integrationsCommand } from "../commands/integrations.js";
import { runUiCommand } from "../commands/ui.js";
import { jsonEnvelope, type CliNextStep } from "../output.js";
import type { CliCommand, CliCommandContext, CliJsonResult } from "../plugin.js";
import { FullScreen } from "../terminal/fullscreen.js";
import type { KeySource } from "../terminal/keys.js";
import { MIN_COLUMNS, personAtTerminal, terminalProfile } from "../terminal/profile.js";
import { terminalStyle } from "../terminal/style.js";
import { renderLogo } from "../terminal/logo.js";
import { CanceledByPerson, TerminalUi } from "../terminal/ui.js";
import type { HostSession } from "@pathrule/host/session.js";
import { runBrowser } from "./browser.js";
import {
  COCKPIT_MAX_COLUMNS,
  COCKPIT_PANELS,
  attentionItems,
  fitsCockpit,
  renderCockpit,
  type CockpitPanel,
} from "./cockpit.js";
import { isFirstRun, type HomeSnapshot } from "./facts.js";
import { runFirstRun } from "./first-run.js";
import { openKnowledgeReader } from "./knowledge.js";
import {
  commandContext,
  connectAgents,
  pluginCommand,
  runModeSwitch,
  signIn,
  type ChosenMode,
} from "./intelligence-mode.js";
import {
  homeActions,
  renderActions,
  renderHome,
  type HomeAction,
  type RenderContext,
} from "./render.js";
import {
  readHomeSnapshot,
  readQuickFacts,
  readStoreFacts,
  type SnapshotInput,
} from "./snapshot.js";

export const HOME_COMMAND = "home";

/** Whether bare `pathrule` opens the home: a person at a terminal, not --json, CI or a pipe. */
export const opensHome = personAtTerminal;

/** What tests replace: the keys, the clock, the manifest reader, the host session. */
export interface HomeDependencies {
  keys?: KeySource;
  now?: () => number;
  fetchImpl?: typeof fetch;
  session?: HostSession;
}

function snapshotInput(ctx: CliCommandContext, deps: HomeDependencies): SnapshotInput {
  return { cwd: ctx.runtime.cwd, env: ctx.runtime.env, session: deps.session, now: deps.now };
}

function renderContext(ui: TerminalUi, now: number, compact = false): RenderContext {
  return {
    style: ui.style,
    columns: ui.profile.columns,
    now,
    homeDir: ui.runtime.env.HOME || homedir(),
    compact,
    plain: ui.profile.plain,
  };
}

function baseMode(snapshot: HomeSnapshot): ChosenMode {
  return snapshot.intelligence.mode === "cloud" ? "cloud" : "local";
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function showKnowledge(
  ui: TerminalUi,
  ctx: CliCommandContext,
  snapshot: HomeSnapshot,
): Promise<void> {
  const kind = await ui.choose<"memory" | "rule" | "skill">({
    title: "Knowledge",
    intro: ui.paragraph(
      snapshot.intelligence.mode === "cloud"
        ? "Lists from your Pathrule Cloud workspace, as pathrule memory list prints them."
        : "Lists from this workspace's local store, as pathrule memory list --local prints them. The Local Console (c) shows and edits everything.",
    ),
    options: [
      { value: "memory", key: "m", label: "Memories" },
      { value: "rule", key: "r", label: "Rules" },
      { value: "skill", key: "s", label: "Skills" },
    ],
  });
  if (!kind) return;
  const command = kind === "memory" ? memoryCommand : kind === "rule" ? ruleCommand : skillCommand;
  const local = snapshot.intelligence.mode !== "cloud";
  await ui.handOff(() => command.run(commandContext(ctx, kind, ["list"], { local, cloud: false })));
}

async function manageAgents(
  ui: TerminalUi,
  ctx: CliCommandContext,
  snapshot: HomeSnapshot,
): Promise<void> {
  const connected = snapshot.integrations.agents.filter((a) => a.connections.length > 0);
  const choice = await ui.choose<"connect" | "doctor" | "repair" | "remove">({
    title: "Agents",
    intro: ui.paragraph(
      "Pathrule connects to your agents through their own plugin systems. Every change is shown as a plan and asked first.",
    ),
    options: [
      { value: "connect", key: "c", label: "Connect agents", hint: "pathrule integrations" },
      { value: "doctor", key: "d", label: "Check connections", hint: "changes nothing" },
      {
        value: "repair",
        key: "r",
        label: "Repair connections",
        hint: "re-applies what is recorded",
        disabled: connected.length === 0 ? "Nothing is connected yet." : undefined,
      },
      {
        value: "remove",
        key: "x",
        label: "Remove an agent",
        hint: "removes only what Pathrule recorded",
        disabled: connected.length === 0 ? "Nothing is connected yet." : undefined,
      },
    ],
  });
  if (!choice) return;
  const mode = baseMode(snapshot);
  if (choice === "connect") {
    await connectAgents(ui, ctx, mode);
    return;
  }
  if (choice === "doctor") {
    await connectAgents(ui, ctx, mode, ["doctor"]);
    return;
  }
  if (choice === "repair") {
    // The plan first (nothing changes without --yes), then the same plan applied on a yes.
    await connectAgents(ui, ctx, mode, ["repair"]);
    if (await ui.confirm("Apply this repair plan?", false)) {
      await ui.handOff(() =>
        integrationsCommand.run(commandContext(ctx, "integrations", ["repair"], { yes: true })),
      );
    }
    return;
  }
  const target = await ui.choose<{
    provider: string;
    scope: "user" | "project";
    projectRoot: string | null;
  }>({
    title: "Remove which?",
    options: connected.flatMap((agent) =>
      agent.connections.map((c) => ({
        value: { provider: agent.id, scope: c.scope, projectRoot: c.projectRoot },
        label: agent.name,
        hint: c.scope === "user" ? "all projects" : (c.projectRoot ?? "project"),
      })),
    ),
  });
  if (!target) return;
  const args = [
    "remove",
    target.provider,
    "--scope",
    target.scope,
    ...(target.projectRoot ? ["--project", target.projectRoot] : []),
  ];
  await connectAgents(ui, ctx, mode, args);
  if (await ui.confirm(`Remove Pathrule from ${target.provider} as listed?`, false)) {
    await ui.handOff(() =>
      integrationsCommand.run(commandContext(ctx, "integrations", args, { yes: true })),
    );
  }
}

/** The Local Console until the person presses q here (or Ctrl-C), then back to the home. */
async function openConsole(
  ui: TerminalUi,
  ctx: CliCommandContext,
  snapshot: HomeSnapshot,
): Promise<void> {
  if (snapshot.intelligence.mode === "cloud") {
    const open = pluginCommand("open");
    if (open) await ui.handOff(() => open.run(commandContext(ctx, "open", [])));
    else
      ui.write([
        ui.style.dim(
          "Pathrule Cloud is not loaded in this run; its console cannot be opened from here.",
        ),
      ]);
    return;
  }
  const stop = new AbortController();
  const serving = ui.handOff(() =>
    runUiCommand(commandContext(ctx, "ui", []), { signal: stop.signal }),
  );
  let served = false;
  void serving.finally(() => {
    served = true;
  });
  ui.write([ui.style.dim("Press q here to stop the Local Console and go back to the home.")]);
  while (!served) {
    const key = await Promise.race([ui.key(), serving.then(() => null)]);
    if (!key) break;
    if (
      key.name === "interrupt" ||
      key.name === "escape" ||
      (key.name === "char" && key.char === "q")
    ) {
      stop.abort();
      break;
    }
  }
  await serving;
}

async function diagnostics(
  ui: TerminalUi,
  ctx: CliCommandContext,
  snapshot: HomeSnapshot,
): Promise<void> {
  await ui.handOff(() => doctorCommand.run(commandContext(ctx, "doctor", [])));
  ui.write(["", ui.style.strong("Agent connections")]);
  await connectAgents(ui, ctx, baseMode(snapshot), ["doctor"]);
}

// ── The home ─────────────────────────────────────────────────────────────────

/**
 * The first-run welcome: the logo, one line on what Pathrule is and one on what it found, then the
 * one next step on the setup rail.
 */
async function welcome(
  ui: TerminalUi,
  ctx: CliCommandContext,
  snapshot: HomeSnapshot,
  deps: HomeDependencies,
): Promise<"setup-done" | "quit"> {
  const { style } = ui;
  const found = snapshot.integrations.agents
    .filter((a) => a.detected && a.support === "native-plugin")
    .map((a) => a.name);
  const names =
    found.length <= 1 ? (found[0] ?? "") : `${found.slice(0, -1).join(", ")} and ${found.at(-1)}`;
  ui.write([
    "",
    ...renderLogo(style, ui.profile.columns, {
      indent: "   ",
      plain: ui.profile.plain,
      unicode: ui.profile.unicode,
      rows: ui.profile.rows,
    }),
    "",
    `   ${style.strong("The context layer for your coding agents.")}`,
    `   ${style.dim(
      found.length > 0
        ? `Found ${names} on this machine.`
        : "No supported coding agent found on this machine yet.",
    )}`,
    "",
  ]);
  ui.railStart(
    style.dim("Setup takes a minute. Nothing changes until you choose."),
    `v${snapshot.cliVersion}`,
    {
      brand: false,
    },
  );
  const choice = await ui.choose<"setup" | "help" | "quit">({
    title: "Get started",
    options: [
      {
        value: "setup",
        key: "s",
        label: "Set up Pathrule",
        hint: "choose Cloud or Local, then connect your agents",
      },
      { value: "help", key: "h", label: "Show all commands", hint: "pathrule --help" },
      { value: "quit", key: "q", label: "Quit", hint: "nothing changes" },
    ],
  });
  if (choice === "help") {
    ui.railEnd(
      "Run pathrule --help for every command. pathrule integrations connects agents; pathrule setup --local or --cloud chooses a mode.",
    );
    ui.write([""]);
    return "quit";
  }
  if (choice !== "setup") {
    ui.railEnd(style.dim("Nothing changed. Run pathrule any time."));
    return "quit";
  }
  try {
    await runFirstRun(ui, ctx, snapshot, { fetchImpl: deps.fetchImpl });
  } catch (err) {
    if (!(err instanceof CanceledByPerson)) throw err;
    ui.railEnd(
      ui.style.dim("Setup canceled. Steps already applied stay; run pathrule to continue."),
    );
  }
  return (await ui.pause("Press any key to open the home, or Ctrl-C to leave"))
    ? "setup-done"
    : "quit";
}

/** The cockpit's size: the terminal's whole width (bounded) and height. */
function cockpitSize(ui: TerminalUi): { columns: number; rows: number } {
  const raw = (ui.runtime.stdout as { columns?: number }).columns;
  const columns =
    typeof raw === "number" && raw > 0
      ? Math.min(COCKPIT_MAX_COLUMNS, Math.max(MIN_COLUMNS, raw - 1))
      : ui.profile.columns;
  return { columns, rows: ui.profile.rows };
}

/** What each action's flow is called on the rail. */
const ACTION_TITLES: Record<string, string> = {
  knowledge: "Knowledge",
  agents: "Agents",
  console: "Console",
  diagnostics: "Diagnostics",
  mode: "Mode",
  "sign-in": "Sign in",
};

/** The action Enter opens on a focused panel. */
function panelAction(
  panel: CockpitPanel,
  snapshot: HomeSnapshot,
  actions: readonly HomeAction[],
): HomeAction | null {
  const byKey = (key: string | undefined) => actions.find((a) => a.key === key) ?? null;
  switch (panel) {
    case "knowledge":
      return byKey("k");
    case "agents":
      return byKey("a");
    case "context":
      return byKey("d");
    case "activity":
      return byKey("c");
    case "attention":
      return byKey(attentionItems(snapshot).find((item) => item.key)?.key);
  }
}

/**
 * The knowledge browser in the cockpit's screen, for a local workspace. Opening it is the person's
 * action, so it may start the host. A failure to read comes back as one line for the key bar.
 */
async function browseKnowledge(
  ui: TerminalUi,
  ctx: CliCommandContext,
  snapshot: HomeSnapshot,
  full: FullScreen,
  deps: HomeDependencies,
): Promise<string | null> {
  let reader: Awaited<ReturnType<typeof openKnowledgeReader>>;
  try {
    reader = await openKnowledgeReader(
      { env: ctx.runtime.env, session: deps.session },
      snapshot.workspace.id!,
    );
  } catch (err) {
    return `Knowledge could not be read: ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    await runBrowser(reader, {
      draw: (lines) => full.draw(lines, cockpitSize(ui).columns),
      key: () => ui.key(),
      context: () => ({
        style: ui.style,
        ...cockpitSize(ui),
        now: deps.now?.() ?? Date.now(),
        workspace: snapshot.workspace.name ?? "workspace",
      }),
    });
  } finally {
    await reader.close();
  }
  return null;
}

async function runInteractiveHome(ctx: CliCommandContext, deps: HomeDependencies): Promise<number> {
  const ui = new TerminalUi({
    runtime: ctx.runtime,
    profile: terminalProfile(ctx.runtime, ctx.mode),
    keys: deps.keys,
  });
  await ui.detectTone();
  const full = new FullScreen(ctx.runtime.stdout, ui.style.glyph.ellipsis);
  const input = snapshotInput(ctx, deps);
  const now = () => deps.now?.() ?? Date.now();
  const homeDir = ctx.runtime.env.HOME || homedir();
  const stdout = ctx.runtime.stdout as {
    on?: (e: string, f: () => void) => void;
    off?: (e: string, f: () => void) => void;
  };
  let redraw: (() => void) | null = null;
  const onResize = () => {
    ui.refreshWidth();
    redraw?.();
  };
  stdout.on?.("resize", onResize);
  // The full-screen cockpit, for a person at a terminal large enough to lay it out.
  const cockpit = () => {
    const size = cockpitSize(ui);
    return ui.profile.cursor && !ui.profile.plain && fitsCockpit(size.columns, size.rows);
  };
  try {
    let welcomed = false;
    // Opening the home starts nothing: only Refresh (or a flow that needs it) may start the host.
    let launch = false;
    let focus: CockpitPanel = "knowledge";
    let carried: string | null = null;
    for (;;) {
      let snapshot = await readQuickFacts(input);
      if (!welcomed && isFirstRun(snapshot)) {
        welcomed = true;
        if ((await welcome(ui, ctx, snapshot, deps)) === "quit") return 0;
        continue;
      }
      const actions = homeActions(snapshot);
      let selected = 0;
      let notice: string | null = carried;
      carried = null;
      const draw = () => {
        if (cockpit()) {
          const size = cockpitSize(ui);
          full.draw(
            renderCockpit(
              snapshot,
              actions,
              { focus, notice },
              { style: ui.style, ...size, now: now(), homeDir },
            ),
            size.columns,
          );
          return;
        }
        if (full.isOpen) full.close();
        const linear = renderHome(snapshot, renderContext(ui, now()));
        const bar = renderActions(actions, selected, renderContext(ui, now()), notice);
        const body =
          linear.length + bar.length < ui.profile.rows
            ? linear
            : renderHome(snapshot, renderContext(ui, now(), true));
        ui.screen.draw([...body, ...bar]);
      };
      const reading = readStoreFacts(snapshot, input, { launch });
      launch = false;
      if (ui.profile.plain) {
        // Printed once, complete: a screen reader reads it top to bottom.
        snapshot = await reading.catch(() => snapshot);
        ui.write(renderHome(snapshot, renderContext(ui, now())));
        ui.write(renderActions(actions, -1, renderContext(ui, now())));
      } else {
        redraw = draw;
        draw();
        void reading.then(
          (filled) => {
            snapshot = filled;
            redraw?.();
          },
          () => {},
        );
      }
      let action: HomeAction | null = null;
      while (!action) {
        const key = await ui.key("Action: ");
        notice = null;
        const step = (by: number) => {
          if (cockpit()) {
            const i = COCKPIT_PANELS.indexOf(focus);
            focus = COCKPIT_PANELS[(i + by + COCKPIT_PANELS.length) % COCKPIT_PANELS.length]!;
          } else {
            selected = (selected + by + actions.length) % actions.length;
          }
        };
        if (key.name === "interrupt" || key.name === "eof" || key.name === "escape") {
          action = actions.find((a) => a.id === "quit")!;
        } else if (key.name === "left" || key.name === "up") {
          step(-1);
        } else if (key.name === "right" || key.name === "down" || key.name === "tab") {
          step(1);
        } else if (key.name === "enter") {
          if (cockpit()) {
            action = panelAction(focus, snapshot, actions);
            if (!action) notice = "Nothing needs you here.";
          } else {
            action = actions[selected]!;
          }
        } else if (key.name === "char") {
          const match = actions.find((a) => a.key === key.char?.toLowerCase());
          if (match) action = match;
          else notice = `No action on "${key.char}". Use the keys shown, or q to quit.`;
        }
        if (!action) {
          if (!ui.profile.plain) draw();
          else if (notice) ui.write([notice]);
        }
      }
      redraw = null;
      if (action.id === "quit") {
        full.close();
        ui.close();
        return 0;
      }
      if (action.id === "refresh") {
        if (!full.isOpen) ui.screen.clear();
        launch = true;
        continue;
      }
      if (
        action.id === "knowledge" &&
        cockpit() &&
        snapshot.workspace.kind === "local" &&
        snapshot.workspace.id
      ) {
        carried = await browseKnowledge(ui, ctx, snapshot, full, deps);
        continue;
      }
      // A flow prints and asks in the normal screen, on the rail, where its output stays readable.
      full.close();
      ui.screen.release();
      ui.write([""]);
      ui.railStart("Pathrule", ACTION_TITLES[action.id] ?? "");
      try {
        await runAction(action.id, ui, ctx, snapshot);
      } catch (err) {
        if (!(err instanceof CanceledByPerson)) throw err;
        ui.write([
          "",
          ui.style.dim("Canceled. Anything already applied stays; nothing else changed."),
        ]);
      }
      ui.railEnd();
      if (!(await ui.pause())) {
        ui.close();
        return 0;
      }
    }
  } finally {
    stdout.off?.("resize", onResize);
    full.close();
    ui.close();
  }
}

async function runAction(
  id: string,
  ui: TerminalUi,
  ctx: CliCommandContext,
  snapshot: HomeSnapshot,
): Promise<void> {
  switch (id) {
    case "knowledge":
      return showKnowledge(ui, ctx, snapshot);
    case "agents":
      return manageAgents(ui, ctx, snapshot);
    case "console":
      return openConsole(ui, ctx, snapshot);
    case "diagnostics":
      return diagnostics(ui, ctx, snapshot);
    case "mode":
      return runModeSwitch(ui, ctx, snapshot);
    case "sign-in":
      await signIn(ui, ctx);
      return;
  }
}

/** The home printed once, for a pipe or a terminal without a person (`pathrule home | less`). */
async function printHome(ctx: CliCommandContext, deps: HomeDependencies): Promise<number> {
  const snapshot = await readHomeSnapshot(snapshotInput(ctx, deps));
  const style = terminalStyle({ color: false, unicode: false });
  const lines = renderHome(snapshot, {
    style,
    columns: 80,
    now: deps.now?.() ?? Date.now(),
    homeDir: ctx.runtime.env.HOME || homedir(),
    plain: true,
  });
  ctx.runtime.stdout.write(`${lines.join("\n").trimEnd()}\n`);
  return 0;
}

export async function runHome(
  ctx: CliCommandContext,
  deps: HomeDependencies = {},
): Promise<number> {
  return personAtTerminal(ctx.runtime, ctx.mode) || deps.keys
    ? runInteractiveHome(ctx, deps)
    : printHome(ctx, deps);
}

function nextSteps(snapshot: HomeSnapshot): CliNextStep[] {
  const steps: CliNextStep[] = [];
  if (snapshot.intelligence.mode === "unset") {
    steps.push(
      { label: "Use Pathrule Cloud (sign in)", command: "pathrule setup --cloud" },
      { label: "Use Pathrule on this machine (no account)", command: "pathrule setup --local" },
    );
  }
  if (snapshot.integrations.agents.every((a) => a.connections.length === 0)) {
    steps.push({ label: "Connect your coding agents", command: "pathrule integrations" });
  }
  if (snapshot.intelligence.mode === "cloud" && snapshot.account.state === "signed_out") {
    steps.push({ label: "Sign in to Pathrule Cloud", command: "pathrule login" });
  }
  return steps;
}

export async function homeJson(
  ctx: CliCommandContext,
  deps: HomeDependencies = {},
): Promise<CliJsonResult> {
  const snapshot = await readHomeSnapshot(snapshotInput(ctx, deps));
  const steps = nextSteps(snapshot);
  return {
    exitCode: 0,
    envelope: jsonEnvelope({
      command: HOME_COMMAND,
      cwd: ctx.runtime.cwd,
      ok: true,
      data: snapshot,
      ...(steps.length > 0 ? { next_steps: steps } : {}),
    }),
  };
}

export const homeCommand: CliCommand = {
  name: HOME_COMMAND,
  help: {
    section: "quick-start",
    rank: 5,
    summary:
      "Project home: status, setup, agents, mode (also bare `pathrule` in a terminal)",
  },
  // Last in `help --json`: an addition after every command listed before it, in their order.
  jsonRank: 900,
  run: (ctx) => runHome(ctx),
  json: (ctx) => homeJson(ctx),
};
