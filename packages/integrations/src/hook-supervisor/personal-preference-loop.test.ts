// SPDX-License-Identifier: Apache-2.0
/**
 * Knowing the person, end to end with no engine, through the real hook process:
 *   the hook keeps what the person typed -> a preference quoted from it is captured as a candidate ->
 *   said again in a second session it becomes active -> the index carries it -> the hook delivers it
 *   with the next prompt under "How this user prefers to work". A quote the person never typed is refused.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileUserKnowledgeStore } from "@pathrule/core/user-knowledge/user-knowledge-store.js";
import { captureUserPreference, openUserPreferenceEntries, promoteRepeatedPreferences, readUserWords, repeatsQuote } from "@pathrule/core/user-knowledge/user-knowledge-capture.js";

const HOOK_SRC = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS = "66666666-6666-6666-6666-666666666666";
const roots: string[] = [];
let hook = "";
beforeAll(() => {
  const bin = mkdtempSync(join(tmpdir(), "pr-pref-bin-"));
  roots.push(bin);
  hook = join(bin, "pathrule-hook.cjs");
  copyFileSync(HOOK_SRC, hook);
});
afterEach(() => { for (const d of roots.splice(1)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

function prompt(home: string, repo: string, session: string, text: string): string {
  const out = execFileSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, cwd: repo, prompt: text }),
    env: { ...process.env, PATHRULE_HOME: home, PATHRULE_HOOK_EVENT: "UserPromptSubmit" },
    cwd: repo, encoding: "utf8", timeout: 15_000,
  });
  try { return JSON.parse(out.trim())?.hookSpecificOutput?.additionalContext ?? ""; } catch { return out; }
}

describe("knowing the person without an engine", () => {
  it("captures from their own words, activates on a second session, and delivers with the next prompt", async () => {
    const home = mkdtempSync(join(tmpdir(), "pr-pref-home-"));
    const repo = mkdtempSync(join(tmpdir(), "pr-pref-repo-"));
    roots.push(home, repo);
    const env = { ...process.env, PATHRULE_HOME: home };
    const cache = join(home, "cache", WS);
    mkdirSync(cache, { recursive: true });
    const index = { workspace_id: WS, workspace_root: repo, generated_at: "2026-10-15T00:00:00.000Z", session_digest: "", path_memories: {}, path_rules: {}, project_rules: [], recent_subjects: [] };
    writeFileSync(join(cache, "hook-index.json"), JSON.stringify(index));
    writeFileSync(join(cache, "warehouse.json"), "{}");

    prompt(home, repo, "s1", "Add the refund parser. Also, a habit of mine: a one-line JSDoc above every exported function.");
    const store = createFileUserKnowledgeStore("local", env);
    const claim = { kind: "procedure" as const, claim: "Put a one-line JSDoc comment above every exported function.", quotes: ["a one-line JSDoc above every exported function"] };
    const first = await captureUserPreference(store, claim, { workspaceId: WS, words: readUserWords(cache), now: "2026-10-15T00:00:00.000Z" });
    expect(first).toMatchObject({ ok: true, status: "candidate" });
    expect(await captureUserPreference(store, { ...claim, quotes: ["I never said this"] }, { workspaceId: WS, words: readUserWords(cache), now: "2026-10-15T00:00:00.000Z" })).toMatchObject({ ok: false, code: "preference_not_their_words" });

    prompt(home, repo, "s2", "Daily report now. As usual for me: a one-line JSDoc above every exported function.");
    const second = await captureUserPreference(store, { ...claim, same_as: first.ok ? first.id : "" }, { workspaceId: WS, words: readUserWords(cache), now: "2026-10-15T01:00:00.000Z" });
    expect(second).toMatchObject({ ok: true, status: "active", sessions: 2 });

    // The index writer's open path: the person's active beliefs as user_preferences.
    const entries = await openUserPreferenceEntries(store, WS, [repo]);
    writeFileSync(join(cache, "hook-index.json"), JSON.stringify({ ...index, user_preferences: entries }));
    const delivered = prompt(home, repo, "s3", "Add the monthly report header with its exported function and a test.");
    expect(delivered).toContain("How this user prefers to work");
    expect(delivered).toContain("one-line JSDoc");
    expect(readFileSync(join(cache, "user-words.jsonl"), "utf8").split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("activates a candidate the person says again in another session, with no agent noticing", async () => {
    const home = mkdtempSync(join(tmpdir(), "pr-pref-home-"));
    const repo = mkdtempSync(join(tmpdir(), "pr-pref-repo-"));
    roots.push(home, repo);
    const env = { ...process.env, PATHRULE_HOME: home };
    const cache = join(home, "cache", WS);
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "hook-index.json"), JSON.stringify({ workspace_id: WS, workspace_root: repo, generated_at: "2026-10-15T00:00:00.000Z", path_memories: {}, path_rules: {}, project_rules: [], recent_subjects: [] }));
    prompt(home, repo, "s1", "Add the parser. A habit of mine: a one-line JSDoc comment (/** ... */) directly above every exported function.");
    const store = createFileUserKnowledgeStore("local", env);
    const claim = { kind: "procedure" as const, claim: "One-line JSDoc above every exported function.", quotes: ["a one-line JSDoc comment (/** ... */) directly above every exported function"] };
    expect(await captureUserPreference(store, claim, { workspaceId: WS, words: readUserWords(cache), now: "2026-10-15T00:00:00.000Z" })).toMatchObject({ status: "candidate" });
    // Same session again: not a second session, nothing promoted.
    expect(await promoteRepeatedPreferences(store, readUserWords(cache), WS, "2026-10-15T00:30:00.000Z")).toEqual([]);
    prompt(home, repo, "s2", "Reports now. Remember: A one-line JSDoc comment (/** ... */) directly above every exported function, as always.");
    const promoted = await promoteRepeatedPreferences(store, readUserWords(cache), WS, "2026-10-15T01:00:00.000Z");
    expect(promoted).toHaveLength(1);
    expect((await openUserPreferenceEntries(store, WS, [repo])).map((e) => JSON.stringify(e)).join()).toContain("JSDoc");
    expect(await promoteRepeatedPreferences(store, readUserWords(cache), WS, "2026-10-15T02:00:00.000Z")).toEqual([]);
  });

  it("delivers a habit the person says covers all their work on a prompt that shares none of its words", async () => {
    const home = mkdtempSync(join(tmpdir(), "pr-pref-home-"));
    const repo = mkdtempSync(join(tmpdir(), "pr-pref-repo-"));
    roots.push(home, repo);
    const env = { ...process.env, PATHRULE_HOME: home };
    const cache = join(home, "cache", WS);
    mkdirSync(cache, { recursive: true });
    const index = { workspace_id: WS, workspace_root: repo, generated_at: "2026-10-15T00:00:00.000Z", path_memories: {}, path_rules: {}, project_rules: [], recent_subjects: [] };
    writeFileSync(join(cache, "hook-index.json"), JSON.stringify(index));
    const said = "for any code you write for me: a one-line JSDoc comment directly above every exported function.";
    prompt(home, repo, "s1", `Add the parser. ${said}`);
    prompt(home, repo, "s2", `Reports next. As usual, ${said}`);
    const store = createFileUserKnowledgeStore("local", env);
    const claim = { kind: "procedure" as const, claim: "One-line JSDoc above every exported function.", quotes: ["a one-line JSDoc comment directly above every exported function"], always: true };
    await captureUserPreference(store, claim, { workspaceId: WS, words: readUserWords(cache).slice(0, 1), now: "2026-10-15T00:00:00.000Z" });
    expect(await promoteRepeatedPreferences(store, readUserWords(cache), WS, "2026-10-15T01:00:00.000Z")).toHaveLength(1);
    const entries = await openUserPreferenceEntries(store, WS, [repo]);
    expect(entries[0]).toMatchObject({ always: true });
    writeFileSync(join(cache, "hook-index.json"), JSON.stringify({ ...index, user_preferences: entries }));
    expect(prompt(home, repo, "s3", "Wire the webhook handler and its tests.")).toContain("One-line JSDoc above every exported function");
  });

  it("delivers a belief narrowed to a path only to work at or under that path", () => {
    const home = mkdtempSync(join(tmpdir(), "pr-pref-home-"));
    const repo = mkdtempSync(join(tmpdir(), "pr-pref-repo-"));
    roots.push(home, repo);
    mkdirSync(join(repo, "packages", "app", "src"), { recursive: true });
    mkdirSync(join(repo, "packages", "api"), { recursive: true });
    const cache = join(home, "cache", WS);
    mkdirSync(cache, { recursive: true });
    const entry = { id: "narrowed", line: "Use the app's own date helpers instead of new Date().", terms: [], always: true, path: "/packages/app" };
    writeFileSync(join(cache, "hook-index.json"), JSON.stringify({ workspace_id: WS, workspace_root: repo, generated_at: "2026-10-15T00:00:00.000Z", path_memories: {}, path_rules: {}, project_rules: [], recent_subjects: [], user_preferences: [entry] }));
    expect(prompt(home, join(repo, "packages", "app", "src"), "s1", "Wire the settings screen.")).toContain("own date helpers");
    expect(prompt(home, join(repo, "packages", "api"), "s2", "Wire the settings endpoint.")).not.toContain("own date helpers");
    expect(prompt(home, repo, "s3", "Wire the settings everywhere.")).not.toContain("own date helpers");
  });

  it("does not count a paraphrase or a short shared phrase as saying it again", () => {
    const q = "a one-line JSDoc comment directly above every exported function";
    expect(repeatsQuote(q, "please put A ONE-LINE JSDOC COMMENT DIRECTLY ABOVE every exported function")).toBe(true);
    expect(repeatsQuote(q, "document exported functions with short comments")).toBe(false);
    expect(repeatsQuote(q, "every exported function needs tests")).toBe(false);
    expect(repeatsQuote("short one", "short one")).toBe(false);
    // The agent's quote carries a few words the person did not repeat; their phrase itself is 70% of it.
    const quoted = "for any code you write for me: put a one-line JSDoc comment (`/** ... */`) directly above every exported function";
    expect(repeatsQuote(quoted, "And as usual for me: a one-line JSDoc comment (`/** ... */`) directly above every exported function.")).toBe(true);
  });
});
