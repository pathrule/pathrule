// SPDX-License-Identifier: Apache-2.0
// A local sync serves the agents in use: Claude Code always; Codex only with Pathrule's own Codex wiring.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enginesInUse } from "./disk-detection.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const fresh = () => { const d = mkdtempSync(join(tmpdir(), "pr-engines-")); dirs.push(d); return d; };
// An empty Pathrule home: no recorded integration speaks for any folder.
const env = (): NodeJS.ProcessEnv => ({ PATHRULE_HOME: fresh() });

describe("the agents a local sync serves", () => {
  it("is Claude Code alone in a repository with no other agent's footprint, whatever is installed", async () => {
    expect(await enginesInUse(fresh(), env())).toEqual(["claude-code"]);
  });

  // The person's AGENTS.md is a cross-agent standard, not a Codex setup: taking it for one wrote Codex's
  // files into a project whose setup named only Claude Code.
  it("does not add Codex for the person's own AGENTS.md or Codex config", async () => {
    const repo = fresh();
    writeFileSync(join(repo, "AGENTS.md"), "# agents\n");
    mkdirSync(join(repo, ".codex"));
    writeFileSync(join(repo, ".codex", "config.toml"), 'model = "o4"\n');
    expect(await enginesInUse(repo, env())).toEqual(["claude-code"]);
  });

  it("adds Codex when Pathrule was set up for Codex here", async () => {
    for (const [rel, body] of [
      [".codex/hooks.json", JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/h/.pathrule/bin/pathrule-hook.js" }] }] } })],
      [".codex/config.toml", "# >>> Pathrule managed (codex hook activation) >>>\n[features]\nhooks = true\n# <<< Pathrule managed <<<\n"],
      ["AGENTS.md", "# agents\n\n<!-- pathrule:begin (managed by Pathrule) -->\nx\n<!-- pathrule:end -->\n"],
    ] as const) {
      const repo = fresh();
      mkdirSync(join(repo, ".codex"), { recursive: true });
      writeFileSync(join(repo, rel), body);
      expect(await enginesInUse(repo, env()), rel).toEqual(["claude-code", "codex"]);
    }
  });
});
