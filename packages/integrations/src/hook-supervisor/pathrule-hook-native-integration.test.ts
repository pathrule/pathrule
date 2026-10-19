// SPDX-License-Identifier: Apache-2.0
// The hook's native-integration behaviour, run as the real script in child processes:
//
// - a native plugin's registration and a legacy settings registration of the same event: one run;
// - the provider's context limit: nothing past it is sent, cuts land on a line or a word, and a body
//   that was cut is not recorded as delivered (the ledger records why);
// - the session delivery ledger: what the MCP server delivered is not injected again, what the hook
//   delivered is readable by the MCP side, and a compaction starts a new epoch;
// - a session without MCP gets the protocol that names no `pathrule_*` tool;
// - an index this hook cannot read is skipped with a notice, never half-read;
// - a plugin user in a folder that is not a workspace gets one pointer, once;
// - hook-triggered maintenance spawns only with the recorded consent;
// - a Pathrule Local workspace never reaches the cloud extension's account-facing checks.

import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { HOOK_EXTENSION_CONTRACT } from "@pathrule/protocol/hook-extension.js";

import { appendDeliveryReceipts, readDeliveryLedger } from "../native/delivery-ledger.js";
import { renderHookOnlyProtocol, renderProtocolRulesFile } from "../pathrule-protocol.js";

const HOOK_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS = "99999999-9999-4999-8999-999999999999";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

const TOPICS = ["auth", "billing", "search", "upload", "cache", "queue"] as const;
const body = (slug: string, bulk: number) =>
  `# ${slug}\n\n${slug} decisions for the ${slug} module.\n\n` +
  `Rule of the ${slug} module: keep the ${slug} path owned by the platform team.\n`.repeat(bulk);

interface Home {
  home: string;
  hook: string;
  wsRoot: string;
  stub: string;
}

async function makeHome(
  opts: {
    bulk?: number;
    digest?: string;
    protocol?: boolean;
    schema?: number;
    generatedAt?: string;
  } = {},
): Promise<Home> {
  const home = await mkdtemp(join(tmpdir(), "pathrule-native-"));
  homes.push(home);
  const hook = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hook), { recursive: true });
  await copyFile(HOOK_SOURCE, hook);
  const stub = join(home, "bin", "stub.cjs");
  await writeFile(stub, `process.stdin.resume();process.stdin.on("end",()=>process.exit(3));`);
  const wsRoot = join(home, "project");
  await mkdir(join(wsRoot, "src"), { recursive: true });
  const cache = join(home, "cache", WS);
  await mkdir(cache, { recursive: true });
  const pathMemories: Record<string, unknown[]> = {};
  const warehouse: Record<string, unknown> = {};
  for (const slug of TOPICS) {
    const id = `mem-${slug}`;
    const text = body(slug, opts.bulk ?? 4);
    warehouse[id] = {
      type: "memory",
      title: `${slug} decisions`,
      body: text,
      content_hash: `h-${slug}`,
    };
    pathMemories[`/src/${slug}`] = [
      {
        id,
        title: `${slug} decisions`,
        preview: `${slug} module decisions`,
        node_path: `/src/${slug}`,
        content_hash: `h-${slug}`,
      },
    ];
  }
  const index: Record<string, unknown> = {
    schema_version: opts.schema ?? 2,
    workspace_id: WS,
    workspace_root: wsRoot,
    generated_at: opts.generatedAt ?? "2026-10-01T00:00:00.000Z",
    session_digest: opts.digest ?? "",
    path_memories: pathMemories,
    path_rules: {},
    project_rules: [],
  };
  if (opts.protocol) {
    index.protocol = renderProtocolRulesFile();
    index.protocol_without_mcp = renderHookOnlyProtocol();
  }
  await writeFile(join(cache, "hook-index.json"), JSON.stringify(index));
  await writeFile(join(cache, "warehouse.json"), JSON.stringify(warehouse));
  return { home, hook, wsRoot, stub };
}

function fire(
  h: Home,
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [h.hook],
      {
        env: { ...process.env, PATHRULE_HOME: h.home, PATHRULE_EMBED_HELPER: h.stub, ...env },
        timeout: 15_000,
      },
      (error, stdout) => {
        if (error && typeof error.code === "number" && error.code !== 0)
          reject(new Error(`hook exited ${error.code}`));
        else resolve(stdout.trim());
      },
    );
    child.stdin!.end(JSON.stringify({ cwd: h.wsRoot, ...payload }));
  });
}

const contextOf = (out: string): string => {
  try {
    return JSON.parse(out)?.hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return "";
  }
};

const prompt = (
  session: string,
  text = "auth billing search upload cache queue module decisions",
) => ({
  hook_event_name: "UserPromptSubmit",
  session_id: session,
  prompt: text,
});

async function hookLog(home: string): Promise<string> {
  const dir = join(home, "logs");
  const files = await readdir(dir).catch(() => []);
  return (await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")))).join("");
}

describe("one event, one run", () => {
  it("a plugin registration and a settings registration of the same event deliver once", async () => {
    const h = await makeHome();
    const payload = prompt("s-dup");
    const [a, b] = await Promise.all([
      fire(h, payload, { PATHRULE_HOOK_CHANNEL: "plugin" }),
      fire(h, payload),
    ]);
    const delivered = [contextOf(a), contextOf(b)].filter((c) => c.length > 0);
    expect(delivered).toHaveLength(1);
    expect(await hookLog(h.home)).toContain("duplicate_registration");
  });

  it("the same registration firing an identical event again is a new event, not a duplicate", async () => {
    const h = await makeHome();
    await fire(h, prompt("s-same"));
    await fire(h, prompt("s-same"));
    expect(await hookLog(h.home)).not.toContain("duplicate_registration");
  });
});

describe("the provider's context limit", () => {
  it("keeps Claude Code's output, protocol included, within 10,000 characters", async () => {
    const h = await makeHome({ bulk: 40, protocol: true });
    const context = contextOf(
      await fire(h, prompt("s-claude"), { PATHRULE_HOOK_PROVIDER: "claude-code" }),
    );
    expect(context.length).toBeGreaterThan(0);
    expect(context.length).toBeLessThanOrEqual(10_000);
    expect(context).toContain("Pathrule Protocol");
  });

  it("keeps Codex's output within its budget", async () => {
    const h = await makeHome({ bulk: 40, protocol: true });
    const context = contextOf(
      await fire(h, prompt("s-codex"), { PATHRULE_HOOK_PROVIDER: "codex" }),
    );
    expect(context.length).toBeLessThanOrEqual(7_000);
  });

  it("cuts at a line or word boundary, and a cut body is neither marked delivered nor confirmed", async () => {
    const h = await makeHome({ bulk: 12 });
    const out = contextOf(
      await fire(h, prompt("s-cut"), {
        PATHRULE_HOOK_PROVIDER: "claude-code",
        PATHRULE_PROVIDER_CONTEXT_LIMIT: "2500",
      }),
    );
    expect(out.length).toBeLessThanOrEqual(2500);
    const state = JSON.parse(
      await readFile(join(h.home, "cache", WS, "session-s-cut.json"), "utf8"),
    );
    const ledger = await readDeliveryLedger(WS, "s-cut", { PATHRULE_HOME: h.home });
    for (const id of state.injected_memory_ids as string[]) {
      // Everything recorded as injected is in the output in full.
      expect(out).toContain(`${id.replace("mem-", "")} decisions for the`);
      expect(ledger.delivered.has(`memory:${id}`)).toBe(true);
    }
    const raw = await readFile(join(h.home, "cache", WS, "deliveries", "s-cut.jsonl"), "utf8");
    if (out.includes("did not fit the agent's hook output limit"))
      expect(raw).toContain('"reason":"provider_limit"');
  });
});

describe("a body the provider limit cut", () => {
  it("is recorded as failed with the reason, and stays undelivered for a later prompt", async () => {
    const h = await makeHome({ bulk: 4, protocol: true });
    // Sized from the protocol's own length so that the protocol, the metadata and two bodies fit and
    // the rest do not, whatever the protocol's wording.
    const limit = renderProtocolRulesFile({ skills: false }).length + 1300;
    const env = { PATHRULE_HOOK_PROVIDER: "claude-code", PATHRULE_PROVIDER_CONTEXT_LIMIT: String(limit) };
    const out = contextOf(await fire(h, prompt("s-cut2"), env));
    expect(out.length).toBeLessThanOrEqual(limit);
    expect(out).toContain("did not fit the agent's hook output limit");
    const raw = await readFile(join(h.home, "cache", WS, "deliveries", "s-cut2.jsonl"), "utf8");
    const receipts = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const failed = receipts
      .filter((r) => r.status === "failed" && r.reason === "provider_limit")
      .map((r) => r.item.id);
    const confirmed = receipts
      .filter((r) => r.status === "confirmed" && r.item.kind === "memory")
      .map((r) => r.item.id);
    expect(failed.length).toBeGreaterThan(0);
    const state = JSON.parse(
      await readFile(join(h.home, "cache", WS, "session-s-cut2.json"), "utf8"),
    );
    for (const id of failed) {
      expect(state.injected_memory_ids).not.toContain(id);
      expect(out).not.toContain(`${id.replace("mem-", "")} decisions for the`);
    }
    for (const id of confirmed)
      expect(out).toContain(`${id.replace("mem-", "")} decisions for the`);
  });
});

describe("text written as one long line", () => {
  it("loses its tail at a word boundary, not the whole of itself", async () => {
    const digest =
      "Recent work on the billing module, written as one line:" +
      " the invoice queue retries twice.".repeat(120);
    const h = await makeHome({ digest });
    const env = { PATHRULE_HOOK_PROVIDER: "claude-code", PATHRULE_PROVIDER_CONTEXT_LIMIT: "1500" };
    const out = contextOf(
      await fire(
        h,
        { hook_event_name: "SessionStart", session_id: "s-line", source: "startup" },
        env,
      ),
    );
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toContain(
      "Recent work on the billing module, written as one line: the invoice queue retries twice.",
    );
    const marker = out.indexOf("\n[Pathrule: the rest of this context did not fit");
    expect(marker).toBeGreaterThan(0);
    // The head ends on a whole word of the text it was cut from.
    const head = out.slice(out.indexOf("Recent work"), marker);
    expect(digest.startsWith(head)).toBe(true);
    expect(digest[head.length]).toBe(" ");
  });
});

describe("the session delivery ledger", () => {
  it("does not inject a body the MCP server already delivered in this session", async () => {
    const h = await makeHome();
    const env = { PATHRULE_HOME: h.home };
    await appendDeliveryReceipts(
      {
        workspaceId: WS,
        sessionId: "s-mcp",
        channel: "mcp",
        epoch: 0,
        receipts: TOPICS.map((slug) => ({
          item: {
            kind: "memory" as const,
            id: `mem-${slug}`,
            hash: `h-${slug}`,
            scope: "project" as const,
          },
          provenance: { source: "request" as const },
          status: "confirmed" as const,
        })),
      },
      env,
    );
    const context = contextOf(await fire(h, prompt("s-mcp")));
    for (const slug of TOPICS)
      expect(context).not.toContain(`${slug} decisions for the ${slug} module`);
  });

  it("records what the hook delivered for the MCP side, and a compaction starts a new epoch", async () => {
    const h = await makeHome();
    const env = { PATHRULE_HOME: h.home };
    const context = contextOf(await fire(h, prompt("s-hook")));
    expect(context).toContain("decisions for the");
    const before = await readDeliveryLedger(WS, "s-hook", env);
    expect([...before.delivered.values()].every((d) => d.channel === "hook")).toBe(true);
    expect(before.delivered.size).toBeGreaterThan(0);

    await fire(h, { hook_event_name: "SessionStart", session_id: "s-hook", source: "compact" });
    const after = await readDeliveryLedger(WS, "s-hook", env);
    expect(after.epoch).toBe(1);
    expect([...after.delivered.keys()].filter((k) => k.startsWith("memory:"))).toEqual([]);
  });
});

describe("framing for the session's channels", () => {
  it("a session without MCP gets the protocol that names no pathrule_ tool", async () => {
    const h = await makeHome({ protocol: true });
    const withoutMcp = contextOf(
      await fire(
        h,
        { hook_event_name: "SessionStart", session_id: "s-nomcp", source: "startup" },
        { PATHRULE_HOOK_MCP: "none" },
      ),
    );
    expect(withoutMcp).toContain("No Pathrule MCP tools are attached");
    expect(withoutMcp).not.toMatch(/pathrule_(get_context|log_activity|read_memory|write_memory)/);
    const withMcp = contextOf(
      await fire(h, { hook_event_name: "SessionStart", session_id: "s-mcp2", source: "startup" }),
    );
    expect(withMcp).toContain("pathrule_get_context");
  });

  it("a legacy settings hook frames Claude Code's session start by the registry's MCP flag", async () => {
    const h = await makeHome({ protocol: true });
    await mkdir(join(h.home, "integrations"), { recursive: true });
    await writeFile(
      join(h.home, "integrations", "registry.json"),
      JSON.stringify({
        schema_version: 1,
        integrations: [
          {
            provider: "claude-code",
            scope: "project",
            project_root: h.wsRoot,
            mode: "local",
            channel: "settings-hook",
            edition: "full",
            mcp: false,
            resources: [],
          },
        ],
      }),
    );
    // Claude Code's session start: `source` and no `model` (captured from Claude Code 2.1.296).
    const claude = contextOf(
      await fire(h, {
        hook_event_name: "SessionStart",
        session_id: "s-reg",
        source: "startup",
        transcript_path: "/t",
      }),
    );
    expect(claude).toContain("No Pathrule MCP tools are attached");
    // Codex's carries `model`, and the registry has no Codex record: MCP is assumed.
    const codex = contextOf(
      await fire(h, {
        hook_event_name: "SessionStart",
        session_id: "s-reg2",
        source: "startup",
        model: "gpt-5",
      }),
    );
    expect(codex).toContain("pathrule_get_context");
  });

  it("an index of an unknown schema is skipped with a notice", async () => {
    const h = await makeHome({ schema: 99 });
    const out = contextOf(
      await fire(h, { hook_event_name: "SessionStart", session_id: "s-schema", source: "startup" }),
    );
    expect(out).toContain("newer Pathrule runtime");
    expect(contextOf(await fire(h, prompt("s-schema")))).toBe("");
  });

  it("points a plugin user at setup once in a folder that is not a workspace", async () => {
    const h = await makeHome();
    const elsewhere = join(h.home, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    const start = {
      hook_event_name: "SessionStart",
      session_id: "s-hint",
      source: "startup",
      cwd: elsewhere,
    };
    const env = { PATHRULE_HOOK_CHANNEL: "plugin", PATHRULE_PLUGIN_SETUP_HINT: "/pathrule:setup" };
    expect(contextOf(await fire(h, start, env))).toContain("/pathrule:setup");
    expect(contextOf(await fire(h, { ...start, session_id: "s-hint-2" }, env))).toBe("");
    // A settings registration never says it: that user did not install a plugin.
    const other = join(h.home, "other");
    await mkdir(other, { recursive: true });
    expect(contextOf(await fire(h, { ...start, session_id: "s-hint-3", cwd: other }))).toBe("");
  });
});

describe("hook-triggered maintenance", () => {
  async function withRuntime(h: Home, consent: boolean) {
    const log = join(h.home, "maintenance.log");
    const fakeCli = join(h.home, "fake-cli.cjs");
    await writeFile(
      fakeCli,
      `require("fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");`,
    );
    await writeFile(
      join(h.home, "bin", "runtime.json"),
      JSON.stringify({
        schema_version: 1,
        launcher_contract: 1,
        runtime_version: "0.7.0",
        hook_extension_contract: 1,
        hook_index_schemas: [1, 2],
        hook: h.hook,
        cli: { node: process.execPath, entry: fakeCli },
        maintenance: { consent },
        written_at: "2026-10-10T00:00:00.000Z",
      }),
    );
    // The store changed after the index was written.
    await mkdir(join(h.home, WS), { recursive: true });
    await writeFile(join(h.home, WS, "pathrule.db"), "");
    await writeFile(join(h.home, "cache", WS, "knowledge-observations.jsonl"), '{"sid":"s"}\n');
    return log;
  }

  const waitFor = async (file: string, needle: string) => {
    for (let i = 0; i < 50; i += 1) {
      const text = await readFile(file, "utf8").catch(() => "");
      if (text.includes(needle)) return text;
      await new Promise((r) => setTimeout(r, 100));
    }
    return readFile(file, "utf8").catch(() => "");
  };

  it(
    "refreshes a stale index at session start and drains evidence at the end of a turn, with consent",
    { timeout: 20_000 },
    async () => {
      const h = await makeHome();
      const log = await withRuntime(h, true);
      await fire(h, { hook_event_name: "SessionStart", session_id: "s-m", source: "startup" });
      expect(await waitFor(log, "index refresh")).toContain(
        `index refresh --workspace ${WS} --quiet`,
      );
      await fire(h, { hook_event_name: "Stop", session_id: "s-m" });
      expect(await waitFor(log, "learning drain")).toContain(
        `learning drain --workspace ${WS} --quiet`,
      );
    },
  );

  it("spawns nothing without the recorded consent", async () => {
    const h = await makeHome();
    const log = await withRuntime(h, false);
    await fire(h, { hook_event_name: "SessionStart", session_id: "s-n", source: "startup" });
    await fire(h, { hook_event_name: "Stop", session_id: "s-n" });
    await new Promise((r) => setTimeout(r, 500));
    expect(await readFile(log, "utf8").catch(() => "")).toBe("");
  });

  it("does not refresh an index newer than the store", async () => {
    const h = await makeHome();
    const log = await withRuntime(h, true);
    const old = new Date("2026-01-01T00:00:00.000Z");
    await utimes(join(h.home, WS, "pathrule.db"), old, old);
    await fire(h, { hook_event_name: "SessionStart", session_id: "s-fresh", source: "startup" });
    await new Promise((r) => setTimeout(r, 500));
    expect(await readFile(log, "utf8").catch(() => "")).not.toContain("index refresh");
  });
});

describe("a Local workspace with the cloud extension installed beside the hook", () => {
  // A stand-in with the extension contract: it records what the hook asks of it.
  async function withStandInCloud(h: Home) {
    const asked = join(h.home, "cloud-asked.log");
    await writeFile(
      join(dirname(h.hook), "pathrule-hook-cloud.cjs"),
      `const fs = require("node:fs");
module.exports = {
  contract: ${HOOK_EXTENSION_CONTRACT},
  create: () => ({
    askOnWorkConflict: async () => { fs.appendFileSync(${JSON.stringify(asked)}, "work-conflict\\n"); return false; },
    rankPrompt: () => { fs.appendFileSync(${JSON.stringify(asked)}, "rank\\n"); return null; },
    logInjection() {}, logNavigation() {}, noteRouteFollow() {}, exploreBash: () => null,
  }),
};
`,
    );
    return () => readFile(asked, "utf8").catch(() => "");
  }
  const write = (h: Home, session: string) => ({
    hook_event_name: "PreToolUse",
    session_id: session,
    tool_name: "Write",
    tool_input: { file_path: join(h.wsRoot, "src", "auth", "plan.ts"), content: "x" },
  });

  it("never asks the teammate check for a Local workspace", async () => {
    const h = await makeHome();
    const asked = await withStandInCloud(h);
    await mkdir(join(h.home, WS), { recursive: true });
    await writeFile(join(h.home, WS, "pathrule.db"), "");
    await fire(h, write(h, "s-local-write"));
    expect(await asked()).toBe("");
  });

  it("still asks it for a cloud workspace's mirror", async () => {
    const h = await makeHome();
    const asked = await withStandInCloud(h);
    await mkdir(join(h.home, WS), { recursive: true });
    await writeFile(join(h.home, WS, "pathrule.db"), "");
    await writeFile(join(h.home, WS, ".mirror"), "");
    await fire(h, write(h, "s-mirror-write"));
    expect(await asked()).toContain("work-conflict");
  });
});
