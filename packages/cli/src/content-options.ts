// SPDX-License-Identifier: Apache-2.0
// Parsing and rendering the knowledge commands (`search`, `memory`, `rule`, `skill`) share in every
// edition: the local store and the account list the same rows the same way.
import type { Writable } from "node:stream";

import { escapeTerminalControlChars } from "@pathrule/core/util/safe-name.js";

import type { CliContentItem, CliContentKind } from "./content-helpers.js";
import { statusLabel, type CliOutputMode } from "./output.js";

export function parseContentOptions(args: string[]): {
  path?: string;
  limit?: number;
  types?: CliContentKind[];
  open: boolean;
  print: boolean;
  forceWeb: boolean;
  positionals: string[];
} {
  const options: {
    path?: string;
    limit?: number;
    types?: CliContentKind[];
    open: boolean;
    print: boolean;
    forceWeb: boolean;
    positionals: string[];
  } = {
    open: false,
    print: false,
    forceWeb: false,
    positionals: [],
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--path") {
      options.path = args[++i];
    } else if (arg === "--limit") {
      options.limit = Number(args[++i]);
    } else if (arg === "--type") {
      options.types = parseContentTypes(args[++i]);
    } else if (arg === "--open") {
      options.open = true;
    } else if (arg === "--print") {
      options.print = true;
    } else if (arg === "--web") {
      options.forceWeb = true;
    } else if (arg?.startsWith("/") && options.positionals.length === 0 && !options.path) {
      options.path = arg;
    } else if (arg) {
      options.positionals.push(arg);
    }
  }
  return options;
}

function parseContentTypes(value: string | undefined): CliContentKind[] {
  if (!value) return [];
  const valid = new Set<CliContentKind>(["memory", "rule", "skill"]);
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is CliContentKind => valid.has(item as CliContentKind));
}

export function renderContentRows(
  stream: Pick<Writable, "write">,
  mode: CliOutputMode,
  items: CliContentItem[],
): void {
  if (items.length === 0) {
    stream.write(`${statusLabel("warn", mode)} No content found.\n`);
    return;
  }
  for (const [index, item] of items.entries()) {
    const label = item.kind[0]!.toUpperCase() + item.kind.slice(1);
    const prefix = `${index + 1}. [${label}] `;
    const detailWidth = 76;
    const updated = item.updated_at?.slice(0, 10);
    stream.write(
      [
        `${prefix}${compactContentLine(item.title, Math.max(12, 80 - prefix.length))}`,
        `   ${compactContentLine(item.path ?? "/", updated ? detailWidth - updated.length - 3 : detailWidth)}${updated ? ` · ${updated}` : ""}`,
        item.preview ? `   ${compactContentLine(item.preview, detailWidth)}` : "",
      ]
        .filter(Boolean)
        .join("\n") + "\n\n",
    );
  }
}

function compactContentLine(value: string, maxLength: number): string {
  const clean = escapeTerminalControlChars(value.replace(/\s+/gu, " ").trim());
  const chars = Array.from(clean);
  return chars.length <= maxLength ? clean : `${chars.slice(0, maxLength - 1).join("")}…`;
}

export function requiredArg(value: string | undefined, code: string): string {
  if (!value) throw new Error(code);
  return value;
}
