// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  injectOpencode,
  opencodeHomeConfigPath,
  readOpencode,
  removeOpencode,
} from "./opencode-installer.js";
import type { McpServerEntry } from "../mcp-types.js";

const ENTRY: McpServerEntry = {
  type: "stdio",
  command: "/usr/local/bin/node",
  args: ["/opt/pathrule/mcp-server/dist/index.js"],
  env: { PATHRULE_EXAMPLE_URL: "https://api.example.com", PATHRULE_EXAMPLE_KEY: "key" },
};

describe("opencodeHomeConfigPath", () => {
  it("computes ~/.config/opencode/opencode.json per platform", () => {
    expect(opencodeHomeConfigPath("/Users/pat", "darwin")).toBe(
      "/Users/pat/.config/opencode/opencode.json",
    );
    expect(opencodeHomeConfigPath("/home/pat", "linux")).toBe(
      "/home/pat/.config/opencode/opencode.json",
    );
    expect(opencodeHomeConfigPath("C:\\Users\\Pat Smith", "win32")).toBe(
      "C:\\Users\\Pat Smith\\.config\\opencode\\opencode.json",
    );
  });
});

describe("injectOpencode", () => {
  it("writes the OpenCode entry shape: mcp root, type local, flattened command, environment, enabled", () => {
    const { body, wasNew } = injectOpencode(null, ENTRY);
    expect(wasNew).toBe(true);
    const parsed = JSON.parse(body) as {
      $schema: string;
      mcp: Record<string, Record<string, unknown>>;
    };
    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
    const entry = parsed.mcp.pathrule!;
    expect(entry.type).toBe("local");
    // command + args collapse into a single array.
    expect(entry.command).toEqual([ENTRY.command, ...ENTRY.args]);
    expect(entry.enabled).toBe(true);
    expect(entry.environment).toEqual(ENTRY.env);
  });

  it("omits environment when the entry carries no env", () => {
    const { body } = injectOpencode(null, { ...ENTRY, env: undefined });
    const entry = (JSON.parse(body) as { mcp: Record<string, Record<string, unknown>> }).mcp
      .pathrule!;
    expect(entry).not.toHaveProperty("environment");
  });

  it("preserves the user's own $schema and foreign mcp servers", () => {
    const existing = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "anthropic/claude-sonnet-4-5",
      mcp: { sentry: { type: "local", command: ["sentry-mcp"], enabled: true } },
    });
    const { body, wasNew } = injectOpencode(existing, ENTRY);
    expect(wasNew).toBe(true);
    const parsed = JSON.parse(body) as {
      model: string;
      mcp: Record<string, unknown>;
    };
    expect(parsed.model).toBe("anthropic/claude-sonnet-4-5");
    expect(Object.keys(parsed.mcp).sort()).toEqual(["pathrule", "sentry"]);
  });

  it("overwrites an existing pathrule entry (wasNew false)", () => {
    const first = injectOpencode(null, ENTRY);
    const second = injectOpencode(first.body, { ...ENTRY, command: "/new/node" });
    expect(second.wasNew).toBe(false);
    expect(readOpencode(second.body)?.command).toBe("/new/node");
  });
});

describe("readOpencode", () => {
  it("round-trips inject → read", () => {
    const { body } = injectOpencode(null, ENTRY);
    const read = readOpencode(body);
    expect(read?.command).toBe(ENTRY.command);
    expect(read?.args).toEqual(ENTRY.args);
    expect(read?.env).toEqual(ENTRY.env);
  });

  it("returns null for malformed JSON instead of throwing", () => {
    expect(readOpencode("{ not json")).toBeNull();
  });
});

describe("removeOpencode", () => {
  it("strips our entry but keeps foreign servers", () => {
    const existing = JSON.stringify({
      mcp: { sentry: { type: "local", command: ["sentry-mcp"], enabled: true } },
    });
    const injected = injectOpencode(existing, ENTRY);
    const removed = removeOpencode(injected.body);
    expect(removed.wasPresent).toBe(true);
    const after = JSON.parse(removed.body!) as { mcp: Record<string, unknown> };
    expect(Object.keys(after.mcp)).toEqual(["sentry"]);
  });

  it("drops the file entirely when only $schema would remain", () => {
    const { body } = injectOpencode(null, ENTRY);
    const removed = removeOpencode(body);
    expect(removed.wasPresent).toBe(true);
    expect(removed.body).toBeNull();
  });

  it("is a no-op when our entry is absent", () => {
    const existing = JSON.stringify({ mcp: { sentry: { command: ["sentry-mcp"] } } });
    const removed = removeOpencode(existing);
    expect(removed.wasPresent).toBe(false);
    expect(removed.body).toBe(existing);
  });
});
