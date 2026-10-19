// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileUserKnowledgeStore } from "./user-knowledge-store.js";
import { captureUserPreference, openUserPreferenceEntries, readUserWords, USER_WORDS_LEDGER, type UserWords } from "./user-knowledge-capture.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
function env() {
  const home = mkdtempSync(join(tmpdir(), "pr-user-capture-"));
  dirs.push(home);
  return { ...process.env, PATHRULE_HOME: home };
}
const said = (sid: string, text: string): UserWords => ({ sid, at: "2026-10-15T00:00:00.000Z", text });
const claim = { kind: "procedure" as const, claim: "Give every exported function a one-line comment saying why it exists.", quotes: ["one-line comment above every exported function"] };

describe("capturing how the person works", () => {
  it("is a candidate after one session, active when said again in another, and never from the agent's words", async () => {
    const e = env();
    const store = createFileUserKnowledgeStore("local", e);
    const s1 = [said("s1", "By the way, I always want a one-line comment above every exported function.")];
    const first = await captureUserPreference(store, claim, { workspaceId: "ws", words: s1, now: "2026-10-15T00:00:00.000Z" });
    expect(first).toMatchObject({ ok: true, status: "candidate", sessions: 1 });
    expect(await openUserPreferenceEntries(store, "ws", [])).toEqual([]);

    const same = await captureUserPreference(store, claim, { workspaceId: "ws", words: [...s1, said("s1", "again: one-line comment above every exported function")], now: "2026-10-15T00:01:00.000Z" });
    expect(same).toMatchObject({ ok: true, status: "candidate", sessions: 1 });

    const s2 = [...s1, said("s2", "Reminder: one-line comment above every exported function, please.")];
    const second = await captureUserPreference(store, { ...claim, claim: "Comment each exported function in one line." , same_as: first.ok ? first.id : "" }, { workspaceId: "ws", words: s2, now: "2026-10-15T01:00:00.000Z" });
    expect(second).toMatchObject({ ok: true, status: "active", sessions: 2 });
    const entries = await openUserPreferenceEntries(store, "ws", []);
    expect(entries.map((x) => x.line).join("\n")).toContain("one-line comment");

    expect(await captureUserPreference(store, { ...claim, quotes: ["comment every function"] }, { workspaceId: "ws", words: s2, now: "2026-10-15T01:00:00.000Z" })).toMatchObject({ ok: false, code: "preference_not_their_words" });
    expect(await captureUserPreference(store, { ...claim, kind: "constraint" as never }, { workspaceId: "ws", words: s2, now: "2026-10-15T01:00:00.000Z" })).toMatchObject({ ok: false, code: "preference_kind_unknown" });
  });

  it("stays with the workspace it was learned in until another workspace shows it", async () => {
    const e = env();
    const store = createFileUserKnowledgeStore("local", e);
    const words = [said("s1", "I prefer named exports."), said("s2", "As always: I prefer named exports.")];
    const r = await captureUserPreference(store, { kind: "selection", claim: "Prefers named exports over default exports.", quotes: ["I prefer named exports"] }, { workspaceId: "ws-a", words: words.slice(0, 1), now: "2026-10-15T00:00:00.000Z" });
    await captureUserPreference(store, { kind: "selection", claim: "x", quotes: ["I prefer named exports"], same_as: r.ok ? r.id : "" }, { workspaceId: "ws-a", words, now: "2026-10-15T01:00:00.000Z" });
    expect((await openUserPreferenceEntries(store, "ws-a", [])).length).toBe(1);
    expect((await openUserPreferenceEntries(store, "ws-b", [])).length).toBe(0);
  });

  it("is active at once, in this workspace only, when the person stated it as a lasting habit", async () => {
    const e = env();
    const store = createFileUserKnowledgeStore("local", e);
    const words = [said("s1", "Add tests for the deadline. By the way, a habit of mine: every new test function has a comment line directly above it saying what it checks.")];
    const habit = { kind: "procedure" as const, claim: "Put a comment line directly above every new test function saying what it checks.", quotes: ["every new test function has a comment line directly above it saying what it checks"], lasting: true };
    expect(await captureUserPreference(store, habit, { workspaceId: "ws-a", words, now: "2026-10-15T00:00:00.000Z" })).toMatchObject({ ok: true, status: "active", sessions: 1 });
    expect((await openUserPreferenceEntries(store, "ws-a", [])).map((x) => x.line).join("\n")).toContain("comment line");
    expect(await openUserPreferenceEntries(store, "ws-b", [])).toEqual([]);
    // Still grounded: a lasting claim the person never typed is refused.
    expect(await captureUserPreference(store, { ...habit, quotes: ["always comment tests"] }, { workspaceId: "ws-a", words, now: "2026-10-15T00:00:00.000Z" })).toMatchObject({ ok: false, code: "preference_not_their_words" });
  });

  it("reads the hook's ledger, skipping torn lines", () => {
    const e = env();
    const dir = join(e.PATHRULE_HOME!, "cache", "ws");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, USER_WORDS_LEDGER), [JSON.stringify(said("s1", "hello")), "{torn", JSON.stringify({ sid: "s1", text: "" })].join("\n"));
    expect(readUserWords(dir).map((w) => w.text)).toEqual(["hello"]);
  });
});
