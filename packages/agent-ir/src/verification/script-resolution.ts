// SPDX-License-Identifier: Apache-2.0
/**
 * What does a package-manager script actually run?
 *
 * PURE. No `node:fs`, no imports beyond types, on purpose: `validateCheckInput` is
 * reached from the remote MCP in Pathrule Cloud, which has no repo filesystem at all. Putting I/O inside the shared
 * validator would make CHECK authoring impossible there rather than merely unresolved.
 *
 * So the split is: the caller that HAS a filesystem collects package.json data and hands
 * it in; this module answers from that data alone. A caller with no filesystem passes
 * nothing and gets `unresolved`, which is a stated outcome rather than a silent pass.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT.
 *
 * It exists so the authoring layer can (a) refuse a requirement that provably never
 * terminates and (b) show a human what they are approving. It is NOT a second source of
 * runtime authority: evidence matching stays on the canonical fingerprint, and nothing
 * here is consulted at runtime.
 *
 * It is also not a shell interpreter. It follows the pnpm script forms this repo actually
 * uses and says `unresolved` for everything else. A generic interpreter would be the
 * wrong kind of confident.
 */

import type { ResolvedCommand } from "@pathrule/protocol/rule-atoms.js";

// What a check atom stores about its command is part of the open format contract (@pathrule/protocol).
export type { ResolutionStatus, ResolvedCommand } from "@pathrule/protocol/rule-atoms.js";

/** One package.json, as the caller read it. */
export interface PackageScripts {
  /** The `name` field, or null for a package.json without one. */
  name: string | null;
  /** Workspace-relative directory, e.g. "/" or "/packages/app". */
  dir: string;
  scripts: Record<string, string>;
}

const MAX_DEPTH = 4;
const MAX_CHAIN = 12;

/**
 * Flags that put any runner into watch mode. Proven non-terminating: a watch process does
 * not exit, so its exit code can never be evidence about the code under test.
 */
const WATCH_FLAGS = new Set(["--watch", "-w", "--watchAll", "--watch-all"]);

/**
 * Runners that watch UNLESS told to run once. `vitest` is the measured case: the script
 * `@pathrule/app test:watch` is exactly `vitest`, and the old authoring path accepted it.
 */
const WATCH_BY_DEFAULT = new Set(["vitest"]);

/**
 * Programs whose named subcommand is a long-running server. Deliberately short: every
 * entry has to be something that provably does not exit, and a wrong entry here is a
 * false rejection of a legitimate requirement.
 */
const DEV_SERVERS: Array<[string, string]> = [
  ["vite", "dev"],
  ["next", "dev"],
  ["storybook", "dev"],
  ["electron-forge", "start"],
];

/**
 * Programs that serve unless given one of their terminating subcommands. Measured need:
 * `@pathrule/web dev` is `vite --host 127.0.0.1`, which has an operand but is still a
 * server, so "no subcommand at all" was not a sufficient test.
 */
const SERVER_UNLESS: Array<[string, ReadonlySet<string>]> = [
  ["vite", new Set(["build", "optimize"])],
  ["nodemon", new Set()],
];

function tokens(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function basename(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash === -1 ? token : token.slice(slash + 1);
}

/**
 * Is this single concrete command provably non-terminating?
 *
 * Only returns a reason when the evidence is in the command itself. Anything uncertain
 * returns null, because a false rejection here blocks a legitimate CHECK and the brief
 * for this layer is precision, not recall.
 */
export function provenNonTerminating(command: string): string | null {
  const parts = tokens(command);
  if (parts.length === 0) return null;

  for (const t of parts) {
    if (WATCH_FLAGS.has(t)) return `runs with ${t}, which never exits`;
  }

  // Peel env assignments and wrappers so `CI=1 vitest` is still seen as vitest.
  let head = 0;
  while (head < parts.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[head]!) || ["time", "env", "exec", "nohup", "nice", "sudo", "command"].includes(basename(parts[head]!)))) {
    head += 1;
  }
  if (head >= parts.length) return null;
  const program = basename(parts[head]!);
  const rest = parts.slice(head + 1);
  const bare = rest.filter((t) => !t.startsWith("-"));

  if (WATCH_BY_DEFAULT.has(program) && !rest.some((t) => t === "run" || t === "--run")) {
    return `${program} watches unless given "run"`;
  }
  for (const [prog, sub] of DEV_SERVERS) {
    if (program === prog && bare[0] === sub) return `${prog} ${sub} is a long-running server`;
  }
  for (const [prog, terminating] of SERVER_UNLESS) {
    if (program !== prog) continue;
    const sub = bare[0];
    if (!sub || !terminating.has(sub)) {
      return sub
        ? `${prog} ${sub} is a long-running server`
        : `${prog} with no terminating subcommand is a long-running server`;
    }
  }
  return null;
}

/** Split a script body on `&&` / `;` / newlines. Pipes are handled by the caller. */
function segments(body: string): string[] {
  return body.split(/\n|&&|[;]/g).map((s) => s.trim()).filter(Boolean);
}

interface Target {
  pkg: PackageScripts;
  script: string;
}

/** Which package does an invocation target, and which script? */
function readInvocation(
  command: string,
  packages: readonly PackageScripts[],
  rootPkg: PackageScripts | undefined,
): { targets: Target[]; recursive: boolean; reason: string | null } {
  const parts = tokens(command);
  let head = 0;
  while (head < parts.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[head]!) || ["time", "env", "exec", "nohup", "nice", "sudo", "command"].includes(basename(parts[head]!)))) {
    head += 1;
  }
  const family = head < parts.length ? basename(parts[head]!) : "";
  if (!["pnpm", "npm", "yarn"].includes(family)) {
    return { targets: [], recursive: false, reason: `"${command}" is not a package-manager script invocation` };
  }
  const rest = parts.slice(head + 1);

  let filter: string | null = null;
  let recursive = false;
  const bare: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i]!;
    if (t === "-r" || t === "--recursive") {
      recursive = true;
      continue;
    }
    const inline = /^(--filter|--workspace)=(.*)$/.exec(t);
    if (inline) {
      filter = inline[2]!;
      continue;
    }
    if (t === "--filter" || t === "-F" || t === "--workspace") {
      filter = rest[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (t.startsWith("-")) continue;
    bare.push(t);
  }

  let script = bare[0] ?? null;
  if (script === "run" || script === "exec") script = bare[1] ?? null;
  if (!script) return { targets: [], recursive, reason: `no script name in "${command}"` };

  if (filter) {
    const clean = filter.replace(/^["']|["']$/g, "");
    const pkg = packages.find((p) => p.name === clean) ?? packages.find((p) => p.dir === `/${clean.replace(/^\.\//, "").replace(/\/+$/, "")}`);
    if (!pkg) return { targets: [], recursive, reason: `no package matching filter "${clean}"` };
    if (!(script in pkg.scripts)) return { targets: [], recursive, reason: `package "${clean}" has no script "${script}"` };
    return { targets: [{ pkg, script }], recursive, reason: null };
  }

  if (recursive) {
    const hits = packages.filter((p) => script! in p.scripts && p.dir !== "/");
    if (hits.length === 0) return { targets: [], recursive, reason: `no package defines script "${script}"` };
    return { targets: hits.map((pkg) => ({ pkg, script: script! })), recursive, reason: null };
  }

  if (!rootPkg) return { targets: [], recursive, reason: "workspace root package.json was not supplied" };
  if (!(script in rootPkg.scripts)) return { targets: [], recursive, reason: `the workspace root has no script "${script}"` };
  return { targets: [{ pkg: rootPkg, script }], recursive, reason: null };
}

/**
 * Follow a command through the script graph and report what it ends up running.
 *
 * `packages` is what the caller read from disk. An empty list means "no filesystem here",
 * which yields `unresolved` rather than an assumption.
 */
export function resolveScriptCommand(
  command: string,
  packages: readonly PackageScripts[],
): ResolvedCommand {
  if (typeof command !== "string" || command.trim() === "") {
    return { status: "unresolved", runs: null, chain: [], reason: "empty command" };
  }
  if (packages.length === 0) {
    return { status: "unresolved", runs: null, chain: [], reason: "no package.json data was available on this surface" };
  }
  const rootPkg = packages.find((p) => p.dir === "/");
  const chain: string[] = [command];
  const seen = new Set<string>();
  const leaves: string[] = [];
  let unresolvedReason: string | null = null;

  const walk = (cmd: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      unresolvedReason = unresolvedReason ?? `script chain deeper than ${MAX_DEPTH} levels`;
      return;
    }
    const { targets, reason } = readInvocation(cmd, packages, rootPkg);
    if (targets.length === 0) {
      // Not a script invocation: this IS the leaf.
      if (reason && reason.includes("not a package-manager script invocation")) leaves.push(cmd.trim());
      else unresolvedReason = unresolvedReason ?? reason;
      return;
    }
    for (const t of targets) {
      const key = `${t.pkg.dir}|${t.script}`;
      if (seen.has(key)) {
        // A script that reaches itself. Real in this repo: the root `typecheck` is
        // `pnpm -r --parallel typecheck`, which names the per-package script of the same
        // name. Stop rather than loop, and do not treat it as unresolved.
        continue;
      }
      seen.add(key);
      const body = t.pkg.scripts[t.script]!;
      if (chain.length < MAX_CHAIN) {
        chain.push(`${t.pkg.name ?? t.pkg.dir}:${t.script} = ${body}`);
      }
      for (const seg of segments(body)) walk(seg, depth + 1);
    }
  };

  walk(command, 0);

  for (const leaf of leaves) {
    const why = provenNonTerminating(leaf);
    if (why) {
      return { status: "non_terminating", runs: leaf, chain, reason: `${leaf}: ${why}` };
    }
  }
  // The invocation itself can be a watch even when it resolves to scripts (`--watch`
  // passed through on the command line).
  const direct = provenNonTerminating(command);
  if (direct) return { status: "non_terminating", runs: null, chain, reason: `${command}: ${direct}` };

  if (leaves.length === 0) {
    return {
      status: "unresolved",
      runs: null,
      chain,
      reason: unresolvedReason ?? "the script chain reached no concrete command",
    };
  }
  return {
    status: "resolved",
    runs: leaves.length === 1 ? leaves[0]! : null,
    chain,
    reason: leaves.length === 1 ? null : `${leaves.length} concrete commands (recursive or chained)`,
  };
}
