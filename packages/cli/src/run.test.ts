// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseCliArgs } from "./args.js";
import { runCli } from "./run.js";

/**
 * A home that has already seen the daily update notice a distribution may turn on, as the product
 * leaves it, so tests about command output do not depend on first-run state.
 */
async function seedQuietHome(root: string): Promise<void> {
  await writeFile(join(root, ".cli-update-check"), new Date().toISOString(), "utf8");
}

class MemoryWriter {
  chunks: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
  toString() {
    return this.chunks.join("");
  }
}

describe("parseCliArgs", () => {
  it("turns json mode into non-interactive plain output", () => {
    const parsed = parseCliArgs(["doctor", "--json"], {});
    expect(parsed.command).toBe("doctor");
    expect(parsed.flags.json).toBe(true);
    expect(parsed.flags.interactive).toBe(false);
    expect(parsed.flags.color).toBe(false);
  });

  it("respects CI and NO_COLOR", () => {
    const parsed = parseCliArgs(["status"], { CI: "true", NO_COLOR: "1" });
    expect(parsed.flags.interactive).toBe(false);
    expect(parsed.flags.color).toBe(false);
  });

  it("parses the localhost browser callback login fallback flag", () => {
    const parsed = parseCliArgs(["login", "--browser-callback"], {});
    expect(parsed.flags.browserCallback).toBe(true);
  });

  it("keeps eject non-destructive unless --apply is passed", () => {
    expect(parseCliArgs(["eject"], {}).flags.apply).toBe(false);
    expect(parseCliArgs(["eject", "--apply"], {}).flags.apply).toBe(true);
  });
});

describe("runCli", () => {
  it("prints stable json envelopes", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const code = await runCli(["version", "--json"], {
      cwd: "/repo",
      env: {},
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(JSON.parse(stdout.toString())).toMatchObject({
      schema_version: 1,
      ok: true,
      command: "version",
      cwd: "/repo",
    });
  });

  it("returns EX_USAGE for unknown commands", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const code = await runCli(["nope", "--no-color"], {
      cwd: "/repo",
      env: {},
      stdout,
      stderr,
    });

    expect(code).toBe(64);
    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toContain('Unknown command "nope"');
  });

  it("rejects unknown help topics", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const code = await runCli(["help", "moon", "--json"], {
      cwd: "/repo",
      env: {},
      stdout,
      stderr,
    });

    expect(code).toBe(64);
    expect(stderr.toString()).toBe("");
    expect(JSON.parse(stdout.toString())).toMatchObject({
      ok: false,
      error: {
        code: "invalid_help_topic",
      },
    });
  });

  it("answers me --json with its own envelope, not unknown_command", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-cli-home-"));
    try {
      await seedQuietHome(root);
      const stdout = new MemoryWriter();
      const stderr = new MemoryWriter();
      const code = await runCli(["me", "list", "--json"], {
        cwd: "/repo",
        env: { PATHRULE_HOME: root, PATHRULE_DAEMON_AUTOSTART: "0" },
        stdout,
        stderr,
      });

      expect(code).toBe(0);
      expect(JSON.parse(stdout.toString())).toMatchObject({
        schema_version: 1,
        ok: true,
        command: "me list",
        data: { atoms: [] },
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("no longer accepts the retired start and bridge commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-cli-retired-"));
    try {
      for (const argv of [["start"], ["bridge", "pair"]]) {
        const stdout = new MemoryWriter();
        const stderr = new MemoryWriter();
        const code = await runCli([...argv, "--json"], {
          cwd: "/repo",
          env: { PATHRULE_HOME: root, NO_TELEMETRY: "1" },
          stdout,
          stderr,
        });

        expect(code).not.toBe(0);
        expect(JSON.parse(stdout.toString())).toMatchObject({
          ok: false,
          error: { code: "unknown_command" },
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("checks on request under update.policy manual, and not at all when updates are disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-update-json-"));
    try {
      const calls: string[] = [];
      const fetchImpl = (async (url: string) => {
        calls.push(String(url));
        return new Response("not found", { status: 404 });
      }) as typeof fetch;
      const manual = new MemoryWriter();
      expect(
        await runCli(["update", "--json"], {
          cwd: "/repo",
          env: { PATHRULE_HOME: root, PATHRULE_UPDATE_POLICY: "manual" },
          stdout: manual,
          stderr: new MemoryWriter(),
          fetch: fetchImpl,
        }),
      ).toBe(0);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(manual.toString())).toMatchObject({
        ok: true,
        data: { checked: false, policy: "notify", reason: "http_error", update_available: false },
      });

      const disabled = new MemoryWriter();
      await runCli(["update", "--json"], {
        cwd: "/repo",
        env: { PATHRULE_HOME: root, PATHRULE_DISABLE_UPDATES: "1" },
        stdout: disabled,
        stderr: new MemoryWriter(),
        fetch: (() => {
          throw new Error("should_not_fetch");
        }) as typeof fetch,
      });
      expect(JSON.parse(disabled.toString())).toMatchObject({
        ok: true,
        data: { checked: false, reason: "disabled" },
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("resolves update policy from environment without a session", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const code = await runCli(["config", "get", "update.policy", "--json"], {
      cwd: "/repo",
      env: { PATHRULE_UPDATE_POLICY: "manual" },
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.toString())).toMatchObject({
      ok: true,
      // The earlier `manual` is read as today's `notify`.
      data: { value: "notify", source: "env", configurable: false },
    });
  });

  it("no longer knows the desktop suggestion key Studio's removal retired", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const code = await runCli(["config", "get", "suggestions.desktop", "--json"], {
      cwd: "/repo",
      env: {},
      stdout,
      stderr,
    });

    expect(code).toBe(1);
    expect(JSON.parse(stdout.toString())).toMatchObject({
      ok: false,
      error: { code: "unsupported_config_key" },
    });
  });

  it("returns EX_USAGE for invalid install targets", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const code = await runCli(["install", "unknown", "--json"], {
      cwd: "/repo",
      env: {},
      stdout,
      stderr,
    });

    expect(code).toBe(64);
    expect(JSON.parse(stdout.toString())).toMatchObject({
      ok: false,
      error: { code: "invalid_install_target" },
    });
  });
});

// `pathrule eject` end to end through the CLI surface. The default path must
// PLAN and change nothing: this command deletes and rewrites files in the user's
// working tree, so a destructive default is how a trust feature becomes a
// support ticket.
describe("runCli eject", () => {
  async function repoWithPathrule(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pathrule-cli-eject-"));
    await mkdir(join(root, ".claude", "rules"), { recursive: true });
    await writeFile(
      join(root, ".claude", "rules", "pathrule-knowledge.md"),
      "<!-- Pathrule managed (knowledge) -->\n# knowledge\n",
    );
    await writeFile(
      join(root, "CLAUDE.md"),
      "# My project\n\nUse pnpm.\n\n<!-- pathrule:begin (managed by Pathrule; edits inside this region are overwritten) -->\nours\n<!-- pathrule:end -->\n",
    );
    return root;
  }

  it("plans without touching anything, then applies when told to", async () => {
    const { readFile, access } = await import("node:fs/promises");
    const root = await repoWithPathrule();
    try {
      const before = await readFile(join(root, "CLAUDE.md"), "utf8");

      const planOut = new MemoryWriter();
      const planCode = await runCli(["eject"], {
        cwd: root,
        env: {},
        stdout: planOut,
        stderr: new MemoryWriter(),
      });
      expect(planCode).toBe(0);
      expect(planOut.toString()).toContain("--apply");
      expect(planOut.toString()).toContain("strip_region: CLAUDE.md");
      // The plan changed nothing.
      expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(before);

      const applyOut = new MemoryWriter();
      const applyCode = await runCli(["eject", "--apply"], {
        cwd: root,
        env: {},
        stdout: applyOut,
        stderr: new MemoryWriter(),
      });
      expect(applyCode).toBe(0);
      expect(applyOut.toString()).toContain("ejected:");

      const after = await readFile(join(root, "CLAUDE.md"), "utf8");
      expect(after).toContain("Use pnpm.");
      expect(after).not.toContain("pathrule:begin");
      await expect(access(join(root, ".claude", "rules", "pathrule-knowledge.md"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("says there is nothing to eject in a repo Pathrule never touched", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-cli-clean-"));
    try {
      await writeFile(join(root, "CLAUDE.md"), "# Mine alone\n");
      const out = new MemoryWriter();
      const code = await runCli(["eject"], {
        cwd: root,
        env: {},
        stdout: out,
        stderr: new MemoryWriter(),
      });
      expect(code).toBe(0);
      expect(out.toString()).toContain("nothing to eject");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
