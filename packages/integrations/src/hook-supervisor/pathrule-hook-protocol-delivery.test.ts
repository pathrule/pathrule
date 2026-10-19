// SPDX-License-Identifier: Apache-2.0
// Protocol delivery through the hook (2026-08-25).
//
// The agent protocol used to exist only on disk: the root CLAUDE.md body and
// `.claude/rules/pathrule-protocol.md`. That is why a terminal session with no
// Pathrule attached still read orders it could not carry out ("call
// pathrule_get_context", "log activity") and started editing the file instead.
//
// The protocol is now deliverable through the hook, once per session, and the
// text travels in the hook INDEX so there is exactly one source of truth: the
// same renderer that used to write it to disk writes it there. No
// `index.protocol` means nothing changes, which is what the byte-identical test
// below pins.
//
// The load-bearing assertion is the third one. MAX_CONTEXT_CHARS is 1500 and the
// prompt context is hard-truncated, so folding the protocol into the ranked
// lines would push knowledge out of the FIRST prompt of every session, which is
// exactly where it is most valuable. It is prepended after the cap instead.

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "77777777-7777-7777-7777-777777777777";
const PROTOCOL = "# Pathrule protocol\n\n1. PROTOCOL_MARKER_ONE — obey surfaced rules.\n2. PROTOCOL_MARKER_TWO — path-first writes.";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

async function makeHome(opts: { protocol?: string; teamContext?: string; projectKnowledge?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-proto-"));
  homes.push(home);
  const hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);
  const stub = join(home, "bin", "stub.cjs");
  await writeFile(stub, `process.stdin.resume();process.stdin.on("end",()=>process.exit(3));`);

  const wsRoot = join(home, "project");
  await mkdir(wsRoot, { recursive: true });
  const cacheDir = join(home, "cache", WS_ID);
  await mkdir(cacheDir, { recursive: true });

  const index: Record<string, unknown> = {
    workspace_id: WS_ID,
    workspace_root: wsRoot,
    generated_at: "2026-08-25T00:00:00.000Z",
    session_digest: "📋 Recent: DIGEST_MARKER touched the auth service.",
    knowledge_compiled: true,
    indexed_memory_ids: ["p-1"],
    path_memories: {
      "/": [
        {
          id: "p-1",
          title: "Auth service caching",
          preview: "auth caching invalidation strategy",
          node_path: "/",
          content_hash: "h1",
        },
      ],
    },
  };
  if (opts.protocol !== undefined) index.protocol = opts.protocol;
  if (opts.teamContext !== undefined) index.team_context = opts.teamContext;
  if (opts.projectKnowledge !== undefined) index.project_knowledge = opts.projectKnowledge;
  await writeFile(join(cacheDir, "hook-index.json"), JSON.stringify(index));
  return { home, hookScript, wsRoot, stub };
}

function runPrompt(
  home: string,
  hookScript: string,
  wsRoot: string,
  stub: string,
  sessionId: string,
  prompt = "auth caching invalidation strategy",
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      {
        env: {
          ...process.env,
          PATHRULE_HOME: home,
          PATHRULE_HOOK_EVENT: "UserPromptSubmit",
          PATHRULE_EMBED_HELPER: stub,
        },
        timeout: 15_000,
      },
      (error, stdout) => {
        if (error && typeof error.code === "number" && error.code !== 0) {
          reject(new Error(`hook exited ${error.code}: ${stdout}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim())?.hookSpecificOutput?.additionalContext ?? "");
        } catch {
          resolve(stdout.trim());
        }
      },
    );
    child.stdin!.end(
      JSON.stringify({ cwd: wsRoot, prompt, session_id: sessionId, hook_event_name: "UserPromptSubmit" }),
    );
  });
}


function runSessionStart(
  home: string,
  hookScript: string,
  wsRoot: string,
  stub: string,
  sessionId: string,
  source: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      {
        env: {
          ...process.env,
          PATHRULE_HOME: home,
          PATHRULE_HOOK_EVENT: "SessionStart",
          PATHRULE_EMBED_HELPER: stub,
        },
        timeout: 15_000,
      },
      (error, stdout) => {
        if (error && typeof error.code === "number" && error.code !== 0) {
          reject(new Error(`hook exited ${error.code}: ${stdout}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim())?.hookSpecificOutput?.additionalContext ?? "");
        } catch {
          resolve(stdout.trim());
        }
      },
    );
    child.stdin!.end(
      JSON.stringify({
        cwd: wsRoot,
        session_id: sessionId,
        hook_event_name: "SessionStart",
        transcript_path: "/tmp/transcript.jsonl",
        source,
      }),
    );
  });
}

describe("hook protocol delivery", () => {
  it("delivers the protocol on the first prompt of a session and never again", async () => {
    const h = await makeHome({ protocol: PROTOCOL });
    const first = await runPrompt(h.home, h.hookScript, h.wsRoot, h.stub, "proto-once");
    const second = await runPrompt(h.home, h.hookScript, h.wsRoot, h.stub, "proto-once");

    expect(first).toContain("PROTOCOL_MARKER_ONE");
    expect(first).toContain("PROTOCOL_MARKER_TWO");
    expect(second).not.toContain("PROTOCOL_MARKER_ONE");
  });

  it("stays silent when the index carries no protocol", async () => {
    const h = await makeHome();
    const out = await runPrompt(h.home, h.hookScript, h.wsRoot, h.stub, "proto-absent");
    expect(out).not.toContain("PROTOCOL_MARKER_ONE");
    expect(out).not.toContain("Pathrule protocol");
    // Still doing its normal job, so the silence is not an empty payload.
    expect(out).toContain("DIGEST_MARKER");
  });

  it("does not spend the knowledge budget: the rest of the payload is byte-identical", async () => {
    const withProto = await makeHome({ protocol: PROTOCOL });
    const without = await makeHome();
    const a = await runPrompt(withProto.home, withProto.hookScript, withProto.wsRoot, withProto.stub, "proto-budget");
    const b = await runPrompt(without.home, without.hookScript, without.wsRoot, without.stub, "proto-budget");

    expect(a.startsWith(`${PROTOCOL}\n\n`)).toBe(true);
    // The two homes differ only in workspace_root (a tmpdir path), so normalise it
    // before comparing the knowledge halves.
    const norm = (s: string, root: string) => s.split(root).join("<WS>");
    expect(norm(a.slice(PROTOCOL.length + 2), withProto.wsRoot)).toBe(norm(b, without.wsRoot));
  });

  it("an empty protocol string is treated as absent", async () => {
    const h = await makeHome({ protocol: "   " });
    const out = await runPrompt(h.home, h.hookScript, h.wsRoot, h.stub, "proto-blank");
    expect(out).toContain("DIGEST_MARKER");
    expect(out.startsWith(" ")).toBe(false);
  });

  // Context-lifecycle recovery (2026-09-01).
  //
  // The protocol is framing the agent cannot re-derive, and in signature mode the
  // hook is its ONLY channel — the disk copy is deliberately removed. So every
  // event that destroys the delivered context has to bring it back, or the agent
  // runs the rest of a long session with no protocol and no way to notice.
  //
  // `compact` is the one that matters in practice. Almost nobody types /compact;
  // Claude Code auto-compacts long sessions on its own, which is exactly the
  // regime this hook is built for. It measured as a no-op: `source: "compact"`
  // never matched the codex-only reset gate, so the hook kept every injected_* id
  // from a context that had just been summarised away and stayed silent.
  it("re-delivers the protocol after every context-destroying SessionStart", async () => {
    for (const source of ["compact", "clear"]) {
      const h = await makeHome({ protocol: PROTOCOL });
      const session = `proto-lifecycle-${source}`;
      const start = await runSessionStart(h.home, h.hookScript, h.wsRoot, h.stub, session, "startup");
      expect(start, `startup should deliver the protocol`).toContain("PROTOCOL_MARKER_ONE");

      const again = await runSessionStart(h.home, h.hookScript, h.wsRoot, h.stub, session, source);
      expect(again, `source=${source} must re-deliver the protocol`).toContain("PROTOCOL_MARKER_ONE");
    }
  });

  // `resume` and `fork` keep the transcript, and SessionStart's context is in it. Measured 2026-10-15
  // with Claude Code 2.1.300: three resumed turns held four copies of the protocol, each one re-read on
  // every later model step.
  it("does not re-deliver the protocol on resume or fork, which keep the transcript", async () => {
    for (const source of ["resume", "fork"]) {
      const h = await makeHome({ protocol: PROTOCOL });
      const session = `proto-keep-${source}`;
      await runSessionStart(h.home, h.hookScript, h.wsRoot, h.stub, session, "startup");
      const again = await runSessionStart(h.home, h.hookScript, h.wsRoot, h.stub, session, source);
      expect(again, `source=${source} must not repeat the protocol`).not.toContain("PROTOCOL_MARKER_ONE");
    }
  });

  it("a repeated startup does NOT re-deliver — only a real context reset does", async () => {
    const h = await makeHome({ protocol: PROTOCOL });
    await runSessionStart(h.home, h.hookScript, h.wsRoot, h.stub, "proto-idem", "startup");
    const repeat = await runSessionStart(h.home, h.hookScript, h.wsRoot, h.stub, "proto-idem", "startup");
    expect(repeat).not.toContain("PROTOCOL_MARKER_ONE");
  });

  // SessionStart is the channel that survives compaction: Claude Code merges its
  // additionalContext into the SYSTEM PROMPT for the session, while
  // UserPromptSubmit's lands in the turn and is summarised away with everything
  // else. Delivering on SessionStart means the protocol outlives the compaction
  // that removes the rest of the injected knowledge.
  it("delivers the protocol on SessionStart, not only on the first prompt", async () => {
    const h = await makeHome({ protocol: PROTOCOL });
    const start = await runSessionStart(h.home, h.hookScript, h.wsRoot, h.stub, "proto-channel", "startup");
    expect(start).toContain("PROTOCOL_MARKER_ONE");
    // And it is not paid for twice: the first prompt of that session stays quiet.
    const prompt = await runPrompt(h.home, h.hookScript, h.wsRoot, h.stub, "proto-channel");
    expect(prompt).not.toContain("PROTOCOL_MARKER_ONE");
  });

  it("the reset also clears injected-knowledge state, so memories flow again", async () => {
    const h = await makeHome({ protocol: PROTOCOL });
    const session = "proto-knowledge";
    const start = await runSessionStart(h.home, h.hookScript, h.wsRoot, h.stub, session, "startup");
    expect(start).toContain("DIGEST_MARKER");
    // Same session, context summarised away: the digest is gone from the model's
    // view, so the hook must be willing to say it again.
    const after = await runSessionStart(h.home, h.hookScript, h.wsRoot, h.stub, session, "compact");
    expect(after).toContain("DIGEST_MARKER");
  });

  // Team context used to ride the compiled file, deliberately: "the hook channel
  // is paid PER TURN", which was true of the prompt channel. In signature mode
  // that file is not written at all, and SessionStart is not that channel — its
  // additionalContext is merged into the system prompt once for the session. So
  // the block moves here and costs the same one-time price it used to.
  it("delivers the team context block on SessionStart", async () => {
    const h = await makeHome({ protocol: PROTOCOL, teamContext: "## Team\n\nTEAM_MARKER owns /apps/api." });
    const out = await runSessionStart(h.home, h.hookScript, h.wsRoot, h.stub, "team-1", "startup");
    expect(out).toContain("TEAM_MARKER");
    expect(out).toContain("PROTOCOL_MARKER_ONE");
  });

  it("re-delivers the team context after a compaction", async () => {
    const h = await makeHome({ protocol: PROTOCOL, teamContext: "## Team\n\nTEAM_MARKER owns /apps/api." });
    await runSessionStart(h.home, h.hookScript, h.wsRoot, h.stub, "team-2", "startup");
    const after = await runSessionStart(h.home, h.hookScript, h.wsRoot, h.stub, "team-2", "compact");
    expect(after).toContain("TEAM_MARKER");
  });

  it("delivers team context even when the workspace has no protocol", async () => {
    const h = await makeHome({ teamContext: "## Team\n\nTEAM_MARKER owns /apps/api." });
    const out = await runSessionStart(h.home, h.hookScript, h.wsRoot, h.stub, "team-3", "startup");
    expect(out).toContain("TEAM_MARKER");
  });

  it("says nothing about the team when the index carries no block", async () => {
    const h = await makeHome({ protocol: PROTOCOL });
    const out = await runSessionStart(h.home, h.hookScript, h.wsRoot, h.stub, "team-4", "startup");
    expect(out).not.toContain("TEAM_MARKER");
    expect(out).toContain("PROTOCOL_MARKER_ONE");
  });

  // Workspace-wide knowledge applies to every task, so it cannot wait for a prompt to share its
  // words: measured on a public code base, "how long the request took" never reached the root item
  // "Durations are whole milliseconds", which a CLAUDE.md user has in context from the first turn.
  it("delivers the project-wide knowledge on SessionStart and again after a compaction", async () => {
    const h = await makeHome({ protocol: PROTOCOL, projectKnowledge: "📌 Project-wide knowledge\n\n### Durations\nPROJECT_MARKER whole milliseconds." });
    const out = await runSessionStart(h.home, h.hookScript, h.wsRoot, h.stub, "proj-1", "startup");
    expect(out).toContain("PROJECT_MARKER");
    expect(out).toContain("PROTOCOL_MARKER_ONE");
    const after = await runSessionStart(h.home, h.hookScript, h.wsRoot, h.stub, "proj-1", "compact");
    expect(after).toContain("PROJECT_MARKER");
    const resumed = await runSessionStart(h.home, h.hookScript, h.wsRoot, h.stub, "proj-1", "resume");
    expect(resumed).not.toContain("PROJECT_MARKER");
  });
});
