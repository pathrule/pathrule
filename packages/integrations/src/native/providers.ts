// SPDX-License-Identifier: Apache-2.0
// The AI coding agents Pathrule knows, and what is installed on this machine.
//
// Two of them have a native integration (a provider plugin through the provider's own plugin
// manager). The others are detected so a person sees them, and are offered only what Pathrule really
// supports for them today; nothing is pretended.

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import type { IntegrationProviderId } from "@pathrule/protocol/integration-registry.js";

export type KnownProviderId = IntegrationProviderId;

export interface ProviderDescriptor {
  id: KnownProviderId;
  displayName: string;
  /** Executables that prove the agent is installed, first match wins. */
  binaries: readonly string[];
  /** The agent's own config directory under the home directory. */
  configDir: string;
  /** What `pathrule integrations` can install for it. */
  support: "native-plugin" | "mcp-and-hooks-via-cli" | "not-yet";
  /** One line about the support level, shown beside the provider. */
  note: string;
}

export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    binaries: ["claude"],
    configDir: ".claude",
    support: "native-plugin",
    note: "Native plugin: hooks, MCP, skills and commands.",
  },
  {
    id: "codex",
    displayName: "Codex",
    binaries: ["codex"],
    configDir: ".codex",
    support: "native-plugin",
    note: "Native plugin: skills and MCP; hooks run after you trust them in /hooks.",
  },
  {
    id: "cursor",
    displayName: "Cursor",
    binaries: ["cursor", "cursor-agent"],
    configDir: ".cursor",
    support: "native-plugin",
    note: "Native plugin: hooks, MCP and skills; you install it from Cursor's Marketplace.",
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    binaries: ["opencode"],
    configDir: join(".config", "opencode"),
    support: "native-plugin",
    note: "Native plugin (npm @pathrule/opencode): MCP, skills, and Pathrule's context at each prompt and tool.",
  },
  {
    id: "gemini",
    displayName: "Gemini CLI",
    binaries: ["gemini"],
    configDir: ".gemini",
    support: "native-plugin",
    note: "Native extension: hooks, MCP, skills and a context file.",
  },
];

export function providerDescriptor(id: KnownProviderId): ProviderDescriptor {
  const found = PROVIDERS.find((p) => p.id === id);
  if (!found) throw new Error(`unknown_provider:${id}`);
  return found;
}

const PROVIDER_ALIASES: Record<string, KnownProviderId> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  claudecode: "claude-code",
  codex: "codex",
  "openai-codex": "codex",
  cursor: "cursor",
  opencode: "opencode",
  gemini: "gemini",
  "gemini-cli": "gemini",
};

export function parseProviderId(raw: string): KnownProviderId | null {
  return PROVIDER_ALIASES[raw.trim().toLowerCase()] ?? null;
}

export function isNativeProvider(id: KnownProviderId): id is IntegrationProviderId {
  return providerDescriptor(id).support === "native-plugin";
}

export interface DetectedProvider {
  id: KnownProviderId;
  displayName: string;
  support: ProviderDescriptor["support"];
  note: string;
  /** The executable found on PATH, or null. */
  binary: string | null;
  /** `--version` output (first line), when the binary answered within the deadline. */
  version: string | null;
  configDir: string;
  configDirExists: boolean;
  /** The agent is on this machine: its executable or its config directory exists. */
  detected: boolean;
}

/** Find an executable by name on PATH (PATHEXT on Windows). */
export async function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase()) : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        await access(candidate, fsConstants.X_OK);
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/**
 * One argument for `cmd.exe`: Windows runs a `.cmd` shim (npm's `claude.cmd`, `codex.cmd`) only
 * through a shell (Node refuses it otherwise, CVE-2024-27980), and a path with a space, as a user
 * folder often has, must reach it whole.
 */
export function quoteForWindowsShell(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** Run `<binary> --version` with a hard deadline; null when it fails or is slow. */
export async function probeVersion(binary: string, timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const windows = process.platform === "win32";
      const child = spawn(windows ? quoteForWindowsShell(binary) : binary, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
        shell: windows,
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null);
      }, timeoutMs);
      timer.unref();
      child.stdout.on("data", (chunk: Buffer) => {
        if (out.length < 4096) out += chunk.toString("utf8");
      });
      child.on("error", () => finish(null));
      child.on("close", (code) => {
        clearTimeout(timer);
        const line = out.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? null;
        finish(code === 0 ? line : null);
      });
    } catch {
      finish(null);
    }
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** What is installed on this machine, for every known provider. */
export async function detectProviders(
  options: { env?: NodeJS.ProcessEnv; home?: string; probeVersions?: boolean } = {},
): Promise<DetectedProvider[]> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  return Promise.all(
    PROVIDERS.map(async (p): Promise<DetectedProvider> => {
      let binary: string | null = null;
      for (const name of p.binaries) {
        binary = await findOnPath(name, env);
        if (binary) break;
      }
      const configDir = join(home, p.configDir);
      const configDirExists = await exists(configDir);
      const version =
        binary && options.probeVersions !== false && p.support === "native-plugin" ? await probeVersion(binary) : null;
      return {
        id: p.id,
        displayName: p.displayName,
        support: p.support,
        note: p.note,
        binary,
        version,
        configDir,
        configDirExists,
        detected: binary !== null || configDirExists,
      };
    }),
  );
}
