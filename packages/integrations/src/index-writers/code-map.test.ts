// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodeMap, extractSymbols, identifierWords, wordForms } from "./code-map.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("code map", () => {
  it("splits identifiers into the words a prompt uses, singular and plural", () => {
    expect(identifierWords("elapsedTime")).toEqual(["elapsedtime", "elapsed", "time"]);
    expect(wordForms("validate")).toEqual(["validates", "validated", "validating"]);
    expect(wordForms("options")).toEqual(expect.arrayContaining(["option"]));
    expect(identifierWords("generate_unique_id")).toEqual(expect.arrayContaining(["generate_unique_id", "generate", "unique"]));
    expect(identifierWords("handleHTTPRequest")).toEqual(expect.arrayContaining(["handle", "http", "request"]));
  });

  it("finds definitions in JavaScript, Python and Go, with their lines", () => {
    expect(extractSymbols("lib/reply.js", "'use strict'\nfunction onSendHook (reply) {\n}\nReply.prototype.header = function (k) {}\nObject.defineProperties(Reply.prototype, {\n  elapsedTime: {\n    get () {}\n  }\n})\n")).toEqual([["onSendHook", 2], ["header", 4], ["elapsedTime", 6]]);
    expect(extractSymbols("fastapi/utils.py", "class A:\n    def method(self):\n        if x:\n            pass\nasync def generate_unique_id(route):\n    pass\n")).toEqual([["A", 1], ["method", 2], ["generate_unique_id", 5]]);
    expect(extractSymbols("gin.go", "type Engine struct {\n\tRedirectTrailingSlash bool\n\tpool sync.Pool\n}\nfunc (engine *Engine) handleHTTPRequest(c *Context) {\n}\n")).toEqual([["Engine", 1], ["RedirectTrailingSlash", 2], ["handleHTTPRequest", 5]]);
    expect(extractSymbols("a.js", "  if (x) {\n  for (const a of b) {\n")).toEqual([]);
  });

  it("maps a git checkout, skips tests and docs, and reuses the cache for unchanged files", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-codemap-")); const cache = mkdtempSync(join(tmpdir(), "pr-codemap-cache-")); dirs.push(root, cache);
    mkdirSync(join(root, "lib")); mkdirSync(join(root, "test")); mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "lib", "reply.js"), "function sendReply () {}\n");
    writeFileSync(join(root, "test", "reply.test.js"), "function helperInTest () {}\n");
    writeFileSync(join(root, "docs", "x.js"), "function docExample () {}\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    const map = (await buildCodeMap(root, cache))!;
    expect(map.symbols.map((s) => [s[0], s[1]])).toEqual([["sendReply", "/lib/reply.js:1"]]);
    expect(map.idf.reply).toBeGreaterThanOrEqual(0);
    expect((await buildCodeMap(root, cache))!.symbols).toEqual(map.symbols);
  });
});
