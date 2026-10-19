// SPDX-License-Identifier: Apache-2.0
// The host stands on the open foundation alone. It never imports a surface (the CLI, MCP, VS Code),
// the Engine or Pathrule Cloud, so its suite runs, and the host starts, with none of them
// installed. It reaches Cloud only as a plugin.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** The open packages the host may build on (its place in the dependency graph). */
const ALLOWED_PACKAGES = [
  "@pathrule/protocol",
  "@pathrule/agent-ir",
  "@pathrule/core",
  "@pathrule/integrations",
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.ts$/.test(entry) ? [full] : [];
  });
}

function specifiers(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(
    /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/g,
  )) {
    found.push(match[1]!);
  }
  for (const match of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]!);
  return found;
}

describe("the host's imports", () => {
  it("are node builtins, relative modules, the open foundation, and vitest in tests", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const isTest = file.endsWith(".test.ts");
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        const ok =
          spec.startsWith("node:") ||
          spec.startsWith(".") ||
          ALLOWED_PACKAGES.some((pkg) => spec === pkg || spec.startsWith(`${pkg}/`)) ||
          (isTest && spec === "vitest");
        if (!ok) offenders.push(`${relative(SRC, file)}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("finds the imports it checks", () => {
    expect(specifiers(readFileSync(join(SRC, "host.ts"), "utf8"))).toContain("./discovery.js");
  });
});
