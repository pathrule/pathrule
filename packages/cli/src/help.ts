// SPDX-License-Identifier: Apache-2.0
// `pathrule help`: built from the commands, options and topics of this run, so it lists what this
// build can do and nothing it cannot.
import {
  CLI_HELP_SECTIONS,
  type CliCommand,
  type CliHelpOption,
  type CliHelpTopic,
} from "./plugin.js";

export const CLI_PRODUCT_NAME = "Pathrule CLI";
export const CLI_PRODUCT_DESCRIPTION = "Pathrule from your terminal. Headless, scriptable, fast.";

const KNOWLEDGE_READING = [
  "Read knowledge in the terminal:",
  "  pathrule memory list",
  '  pathrule memory read "Exact title" --print',
  "  Use rule or skill in place of memory. --print shows long content in the terminal.",
  "  Add --local for a local workspace, or --json for machine-readable output.",
];

/** The options every edition has. The text is printed after two spaces, as it reads here. */
export const OPEN_HELP_OPTIONS: readonly CliHelpOption[] = [
  { rank: 10, text: "--json      Print stable machine-readable output" },
  { rank: 20, text: "--yes       Accept prompts for supported mutating commands" },
  { rank: 30, text: "--no-open   Do not open browser windows" },
  { rank: 50, text: "--no-color  Disable colored output" },
];

export const CLI_HELP_TOPIC: CliHelpTopic = {
  name: "cli",
  rank: 40,
  text: `${CLI_PRODUCT_NAME}

${CLI_PRODUCT_DESCRIPTION}

Good for:
  - Headless or terminal-first setup
  - Local AI tool install and sync
  - Scripts and CI-friendly diagnostics

Useful commands:
  pathrule setup
  pathrule doctor
  pathrule integrations add codex
  pathrule sync
`,
};

const byRank = (a: { rank: number }, b: { rank: number }) => a.rank - b.rank;

export function renderHelp(
  commands: readonly CliCommand[],
  options: readonly CliHelpOption[],
): string {
  const lines = [CLI_PRODUCT_NAME, "", "Usage:", "  pathrule <command> [options]", ""];
  for (const section of CLI_HELP_SECTIONS) {
    const listed = commands
      .flatMap((command) =>
        command.help?.section === section.id ? [{ command, rank: command.help.rank }] : [],
      )
      .sort(byRank);
    if (listed.length === 0) continue;
    lines.push(`${section.title}:`);
    for (const { command } of listed) {
      lines.push(`  ${command.name.padEnd(13)} ${command.help!.summary}`);
    }
    lines.push("");
    if (section.id === "knowledge") lines.push(...KNOWLEDGE_READING, "");
  }
  lines.push("Options:");
  for (const option of [...options].sort(byRank)) lines.push(`  ${option.text}`);
  return `${lines.join("\n")}\n`;
}

/** `pathrule <command> --help` and `pathrule help <command>`: the one command, its usage and the options. */
export function renderCommandHelp(command: CliCommand, options: readonly CliHelpOption[]): string {
  const lines = [`pathrule ${command.name}`, ""];
  if (command.help) lines.push(command.help.summary, "");
  lines.push("Usage:");
  for (const usage of command.help?.usage ?? [`pathrule ${command.name} [options]`])
    lines.push(`  ${usage}`);
  lines.push("", "Options:");
  for (const option of [...options].sort(byRank)) lines.push(`  ${option.text}`);
  lines.push("", "Every command: pathrule help");
  return `${lines.join("\n")}\n`;
}

export type HelpResult =
  | { ok: true; text: string; topic: string | null }
  | { ok: false; message: string };

export function helpFor(
  topic: string | undefined,
  topics: readonly CliHelpTopic[],
  mainText: () => string,
  commandText: (name: string) => string | null = () => null,
): HelpResult {
  if (!topic) return { ok: true, text: mainText(), topic: null };
  const match = topics.find((candidate) => candidate.name === topic);
  if (!match) {
    const text = commandText(topic);
    if (text) return { ok: true, text, topic };
    return {
      ok: false,
      message: `Unknown command or help topic "${topic}". Run pathrule help for the commands; topics: ${topics.map((t) => t.name).join(", ")}.`,
    };
  }
  return { ok: true, text: match.text, topic: match.name };
}

export function sortedTopics(topics: readonly CliHelpTopic[]): CliHelpTopic[] {
  return [...topics].sort(byRank);
}
