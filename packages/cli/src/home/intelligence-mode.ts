// SPDX-License-Identifier: Apache-2.0
// Choosing and changing this folder's edition, Cloud or Local, from the terminal experience. Every
// step here is a step the CLI already has, in its own words:
//
// - the edition: `pathrule setup --cloud` or `--local` (capabilities/folder-setup.ts), which asks
//   whether for this project only or as the device default, and, going to Cloud, shows what of the
//   folder's Local knowledge can be copied and copies it only on its own approval;
// - the agents: `pathrule integrations` (the native integration engine), so its wizard shows its plan
//   and asks before it changes anything;
// - sign-in: the account edition's own `pathrule login`. Nothing here sees a token.
//
// Nothing from Pathrule Cloud is ever copied to this machine; going to Cloud copies Local knowledge
// only when the person approves it in setup.
import { integrationsCommand } from "../commands/integrations.js";
import { setupCommand } from "../commands/workspace-local.js";
import { readIntegrationRegistry } from "@pathrule/integrations/native/registry-io.js";
import { cliAccount, cliPlugins, type CliCommand, type CliCommandContext } from "../plugin.js";
import type { TerminalUi } from "../terminal/ui.js";
import type { HomeSnapshot, IntelligenceFact } from "./facts.js";
import { modeTitle } from "./render.js";

export type ChosenMode = "cloud" | "local";

/** A command an installed plugin adds (`login`, `open`), or null. */
export function pluginCommand(name: string): CliCommand | null {
  for (const plugin of cliPlugins()) {
    const found = plugin.commands?.find((command) => command.name === name);
    if (found) return found;
  }
  return null;
}

/** The context to run another command with: its name and arguments, and the mode as flags. */
export function commandContext(
  ctx: CliCommandContext,
  command: string,
  args: string[],
  flags: Partial<CliCommandContext["flags"]> = {},
): CliCommandContext {
  return { ...ctx, command, args, flags: { ...ctx.flags, json: false, yes: false, ...flags } };
}

/** The flags that hand a mode to `pathrule integrations`, so its wizard does not ask again. */
export function modeFlags(mode: ChosenMode): Pick<CliCommandContext["flags"], "cloud" | "local"> {
  return { cloud: mode === "cloud", local: mode === "local" };
}

/** The question: Cloud or Local, each with what it means for data, network and account. */
export async function chooseIntelligence(
  ui: TerminalUi,
  current: IntelligenceFact["mode"],
  title = "Choose your mode",
  step?: string,
): Promise<ChosenMode | null> {
  const mark = (mode: IntelligenceFact["mode"]) => (current === mode ? "current" : undefined);
  return ui.choose<ChosenMode>({
    title,
    step,
    intro: ui.paragraph(
      "Where your project's knowledge lives and where Pathrule's decisions run. Your agents work the same way either way. You can change it later: run pathrule and press m.",
    ),
    initial: current === "local" ? 1 : 0,
    options: [
      {
        value: "cloud",
        key: "c",
        label: "Pathrule Cloud",
        hint: mark("cloud") ?? "managed · sign in",
        detail: [
          "Knowledge lives in your Pathrule Cloud workspace, shared across your devices and your team. Needs a Pathrule account and a network connection.",
          "Sign in with your Pathrule account in the browser, or with a one-time code. Pathrule Cloud is part of this CLI: nothing else is downloaded.",
        ],
      },
      {
        value: "local",
        key: "l",
        label: "Local",
        hint: mark("local") ?? "on this machine · no account",
        detail: [
          "Knowledge stays in a store on this machine (~/.pathrule). No account and no upload; it works offline.",
          "Open source only: nothing proprietary is installed or loaded.",
        ],
      },
    ],
  });
}

/**
 * Sets this folder up in `mode` through `pathrule setup --cloud` or `--local`, handed the terminal:
 * setup asks the scope when the edition changes and, going to Cloud, whether to copy the folder's
 * Local knowledge. False when setup did not finish.
 */
export async function prepareIntelligence(
  ui: TerminalUi,
  ctx: CliCommandContext,
  mode: ChosenMode,
): Promise<boolean> {
  const code = await ui.handOff(() => setupCommand.run(commandContext(ctx, "setup", [], modeFlags(mode))));
  return code === 0;
}

/** `pathrule integrations` with the mode set: its wizard detects, plans, asks, applies, verifies. */
export async function connectAgents(
  ui: TerminalUi,
  ctx: CliCommandContext,
  mode: ChosenMode,
  args: string[] = [],
): Promise<number> {
  return ui.handOff(() =>
    integrationsCommand.run(commandContext(ctx, "integrations", args, modeFlags(mode))),
  );
}

export type SignInResult = "signed_in" | "skipped" | "unavailable";

/**
 * Sign-in through the account edition's `pathrule login` (browser or one-time code, as it decides).
 * Offered, never forced; a failure offers a retry. Ctrl-C during sign-in ends Pathrule, nothing else.
 */
export async function signIn(ui: TerminalUi, ctx: CliCommandContext): Promise<SignInResult> {
  const { style } = ui;
  const login = pluginCommand("login");
  const account = cliAccount();
  if (!login || !account) {
    ui.write([
      `${style.warn(style.glyph.warn)} Pathrule Cloud is not loaded, so sign-in is not available in this run.`,
      "",
    ]);
    return "unavailable";
  }
  if (await account.signedInUser(ctx.runtime.env).catch(() => null)) {
    ui.write([`${style.ok(style.glyph.ok)} Signed in to Pathrule Cloud.`, ""]);
    return "signed_in";
  }
  for (let attempt = 0; ; attempt += 1) {
    const choice = await ui.choose<"sign-in" | "skip">({
      title: attempt === 0 ? "Sign in to Pathrule Cloud" : "Sign-in did not finish",
      intro: ui.paragraph(
        attempt === 0
          ? "Cloud needs your Pathrule account. Sign-in opens your browser (or shows a one-time code to enter on any device). Pathrule stores the session in your Pathrule home and never prints it."
          : "Nothing was stored. Try again, or skip and sign in later with pathrule login.",
      ),
      options: [
        { value: "sign-in", key: "s", label: attempt === 0 ? "Sign in now" : "Try again" },
        { value: "skip", key: "l", label: "Later", hint: "pathrule login" },
      ],
    });
    if (choice !== "sign-in") {
      ui.write([
        style.dim("Not signed in. Your agents use Cloud once you sign in: pathrule login"),
        "",
      ]);
      return "skipped";
    }
    const code = await ui.handOff(() => login.run(commandContext(ctx, "login", [])));
    if (code === 0) return "signed_in";
  }
}

interface ConnectionGroup {
  scope: "user" | "project";
  projectRoot: string | null;
  channel: string;
  mcp: boolean;
  /** The mode these integrations run in now. */
  mode: "local" | "cloud";
  providers: string[];
}

/** The recorded integrations, grouped the way `pathrule integrations add` takes them. */
export async function connectionGroups(env: NodeJS.ProcessEnv): Promise<ConnectionGroup[]> {
  const registry = await readIntegrationRegistry(env).catch(() => ({ integrations: [] }));
  const groups = new Map<string, ConnectionGroup>();
  for (const record of registry.integrations) {
    const channel = record.channel === "settings-hook" ? "settings" : "plugin";
    const key = `${record.scope}\0${record.project_root ?? ""}\0${channel}\0${record.mcp}\0${record.mode}`;
    const group = groups.get(key) ?? {
      scope: record.scope,
      projectRoot: record.project_root,
      channel,
      mcp: record.mcp,
      mode: record.mode,
      providers: [],
    };
    if (!group.providers.includes(record.provider)) group.providers.push(record.provider);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The `integrations add` arguments that apply a group again, in its own scope and channel. */
export function groupArgs(group: ConnectionGroup): string[] {
  return [
    "add",
    ...group.providers,
    "--scope",
    group.scope,
    ...(group.projectRoot ? ["--project", group.projectRoot] : []),
    "--channel",
    group.channel,
    ...(group.channel === "settings" && !group.mcp ? ["--no-mcp"] : []),
  ];
}

/** What a switch does and does not do, in the words the confirmation shows. */
export function switchPlan(
  from: IntelligenceFact["mode"],
  to: ChosenMode,
): {
  does: string[];
  doesNot: string[];
} {
  if (to === "cloud") {
    return {
      does: [
        "Runs pathrule setup --cloud for this folder: it asks whether for this project only or as the device default, then signs you in, attaches the folder's Cloud workspace and connects your AI clients.",
        "Shows what of this folder's Local knowledge can be copied to Pathrule Cloud, and copies it only if you approve.",
      ],
      doesNot: [
        from === "unset"
          ? "Change anything before you confirm."
          : "Delete your Local workspace: it stays on this machine, unused while this folder is on Pathrule Cloud.",
        "Change any other folder: each keeps its own edition.",
      ],
    };
  }
  return {
    does: [
      "Runs pathrule setup --local for this folder: it asks whether for this project only or as the device default, then sets the folder up on this machine.",
    ],
    doesNot: [
      "Copy anything from Pathrule Cloud: this folder's Cloud knowledge stays there, and this machine's copy of it is removed.",
      "Change any other folder: each keeps its own edition.",
      "Sign you out: your Cloud session stays (pathrule logout signs out).",
    ],
  };
}

/** The home's Mode action: show the plan, ask, then hand the terminal to setup. */
export async function runModeSwitch(
  ui: TerminalUi,
  ctx: CliCommandContext,
  snapshot: HomeSnapshot,
): Promise<void> {
  const { style } = ui;
  const current = snapshot.intelligence.mode;
  const target = await chooseIntelligence(ui, current, "Change mode");
  if (!target) return;
  if (current === target) {
    ui.write([`${style.ok(style.glyph.ok)} This folder is already on ${modeTitle(target)}. Nothing changed.`, ""]);
    return;
  }
  const plan = switchPlan(current, target);
  ui.write([
    ...ui.heading(`Switch this folder to ${modeTitle(target)}`),
    style.strong("What happens"),
    ...plan.does.flatMap((line) => ui.bullet(line)),
    style.strong("What does not"),
    ...plan.doesNot.flatMap((line) => ui.bullet(line)),
    "",
  ]);
  if (!(await ui.confirm(`Switch this folder to ${modeTitle(target)}?`, false))) {
    ui.write([style.dim("Nothing changed."), ""]);
    return;
  }
  if (!(await prepareIntelligence(ui, ctx, target))) {
    ui.write([style.dim("Setup did not finish; pathrule status shows where this folder stands."), ""]);
    return;
  }
  if (target === "cloud") await signIn(ui, ctx);
}
