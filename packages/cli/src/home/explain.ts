// SPDX-License-Identifier: Apache-2.0
// What the terminal experience says when something is missing or fails: one line a person can act
// on, never a wall of npm output, never a secret, and never a different story than the real error.
//
// - `sanitize` keeps a message safe to show: the home directory as `~`, no credentials in URLs, no
//   token-shaped strings, one line.
// - `explainInstallFailure` names the cause of a capability install failure in plain words when it
//   is recognisable (not on the registry, offline, no permission, disk full) and otherwise shows
//   the first meaningful line of the real error. `pathrule doctor` keeps the full reason.
import { homedir } from "node:os";

import { terminalSafe } from "../terminal/text.js";

const TOKEN_SHAPES: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\b(?:Bearer|bearer)\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /\b(?:access|refresh|id)_token["'=:\s]+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** `text` safe for a terminal line: no home path, no credentials, no tokens, one line, bounded. */
export function sanitize(text: string, env: NodeJS.ProcessEnv = process.env, max = 240): string {
  let out = terminalSafe(text);
  for (const home of [env.HOME, homedir()].filter((h): h is string => !!h && h !== "/")) {
    out = out.split(home).join("~");
  }
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1***@");
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, "[redacted]");
  out = out
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** The package and version an npm failure names (`<name>@<version>`). */
function packageOf(reason: string): string | null {
  return /npm install (\S+@\S+?)(?::|\s|$)/.exec(reason)?.[1] ?? null;
}

/**
 * A capability install failure (`CapabilityProblem.reason`) as one line: the cause when npm said
 * one we know, else the first meaningful line of the real error.
 */
export function explainInstallFailure(
  reason: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const pkg = packageOf(reason);
  const named = pkg ? `${pkg} ` : "the package ";
  if (/not tried: Pathrule Cloud also needs/i.test(reason)) {
    return "not tried: Pathrule Cloud needs a capability that could not be installed.";
  }
  if (/\bE404\b|\b404\b|could not be found or you do not have permission/i.test(reason)) {
    return `${named}is not available from the npm registry (404).`;
  }
  if (
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ENETUNREACH|network|proxy/i.test(reason)
  ) {
    return "npm could not reach its registry (offline, a proxy or a firewall).";
  }
  if (/\bEACCES\b|\bEPERM\b/.test(reason)) {
    return "npm was not allowed to write into the Pathrule home.";
  }
  if (/\bENOSPC\b|no space left/i.test(reason)) return "the disk is full.";
  if (/E401|E403|ENEEDAUTH|authentication/i.test(reason)) {
    return "npm was refused by its registry (authentication).";
  }
  const first = reason
    .split(/\s\|\s|\n/)
    .map((part) => part.replace(/^npm (?:error|ERR!)\s*/i, "").trim())
    .find((part) => part.length > 0 && !/complete log of this run/i.test(part));
  return sanitize(first ?? reason, env, 160);
}
