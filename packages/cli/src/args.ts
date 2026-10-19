// SPDX-License-Identifier: Apache-2.0
export interface ParsedCliArgs {
  command: string;
  positional: string[];
  flags: {
    json: boolean;
    yes: boolean;
    noOpen: boolean;
    deviceCode: boolean;
    browserCallback: boolean;
    help: boolean;
    version: boolean;
    color: boolean;
    interactive: boolean;
    /** Run the command against the local (no-login) store. */
    local: boolean;
    /** `pathrule setup --cloud`: choose Pathrule Cloud without the onboarding question. */
    cloud: boolean;
    /**
     * `--no-intelligence`, accepted and ignored: `pathrule setup --local` is the open CLI alone, and
     * callers from before that was so still pass the flag.
     */
    noIntelligence: boolean;
    /** `pathrule logout --all`: sign out every surface, not just this one. */
    all: boolean;
    /**
     * `pathrule eject --apply`: carry the plan out. Eject PLANS by default
     * because it deletes and rewrites files in the user's working tree, and a
     * destructive default turns a trust feature into a support ticket.
     */
    apply: boolean;
  };
}

const FLAG_ALIASES = new Map([
  ["-h", "--help"],
  ["-v", "--version"],
]);

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedCliArgs {
  const rawPositional: string[] = [];
  const flags = {
    json: false,
    yes: false,
    noOpen: false,
    deviceCode: false,
    browserCallback: false,
    help: false,
    version: false,
    color: env.NO_COLOR !== "1" && env.NO_COLOR !== "true",
    interactive: env.CI !== "true",
    local: false,
    cloud: false,
    noIntelligence: false,
    apply: false,
    all: false,
  };

  for (const raw of argv) {
    const arg = FLAG_ALIASES.get(raw) ?? raw;
    switch (arg) {
      case "--json":
        flags.json = true;
        flags.color = false;
        flags.interactive = false;
        break;
      case "--yes":
        flags.yes = true;
        break;
      case "--no-open":
        flags.noOpen = true;
        break;
      case "--device-code":
        flags.deviceCode = true;
        break;
      case "--browser-callback":
        flags.browserCallback = true;
        break;
      case "--help":
        flags.help = true;
        break;
      case "--version":
        flags.version = true;
        break;
      case "--no-color":
        flags.color = false;
        break;
      case "--local":
        flags.local = true;
        break;
      case "--cloud":
        flags.cloud = true;
        break;
      case "--no-intelligence":
        flags.noIntelligence = true;
        break;
      case "--all":
        flags.all = true;
        break;
      case "--apply":
        flags.apply = true;
        break;
      default:
        rawPositional.push(raw);
        break;
    }
  }

  const positional = normalizePathPrefixedCommand(rawPositional);
  const command = positional[0] ?? "help";
  return {
    command,
    positional,
    flags,
  };
}

function normalizePathPrefixedCommand(positional: string[]): string[] {
  const pathPrefix = positional[0];
  const command = positional[1];
  if (!pathPrefix?.startsWith("/") || !command) return positional;
  if (!["memory", "rule", "skill", "search"].includes(command)) return positional;
  return [command, ...positional.slice(2), pathPrefix];
}
