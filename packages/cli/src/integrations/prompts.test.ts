// SPDX-License-Identifier: Apache-2.0
// A wizard row must fit one terminal row: the redraw moves up one line per choice, so a row that
// wraps leaves a stale line behind on every key.
import { describe, expect, it } from "vitest";

import type { CliRuntime } from "../plugin.js";
import { confirm, fitLine, selectOne } from "./prompts.js";

const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("fitLine", () => {
  it("leaves a row that fits as it is", () => {
    expect(fitLine("  Claude Code  native plugin", 100)).toBe("  Claude Code  native plugin");
  });

  it("cuts a long row to one terminal row, keeping its colour codes and closing them", () => {
    const row = `\x1b[36m❯\x1b[0m [x] Codex \x1b[2m${"skills, MCP and hooks you trust in /hooks; ".repeat(4)}\x1b[0m`;
    const fitted = fitLine(row, 100);
    expect(visible(fitted).length).toBe(99);
    expect(visible(fitted).endsWith("…")).toBe(true);
    expect(fitted.startsWith("\x1b[36m❯\x1b[0m [x] Codex \x1b[2m")).toBe(true);
    expect(fitted.endsWith("\x1b[0m")).toBe(true);
  });

  it("assumes 80 columns when the width is unknown", () => {
    expect(visible(fitLine("x".repeat(200), undefined)).length).toBe(79);
  });
});

describe("cancelling at a question", () => {
  // What readline/promises rejects a pending question with when the person presses Ctrl-C.
  const abort = () =>
    Object.assign(new Error("Aborted with Ctrl+C"), { name: "AbortError", code: "ABORT_ERR" });
  const runtime = (answer: () => Promise<string>) =>
    ({
      cwd: "/",
      env: {},
      stdout: { write: () => true },
      stderr: { write: () => true },
      promptLine: answer,
    }) as unknown as CliRuntime;
  const mode = { json: false, color: false, interactive: true, noOpen: true };

  it("answers no, even where the default is yes", async () => {
    expect(
      await confirm(
        runtime(() => Promise.reject(abort())),
        "Apply these changes?",
        true,
      ),
    ).toBe(false);
  });

  it("cancels a choice instead of crashing", async () => {
    const choices = [
      { value: "local", label: "Local" },
      { value: "cloud", label: "Cloud" },
    ];
    expect(
      await selectOne(
        runtime(() => Promise.reject(abort())),
        mode,
        "Where?",
        choices,
      ),
    ).toBeNull();
  });

  it("still surfaces any other failure", async () => {
    await expect(
      confirm(
        runtime(() => Promise.reject(new Error("stdin broke"))),
        "Apply?",
      ),
    ).rejects.toThrow("stdin broke");
  });
});
