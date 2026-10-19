// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderTelemetry, runTelemetryJson } from "./commands/telemetry.js";
import { cloudCliPlugin } from "./plugin.js";

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

const plain = { json: false, color: false, interactive: true };

function signIn(home: string): string {
  writeFileSync(
    join(home, "native-session.json"),
    JSON.stringify({
      schema_version: 1,
      base_url: "https://cloud.pathrule.io",
      user_id: "user-1",
      token: "t",
      expires_at: "2100-01-01T00:00:00.000Z",
      updated_at: "2026-10-17T00:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  return home;
}

describe("pathrule telemetry", () => {
  it("is a command of the account's plugin, which also gives the first-use notice", () => {
    const plugin = cloudCliPlugin();
    const command = plugin.commands?.find((c) => c.name === "telemetry");
    expect(command?.help?.section).toBe("diagnostics");
    // No notice after the command that already shows everything.
    expect(command?.quiet).toBe(true);
    expect(typeof plugin.passiveNotice).toBe("function");
  });

  it("shows the state, then turns telemetry on and off persistently", async () => {
    const root = signIn(await mkdtemp(join(tmpdir(), "pathrule-telemetry-command-")));
    const env = {
      PATHRULE_HOME: root,
      PATHRULE_TELEMETRY_HOST: "http://127.0.0.1:9",
      PATHRULE_TELEMETRY_KEY: "phc_test",
    };
    const runtime = () => ({
      cwd: "/repo",
      env,
      stdout: new MemoryWriter(),
      stderr: new MemoryWriter(),
    });
    try {
      const status = runtime();
      expect(await renderTelemetry([], status, plain)).toBe(0);
      expect(status.stdout.toString()).toContain(
        "Telemetry: off (the default until you turn it on)",
      );
      expect(status.stdout.toString()).toContain("Turn it on: pathrule telemetry enable");
      expect(status.stdout.toString()).toContain("Never code, file");

      const enable = runtime();
      expect(await renderTelemetry(["enable"], enable, plain)).toBe(0);
      expect(enable.stdout.toString()).toContain("Telemetry: on (you turned it on)");
      expect(enable.stdout.toString()).toContain("Sent from this install: yes");
      expect(
        JSON.parse(await readFile(join(root, "telemetry.json"), "utf8")).telemetry_enabled,
      ).toBe(true);

      const disabled = await runTelemetryJson(runtime(), "telemetry", ["disable"]);
      expect(disabled.exitCode).toBe(0);
      expect(disabled.envelope.data).toMatchObject({
        enabled: { value: false, source: "config" },
        collecting: false,
      });

      const usage = runtime();
      expect(await renderTelemetry(["maybe"], usage, plain)).toBe(64);
      expect(usage.stderr.toString()).toContain(
        "Usage: pathrule telemetry [status|enable|disable]",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("says a build without an analytics key sends nothing and offers nothing to turn on", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-telemetry-command-unmanaged-"));
    const runtime = {
      cwd: "/repo",
      env: { PATHRULE_HOME: root },
      stdout: new MemoryWriter(),
      stderr: new MemoryWriter(),
    };
    try {
      expect(await renderTelemetry([], runtime, plain)).toBe(0);
      const out = runtime.stdout.toString();
      expect(out).toContain("send no usage data");
      expect(out).toContain("there is nothing to turn on");
      expect(out).not.toMatch(/PostHog|Turn it on|anonymous usage events/);
      const enable = { ...runtime, stdout: new MemoryWriter(), stderr: new MemoryWriter() };
      expect(await renderTelemetry(["enable"], enable, plain)).toBe(0);
      expect(enable.stderr.toString()).toBe("");
      expect(enable.stdout.toString()).toContain("there is nothing to turn on");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("says when an environment opt-out keeps it off whatever is saved", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-telemetry-command-env-"));
    const runtime = {
      cwd: "/repo",
      env: {
        PATHRULE_HOME: root,
        DO_NOT_TRACK: "1",
        PATHRULE_TELEMETRY_HOST: "http://127.0.0.1:9",
        PATHRULE_TELEMETRY_KEY: "phc_test",
      },
      stdout: new MemoryWriter(),
      stderr: new MemoryWriter(),
    };
    try {
      expect(await renderTelemetry(["enable"], runtime, plain)).toBe(0);
      expect(runtime.stderr.toString()).toContain("telemetry stays off here");
      expect(runtime.stdout.toString()).toContain("Sent from this install: no");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
