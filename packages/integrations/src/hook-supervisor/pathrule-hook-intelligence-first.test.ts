// SPDX-License-Identifier: Apache-2.0
// The open delivery order and the Agent IR delivery, driven through the real hook.
//
// A prompt's turn is the Foundation's: the strict rule first, then what the ranking found, under
// the hook's fixed budget. A `pathrule-hook-engine.cjs` an old install left beside the hook changes
// nothing. An approved Agent IR group reaches the agent once: a client whose turn-zero file already
// carries the group's compiled form does not get its lines again from the hook.
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "8f1e2d3c-4b5a-4697-8877-665544332211";

const STRICT_BODY =
  "Every call to the payments API carries an idempotency key. Never retry a charge without it.";
const ADVISORY_BODY = "Payments code logs the order id, never the card or the customer email.";
const MEM_A_LINE =
  "- The payments retry queue backs off 2, 4 and 8 seconds before it parks a charge. [context]";
const MEM_A_COMPILED = `_Compiled form of this memory (advisory, never overrides a rule). Full text: pathrule_read_memory("mem-a")._\n${MEM_A_LINE}`;
const MEM_B_BODY =
  "Payments refunds go through the refund worker; the API only records the refund request.";
const MEM_C_BODY = "The office plants are watered on Mondays and Thursdays.";
const STANDALONE_LINE =
  "- Payments webhooks are verified against the signing secret before anything is read. [context]";
const PROMPT = "how do payments retries and refunds work in the payments api";

let home: string;
let wsRoot: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "pathrule-hook-intelligence-first-"));
  wsRoot = join(home, "project");
  await mkdir(join(wsRoot, "src"), { recursive: true });
  const cacheDir = join(home, "cache", WS_ID);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, "hook-index.json"),
    JSON.stringify({
      schema_version: 2,
      workspace_id: WS_ID,
      workspace_root: wsRoot,
      generated_at: "2026-10-13T00:00:00.000Z",
      session_digest: "",
      path_memories: {
        "/src": [
          {
            id: "mem-a",
            title: "Payments retry queue",
            preview: "payments retry queue backs off",
            node_path: "/src",
            content_hash: "ha",
          },
          {
            id: "mem-b",
            title: "Payments refunds",
            preview: "payments refunds go through the refund worker",
            node_path: "/src",
            content_hash: "hb",
          },
          {
            id: "mem-c",
            title: "Office plants",
            preview: "watering schedule",
            node_path: "/src",
            content_hash: "hc",
          },
        ],
      },
      path_rules: {
        "/src": [
          {
            id: "rule-strict",
            block_pattern: { source: "chargeWithoutKey\\(", flags: "" },
            name: "Payments idempotency key",
            preview: "payments API idempotency key",
            priority: "high",
            enforcement: "strict",
            node_path: "/src",
          },
          {
            id: "rule-advisory",
            name: "Payments logging",
            preview: "payments logs order id",
            priority: "medium",
            enforcement: "advisory",
            node_path: "/src",
          },
        ],
      },
      project_rules: [],
      path_advisories: {
        "/src": [
          { ref: "atom-a", line: MEM_A_LINE, group: "mem-a" },
          { ref: "atom-standalone", line: STANDALONE_LINE },
        ],
      },
      knowledge_compiled: true,
      compiled_memory_ids: ["mem-a", "mem-b"],
      recent_subjects: [],
    }),
  );
  await writeFile(
    join(cacheDir, "warehouse.json"),
    JSON.stringify({
      "mem-a": {
        type: "memory",
        title: "Payments retry queue",
        body: MEM_A_COMPILED,
        content_hash: "ha",
        compiled_refs: ["atom-a"],
      },
      "mem-b": { type: "memory", title: "Payments refunds", body: MEM_B_BODY, content_hash: "hb" },
      "mem-c": { type: "memory", title: "Office plants", body: MEM_C_BODY, content_hash: "hc" },
      "rule-strict": {
        type: "rule",
        title: "Payments idempotency key",
        body: STRICT_BODY,
        content_hash: "hr1",
      },
      "rule-advisory": {
        type: "rule",
        title: "Payments logging",
        body: ADVISORY_BODY,
        content_hash: "hr2",
      },
    }),
  );
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

let bins = 0;
/** A copy of the hook, with `stale` (module source) written beside it as an old engine extension. */
async function hookWith(stale: string | null): Promise<string> {
  const bin = join(home, `bin-${bins++}`);
  await mkdir(bin, { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, join(bin, "pathrule-hook.js"));
  if (stale !== null) await writeFile(join(bin, "pathrule-hook-engine.cjs"), stale);
  return join(bin, "pathrule-hook.js");
}

/** An old engine extension built from method bodies; every other method is absent. */
const engineModule = (methods: string): string =>
  `module.exports = { contract: 1, create: () => ({ ${methods} }) };`;

let sessions = 0;
function run(
  hookScript: string,
  event: Record<string, unknown>,
): Promise<{ code: number; context: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      {
        // No embedding key and no account: the ranking is the hook's own, and deterministic.
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          PATHRULE_HOME: home,
          PATHRULE_NAVIGATION: "on",
        },
        timeout: 10_000,
      },
      (error, stdout) => {
        const code = error && typeof error.code === "number" ? error.code : 0;
        let context = "";
        try {
          context = JSON.parse(stdout.trim())?.hookSpecificOutput?.additionalContext ?? "";
        } catch {
          context = "";
        }
        resolve({ code, context, stdout });
      },
    );
    child.stdin!.end(JSON.stringify({ session_id: `s-${sessions++}`, ...event }));
  });
}

const prompt = (hookScript: string, extra: Record<string, unknown> = {}) =>
  run(hookScript, {
    cwd: join(wsRoot, "src"),
    prompt: PROMPT,
    hook_event_name: "UserPromptSubmit",
    ...extra,
  });
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
const at = (haystack: string, needle: string): number => haystack.indexOf(needle);

describe("hook × the Foundation's delivery", () => {
  let foundation = "";

  beforeAll(async () => {
    const out = await prompt(await hookWith(null));
    expect(out.code).toBe(0);
    foundation = out.context;
  });

  it("delivers the strict rule first and both memories", () => {
    expect(foundation).toContain(STRICT_BODY);
    expect(foundation).toContain(MEM_B_BODY);
    expect(count(foundation, MEM_A_LINE)).toBe(1);
    expect(at(foundation, STRICT_BODY)).toBeLessThan(at(foundation, MEM_B_BODY));
  });

  it("ignores an engine extension an old install left beside the hook: the turn is the Foundation's", async () => {
    // It would order mem-b first and shrink the budget, if the hook still loaded it.
    const stale = engineModule(
      [
        "promptBudget() { return 120; }",
        "orderBodyItems({ memItems }) { return memItems.filter((i) => i.id === 'mem-b'); }",
      ].join(", "),
    );
    const out = await prompt(await hookWith(stale));
    expect(out.code).toBe(0);
    expect(out.context).toBe(foundation);
  });
});

describe("hook × one canonical Agent IR delivery", () => {
  const codex = { turn_id: "t-1", model: "gpt-test" };

  it("does not repeat a group whose compiled form the client's turn-zero file carries, and still delivers new guidance", async () => {
    const out = await prompt(await hookWith(null), codex);
    expect(out.code).toBe(0);
    expect(count(out.context, MEM_A_LINE)).toBe(0);
    expect(count(out.context, STANDALONE_LINE)).toBe(1);
  });

  it("does the same before a write, on the PreToolUse channel", async () => {
    const out = await run(await hookWith(null), {
      ...codex,
      cwd: join(wsRoot, "src"),
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: join(wsRoot, "src", "payments.ts"),
        old_string: "a",
        new_string: "b",
      },
    });
    expect(out.code).toBe(0);
    expect(count(out.context, MEM_A_LINE)).toBe(0);
    expect(count(out.context, STANDALONE_LINE)).toBe(1);
  });

  it("delivers the group exactly once to a client whose turn-zero file holds titles only", async () => {
    const out = await prompt(await hookWith(null));
    expect(count(out.context, MEM_A_LINE)).toBe(1);
    expect(count(out.context, STANDALONE_LINE)).toBe(1);
  });
});

describe("hook × mandatory gates", () => {
  it("denies an edit that breaks a strict rule, whatever an old engine extension beside it does", async () => {
    const thrower = engineModule("recordInjection() { throw new Error('engine down'); }");
    const out = await run(await hookWith(thrower), {
      cwd: join(wsRoot, "src"),
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: join(wsRoot, "src", "payments.ts"),
        old_string: "a",
        new_string: "chargeWithoutKey(order)",
      },
    });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('"permissionDecision":"deny"');
  });
});
