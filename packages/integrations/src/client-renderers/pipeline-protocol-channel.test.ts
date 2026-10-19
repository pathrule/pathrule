// SPDX-License-Identifier: Apache-2.0
// The wiring, end to end through the real local pipeline: ONE decision reaches
// both writers.
//
// The unit tests below this layer prove the decision is correct and that each
// writer honours it. What only an integration test can prove is that the two
// writers receive the SAME one, which is the whole reason the pipeline returns
// its decision instead of letting the caller re-derive it.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { InMemoryKnowledgeBackend } from "@pathrule/core";

import { __resetHookCommandForTests, setHookCommand } from "../hook-supervisor/hook-command.js";
import { syncHookIndex } from "../index-writers/hook-index-writer.js";
import { rerenderMultiClientLocal } from "./pipeline.js";
import { __resetLegacySweepForTests } from "./legacy-sweep.js";
import { invalidateRecoveryLatch } from "./protocol-channel-fs.js";

beforeAll(() => setHookCommand("/home/pat/.pathrule/bin/pathrule-hook.js"));
afterAll(() => __resetHookCommandForTests());

const WS = "aaaaaaaa-1111-2222-3333-444444444444";
const HOOK_CONFIG = JSON.stringify({
  hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "/x/pathrule-hook.js" }] }] },
});

const dirs: string[] = [];
afterEach(async () => {
  invalidateRecoveryLatch();
  __resetLegacySweepForTests();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A workspace with the codex hook installed and one memory to compile. */
async function scene() {
  const root = await mkdtemp(join(tmpdir(), "pathrule-wiring-root-"));
  const home = await mkdtemp(join(tmpdir(), "pathrule-wiring-home-"));
  dirs.push(root, home);

  // Codex on disk (AGENTS.md is its marker) plus its hook config.
  await writeFile(join(root, "AGENTS.md"), "# placeholder\n");
  await mkdir(join(root, ".codex"), { recursive: true });
  await writeFile(join(root, ".codex", "hooks.json"), HOOK_CONFIG);

  let n = 0;
  const backend = new InMemoryKnowledgeBackend({
    genId: () => `id-${++n}`,
    now: () => "2026-08-25T00:00:00.000Z",
  });
  backend.registerWorkspace({ workspaceId: WS, localRootPath: root });
  return { root, home, backend };
}

async function render(root: string, home: string, backend: InMemoryKnowledgeBackend, on: boolean) {
  const env = {
    PATHRULE_HOME: home,
    PATHRULE_SIGNATURE_MODE: on ? "on" : "off",
  } as NodeJS.ProcessEnv;
  const outcome = await rerenderMultiClientLocal({
    backend,
    workspaceId: WS,
    workspaceName: "wiring",
    workspaceRoot: root,
    userId: "local",
    env,
    resolveChannel: true,
  });
  const index = await syncHookIndex({
    backend,
    workspaceId: WS,
    workspaceRoot: root,
    env,
    refreshEpisodes: false,
    protocol: outcome.protocolChannel?.protocol,
  });
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  const written = index.path ? JSON.parse(await readFile(index.path, "utf8")) : {};
  return { outcome, agents, indexProtocol: written.protocol as string | undefined };
}

describe("protocol channel through the local pipeline", () => {
  it("with the switch on: the file gets the signature and the index gets the protocol", async () => {
    const { root, home, backend } = await scene();
    const { outcome, agents, indexProtocol } = await render(root, home, backend, true);

    expect(outcome.ok).toBe(true);
    expect(outcome.protocolChannel?.signatureClients).toContain("codex");
    // The person's AGENTS.md is left exactly as it was: the hook carries the protocol.
    expect(agents).toBe("# placeholder\n");
    expect(indexProtocol ?? "").toContain("pathrule_get_context");
  });

  it("with the switch off: the file keeps the protocol and the index carries none", async () => {
    const { root, home, backend } = await scene();
    const { outcome, agents, indexProtocol } = await render(root, home, backend, false);

    expect(outcome.protocolChannel?.off).toBe("flag_off");
    expect(agents).toContain("pathrule_get_context");
    expect(indexProtocol).toBeUndefined();
  });

  // The property that matters, stated as a property: whichever way the switch is
  // set, the protocol reaches the agent through exactly one channel.
  it("delivers the protocol through exactly one channel either way", async () => {
    for (const on of [true, false]) {
      const { root, home, backend } = await scene();
      const { agents, indexProtocol } = await render(root, home, backend, on);
      const onDisk = agents.includes("pathrule_get_context");
      const onIndex = (indexProtocol ?? "").includes("pathrule_get_context");
      expect([onDisk, onIndex].filter(Boolean).length, `switch=${on}`).toBe(1);
    }
  });

  // The person's own AGENTS.md is not a Codex setup: without Pathrule's Codex wiring the folder is not
  // served as Codex, and the file is not touched.
  it("does not take a folder for a Codex one because it has an AGENTS.md", async () => {
    const { root, home, backend } = await scene();
    await rm(join(root, ".codex", "hooks.json"));
    const { outcome, agents } = await render(root, home, backend, true);

    expect(outcome.enabled).not.toContain("codex");
    expect(agents).toBe("# placeholder\n");
    expect(existsSync(join(root, ".codex", "hooks.json"))).toBe(false);
  });

  // Codex's renderer installs its hook in the same render, so even its first sync writes nothing into
  // the person's AGENTS.md: there is no full-protocol first pass for the second sync to take back.
  it("takes a Codex folder to the hook channel on its very first sync", async () => {
    const { root, home, backend } = await scene();
    await rm(join(root, ".codex", "hooks.json"));
    await writeFile(join(root, ".codex", "config.toml"), "# >>> Pathrule managed (codex hook activation) >>>\n[features]\nhooks = true\n# <<< Pathrule managed <<<\n");
    const { outcome, agents, indexProtocol } = await render(root, home, backend, true);

    expect(outcome.protocolChannel?.signatureClients).toContain("codex");
    expect(agents).toBe("# placeholder\n");
    expect(indexProtocol ?? "").toContain("pathrule_get_context");
    expect(readFileSync(join(root, ".codex", "hooks.json"), "utf8")).toContain("pathrule-hook");
  });
});

// The migration nobody should have to ask for: an existing repo's junk backups
// go on the next ordinary sync, and the user's do not.
describe("legacy sweep through the pipeline", () => {
  it("removes Pathrule's own leftovers on an ordinary sync and reports them", async () => {
    const { root, home, backend } = await scene();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(root, "backup.AGENTS.md"),
      "<!-- managed by Pathrule — do not edit this file manually. -->\n# ours\n",
    );

    const { outcome } = await render(root, home, backend, false);

    expect(outcome.legacySweep?.removed).toEqual(["backup.AGENTS.md"]);
    await expect(readFile(join(root, "backup.AGENTS.md"), "utf8")).rejects.toThrow();
  });

  it("leaves the user's own backup alone and reports it for a decision", async () => {
    const { root, home, backend } = await scene();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "backup.AGENTS.md"), "# The user's real instructions\n");

    const { outcome } = await render(root, home, backend, false);

    expect(outcome.legacySweep?.removed).toEqual([]);
    expect(outcome.legacySweep?.held).toEqual(["backup.AGENTS.md"]);
    expect(await readFile(join(root, "backup.AGENTS.md"), "utf8")).toBe(
      "# The user's real instructions\n",
    );
  });

  it("does not need signature mode: the leftovers are a fixed bug's residue", async () => {
    for (const on of [false, true]) {
      __resetLegacySweepForTests();
      const { root, home, backend } = await scene();
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        join(root, "backup.AGENTS.md"),
        "<!-- managed by Pathrule — do not edit this file manually. -->\n# ours\n",
      );
      const { outcome } = await render(root, home, backend, on);
      expect(outcome.legacySweep?.removed, `switch=${on}`).toEqual(["backup.AGENTS.md"]);
    }
  });
});
