// SPDX-License-Identifier: Apache-2.0
// The first run: choose Cloud or Local, connect the agents on this machine, then the one step Cloud
// still needs (sign-in), and a plain ending: open your coding agent as usual. Pathrule never starts
// the agent.
//
// It reads as one calm line down the terminal (the setup rail, terminal/ui.ts): each step asks on
// the rail, folds to its answer once answered, and the rail ends where setup does. Each step is the
// CLI's own (./intelligence-mode.ts says which); this file only orders them and says where the
// person is. Backing out of any question leaves what was done so far and changes nothing else.
import { readIntegrationRegistry } from "@pathrule/integrations/native/registry-io.js";

import type { CliCommandContext } from "../plugin.js";
import type { TerminalUi } from "../terminal/ui.js";
import type { HomeSnapshot } from "./facts.js";
import {
  chooseIntelligence,
  connectAgents,
  prepareIntelligence,
  signIn,
  type ChosenMode,
  type SignInResult,
} from "./intelligence-mode.js";
import { modeTitle } from "./render.js";

export interface FirstRunResult {
  mode: ChosenMode | null;
  /** Agents recorded in the integration registry when the run ended. */
  connected: string[];
  signIn: SignInResult | null;
}

export interface FirstRunOptions {
  /** Kept for the home's callers; the first run itself reads nothing over the network. */
  fetchImpl?: typeof fetch;
}

const stepOf = (n: number, steps: number) => `step ${n} of ${steps}`;

/** The display names of the agents the integration registry records. */
async function connectedAgents(ctx: CliCommandContext, snapshot: HomeSnapshot): Promise<string[]> {
  const registry = await readIntegrationRegistry(ctx.runtime.env).catch(() => ({
    integrations: [],
  }));
  const names = new Map(snapshot.integrations.agents.map((agent) => [agent.id, agent.name]));
  return [...new Set(registry.integrations.map((record) => record.provider))].map(
    (provider) => names.get(provider) ?? provider,
  );
}

/**
 * The setup steps on a rail the caller started (the welcome's), ended here. On a rail of its own
 * when called without one.
 */
export async function runFirstRun(
  ui: TerminalUi,
  ctx: CliCommandContext,
  snapshot: HomeSnapshot,
  _options: FirstRunOptions = {},
): Promise<FirstRunResult> {
  const { style } = ui;
  const result: FirstRunResult = { mode: null, connected: [], signIn: null };
  if (!ui.rail) ui.railStart("Pathrule setup");

  // Cloud has a third step, sign-in; Local is done once the agents are connected.
  const steps = (mode: ChosenMode | null) => (mode === "cloud" ? 3 : 2);
  const mode = await chooseIntelligence(
    ui,
    snapshot.intelligence.mode,
    "Choose your mode",
    "step 1",
  );
  if (!mode) {
    ui.railEnd(style.dim("Setup stopped before any change. Run pathrule again any time."));
    return result;
  }
  if (!(await prepareIntelligence(ui, ctx, mode))) {
    ui.railEnd(style.dim("Setup stopped. Nothing else changed."));
    return result;
  }
  result.mode = mode;

  ui.write([
    ...ui.heading("Connect your coding agents", stepOf(2, steps(mode))),
    style.dim("The integrations wizard shows its plan and asks before it changes anything."),
  ]);
  await connectAgents(ui, ctx, mode);
  result.connected = await connectedAgents(ctx, snapshot);
  ui.railDone(
    "Agents",
    result.connected.length > 0
      ? `${result.connected.join(", ")} ${style.dim("connected")}`
      : style.dim("none connected yet: a on the home connects one"),
  );

  if (mode === "cloud") {
    ui.write(ui.heading("Sign in", stepOf(3, 3)));
    result.signIn = await signIn(ui, ctx);
  }

  const lines: string[] = [];
  if (result.signIn === "skipped") {
    lines.push(style.warn(`${style.glyph.warn} Not signed in yet: pathrule login`));
  }
  lines.push(
    `${style.strong("Open Claude Code, Codex or Cursor as usual.")} Pathrule works inside your agent; it never starts one.`,
    style.dim(`To change ${modeTitle(mode)} later: run pathrule and press m.`),
    "",
  );
  ui.write(lines);
  ui.railEnd(
    `${style.accent(style.glyph.ok)} ${style.strong(`Pathrule is set up as ${modeTitle(mode)}.`)}`,
  );
  return result;
}
