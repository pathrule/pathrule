// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import {
  cliTelemetryFirstUseNotice,
  cliTelemetryStatus,
  getCliTelemetryConfig,
  managedTelemetryTarget,
  recordCliCommandTelemetry,
  recordCliTelemetryEvent,
  recordDailyCliTelemetryEvent,
  resetCliTelemetryId,
  resolveTelemetryEnabled,
  setCliTelemetryEnabled,
  TELEMETRY_CONSENT_MODE,
} from "./telemetry.js";

/** A Pathrule Cloud session on disk: telemetry counts only a signed-in person (decision 12). */
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

/** The person turned telemetry on: nothing is collected before that (TELEMETRY_CONSENT_MODE). */
function consent(home: string): string {
  writeFileSync(
    join(home, "telemetry.json"),
    JSON.stringify({
      schema_version: 1,
      pseudonymous_install_id: "0b9a1f3e-6a0f-4a43-9a43-1c1e2a3b4c5d",
      telemetry_enabled: true,
    }),
    { mode: 0o600 },
  );
  return home;
}

describe("CLI telemetry", () => {
  it("records only allowlisted pseudonymous telemetry payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-telemetry-"));
    consent(signIn(root));
    try {
      const result = await recordCliTelemetryEvent(
        { PATHRULE_HOME: root },
        {
          eventName: "surface_viewed",
          result: "ok",
          appVersion: "0.0.0-test",
          durationMs: 12,
          featureTag: "surface",
        },
      );

      expect(result).toEqual({ recorded: true });
      const line = (await readFile(join(root, "logs", "telemetry-queue.jsonl"), "utf8")).trim();
      const payload = JSON.parse(line);
      expect(payload).toMatchObject({
        event_name: "surface_viewed",
        schema_version: 1,
        surface: "cli",
        host_kind: "cli-bridge",
        app_version: "0.0.0-test",
        result: "ok",
        feature_tag: "surface",
      });
      expect(payload).toHaveProperty("pseudonymous_install_id");
      expect(payload).toHaveProperty("session_local_id");
      expect(payload.event_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(payload)).not.toContain("@");
      expect(JSON.stringify(payload)).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("respects CI, NO_TELEMETRY, and local telemetry.enabled opt-out", async () => {
    const root = consent(signIn(await mkdtemp(join(tmpdir(), "pathrule-telemetry-disabled-"))));
    try {
      await expect(
        recordCliTelemetryEvent(
          { PATHRULE_HOME: root, CI: "true" },
          { eventName: "surface_viewed", result: "ok", appVersion: "0.0.0-test" },
        ),
      ).resolves.toEqual({ recorded: false, reason: "ci" });

      await expect(
        recordCliTelemetryEvent(
          { PATHRULE_HOME: root, NO_TELEMETRY: "1" },
          { eventName: "surface_viewed", result: "ok", appVersion: "0.0.0-test" },
        ),
      ).resolves.toEqual({ recorded: false, reason: "env" });

      await expect(
        recordCliTelemetryEvent(
          { PATHRULE_HOME: root, DO_NOT_TRACK: "1" },
          { eventName: "surface_viewed", result: "ok", appVersion: "0.0.0-test" },
        ),
      ).resolves.toEqual({ recorded: false, reason: "env" });

      await expect(setCliTelemetryEnabled("false", { PATHRULE_HOME: root })).resolves.toMatchObject(
        {
          key: "telemetry.enabled",
          value: false,
          source: "config",
        },
      );
      await expect(
        recordCliTelemetryEvent(
          { PATHRULE_HOME: root },
          { eventName: "surface_viewed", result: "ok", appVersion: "0.0.0-test" },
        ),
      ).resolves.toEqual({ recorded: false, reason: "config" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records nothing without a Pathrule Cloud account on this machine", async () => {
    const root = consent(await mkdtemp(join(tmpdir(), "pathrule-telemetry-local-")));
    try {
      await expect(
        recordCliTelemetryEvent(
          { PATHRULE_HOME: root },
          { eventName: "workspace_initialized", result: "ok", appVersion: "0.0.0-test" },
        ),
      ).resolves.toEqual({ recorded: false, reason: "no_account" });
      await recordCliCommandTelemetry(
        { PATHRULE_HOME: root },
        { command: "init", exitCode: 0, appVersion: "0.0.0-test", durationMs: 1 },
      );
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(root)).not.toContain("logs");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rotates the pseudonymous telemetry id without account identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-telemetry-id-"));
    try {
      const first = await getCliTelemetryConfig("telemetry.id", { PATHRULE_HOME: root });
      const second = await resetCliTelemetryId({ PATHRULE_HOME: root });

      expect(first.key).toBe("telemetry.id");
      expect(second.key).toBe("telemetry.id");
      expect(second.value).not.toEqual(first.value);
      expect(second.value).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records dead-end telemetry for failed repair/setup routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-telemetry-dead-end-"));
    consent(signIn(root));
    try {
      await recordCliCommandTelemetry(
        { PATHRULE_HOME: root },
        { command: "doctor", exitCode: 1, appVersion: "0.0.0-test", durationMs: 7 },
      );

      const lines = (await readFile(join(root, "logs", "telemetry-queue.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines.map((line) => line.event_name)).toEqual(["cli_doctor_failed", "dead_end_seen"]);
      expect(lines[1]).toMatchObject({
        result: "blocked",
        blocking_reason: "doctor_cannot_repair",
        feature_tag: "cli_doctor",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps a successful init, install and login onto the install funnel", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-telemetry-funnel-"));
    consent(signIn(root));
    try {
      for (const command of ["init", "install", "login", "init"]) {
        await recordCliCommandTelemetry(
          { PATHRULE_HOME: root },
          { command, exitCode: 0, appVersion: "0.0.0-test", durationMs: 3 },
        );
      }
      await recordCliCommandTelemetry(
        { PATHRULE_HOME: root },
        { command: "install", exitCode: 1, appVersion: "0.0.0-test", durationMs: 3 },
      );
      const events = (await readFile(join(root, "logs", "telemetry-queue.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.map((e) => [e.event_name, e.feature_tag])).toEqual([
        ["workspace_initialized", "cli_init"],
        ["agent_connected", "cli_install"],
        ["cli_login_completed", "cli_login"],
        ["workspace_initialized", "cli_init"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records a daily event once per day and tag, across processes through the config file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-telemetry-daily-"));
    consent(signIn(root));
    const env = { PATHRULE_HOME: root };
    const day = new Date("2026-10-09T10:00:00.000Z");
    try {
      const args = { eventName: "mcp_used" as const, featureTag: "claude_code", appVersion: "t" };
      expect(await recordDailyCliTelemetryEvent(env, args, day)).toEqual({ recorded: true });
      expect(await recordDailyCliTelemetryEvent(env, args, day)).toEqual({ recorded: false, reason: "today" });
      expect(
        await recordDailyCliTelemetryEvent(env, { ...args, featureTag: "cursor" }, day),
      ).toEqual({ recorded: true });
      expect(
        await recordDailyCliTelemetryEvent(env, args, new Date("2026-10-10T00:00:01.000Z")),
      ).toEqual({ recorded: true });
      const events = (await readFile(join(root, "logs", "telemetry-queue.jsonl"), "utf8"))
        .trim()
        .split("\n");
      expect(events).toHaveLength(3);
      expect(
        await recordDailyCliTelemetryEvent({ ...env, NO_TELEMETRY: "1" }, { ...args, featureTag: "x" }, day),
      ).toEqual({ recorded: false, reason: "env" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps at most 500 unsent events, dropping and counting the oldest", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-telemetry-bound-"));
    consent(signIn(root));
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(root, "logs"), { recursive: true });
      const old = Array.from({ length: 510 }, (_, i) => JSON.stringify({ event_name: `old-${i}` }));
      await writeFile(join(root, "logs", "telemetry-queue.jsonl"), `${old.join("\n")}\n`);
      await recordCliTelemetryEvent(
        { PATHRULE_HOME: root },
        { eventName: "surface_viewed", result: "ok", appVersion: "0.0.0-test" },
      );
      const lines = (await readFile(join(root, "logs", "telemetry-queue.jsonl"), "utf8"))
        .trim()
        .split("\n");
      expect(lines).toHaveLength(500);
      expect(JSON.parse(lines[0]!).event_name).toBe("old-11");
      expect(JSON.parse(lines[499]!).event_name).toBe("surface_viewed");
      const config = JSON.parse(await readFile(join(root, "telemetry.json"), "utf8"));
      expect(config.dropped_events).toBe(11);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("CLI telemetry delivery", () => {
  afterEach(() => {
    delete (globalThis as { __BUILD_NATIVE_CLOUD_URL__?: string }).__BUILD_NATIVE_CLOUD_URL__;
    delete (globalThis as { __BUILD_POSTHOG_PROJECT_KEY__?: string }).__BUILD_POSTHOG_PROJECT_KEY__;
  });

  it("sends nothing from a source build or a run on another Pathrule Cloud", () => {
    expect(managedTelemetryTarget({})).toBeNull();
    (globalThis as { __BUILD_NATIVE_CLOUD_URL__?: string }).__BUILD_NATIVE_CLOUD_URL__ = "https://cloud.pathrule.io";
    // A build that names Pathrule Cloud but carries no project key sends nothing either.
    expect(managedTelemetryTarget({})).toBeNull();
    (globalThis as { __BUILD_POSTHOG_PROJECT_KEY__?: string }).__BUILD_POSTHOG_PROJECT_KEY__ = "phc_test";
    expect(managedTelemetryTarget({})).toMatchObject({ url: "https://eu.i.posthog.com/batch/" });
    expect(managedTelemetryTarget({ PATHRULE_NATIVE_CLOUD_URL: "https://cloud.pathrule.io/" })).not.toBeNull();
    expect(managedTelemetryTarget({ PATHRULE_NATIVE_CLOUD_URL: "https://staging.example.test" })).toBeNull();
    expect(managedTelemetryTarget({ PATHRULE_NATIVE_CLOUD_URL: "http://127.0.0.1:8787" })).toBeNull();
  });

  it("posts the queue to PostHog as personless events with stable uuids, and keeps it on a 5xx", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-telemetry-send-"));
    consent(signIn(root));
    const bodies: Array<Record<string, unknown>> = [];
    let status = 503;
    const server = createServer((req: IncomingMessage, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(status, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const env = {
      PATHRULE_HOME: root,
      PATHRULE_TELEMETRY_HOST: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      PATHRULE_TELEMETRY_KEY: "phc_test",
    };
    const queue = join(root, "logs", "telemetry-queue.jsonl");
    try {
      await recordCliTelemetryEvent(env, {
        eventName: "agent_connected",
        result: "ok",
        appVersion: "1.2.3",
        featureTag: "cli_install",
      });
      expect((await readFile(queue, "utf8")).trim().split("\n")).toHaveLength(1);

      status = 200;
      await recordCliTelemetryEvent(env, { eventName: "surface_viewed", result: "ok", appVersion: "1.2.3" });
      expect(await readFile(queue, "utf8")).toBe("");

      const sent = bodies[1] as { api_key: string; batch: Array<Record<string, any>> };
      expect(sent.api_key).toBe("phc_test");
      expect(sent.batch.map((e) => e.event)).toEqual(["agent_connected", "surface_viewed"]);
      // The retried event is the same event: its uuid did not change between the two attempts.
      expect(sent.batch[0]!.uuid).toBe((bodies[0] as typeof sent).batch[0]!.uuid);
      expect(sent.batch[0]).toMatchObject({
        distinct_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        properties: {
          $process_person_profile: false,
          $lib: "pathrule-cli",
          surface: "cli",
          result: "ok",
          feature_tag: "cli_install",
          app_version: "1.2.3",
        },
      });
      expect(JSON.stringify(sent)).not.toContain(root);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("CLI telemetry consent", () => {
  // A managed target without a build: PATHRULE_TELEMETRY_HOST names one, as the delivery tests do.
  const managed = { PATHRULE_TELEMETRY_HOST: "http://127.0.0.1:9", PATHRULE_TELEMETRY_KEY: "phc_test" };

  it("collects nothing until the person turns it on, while the consent model is opt-in", async () => {
    expect(TELEMETRY_CONSENT_MODE).toBe("opt-in");
    const root = signIn(await mkdtemp(join(tmpdir(), "pathrule-telemetry-optin-")));
    const env = { PATHRULE_HOME: root, ...managed };
    try {
      await expect(
        recordCliTelemetryEvent(env, { eventName: "surface_viewed", result: "ok", appVersion: "t" }),
      ).resolves.toEqual({ recorded: false, reason: "default" });
      await expect(
        recordDailyCliTelemetryEvent(env, { eventName: "mcp_used", featureTag: "codex", appVersion: "t" }),
      ).resolves.toEqual({ recorded: false, reason: "default" });
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(root)).not.toContain("logs");

      const enabled = await setCliTelemetryEnabled("true", env);
      expect(enabled).toMatchObject({ value: true, source: "config" });
      const config = JSON.parse(await readFile(join(root, "telemetry.json"), "utf8"));
      expect(Date.parse(config.telemetry_decided_at)).not.toBeNaN();
      await expect(
        recordCliTelemetryEvent(env, { eventName: "surface_viewed", result: "ok", appVersion: "t" }),
      ).resolves.toEqual({ recorded: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("under the notice model, sends only after a notice shown in an earlier run", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(resolveTelemetryEnabled({}, null, "notice")).toMatchObject({
      value: false,
      source: "notice_pending",
    });
    expect(resolveTelemetryEnabled({}, { notice_shown_at: future }, "notice").value).toBe(false);
    expect(resolveTelemetryEnabled({}, { notice_shown_at: past }, "notice")).toMatchObject({
      value: true,
      source: "default",
    });
    expect(
      resolveTelemetryEnabled({}, { notice_shown_at: past, telemetry_enabled: false }, "notice"),
    ).toMatchObject({ value: false, source: "config" });
    expect(resolveTelemetryEnabled({ CI: "1" }, { telemetry_enabled: true }, "notice").source).toBe("ci");
    expect(resolveTelemetryEnabled({ DO_NOT_TRACK: "true" }, { telemetry_enabled: true }, "notice").source).toBe(
      "env",
    );
    expect(resolveTelemetryEnabled({ CI: "false" }, { telemetry_enabled: true }, "opt-in").value).toBe(true);
    expect(resolveTelemetryEnabled({}, { notice_shown_at: past }, "opt-in").value).toBe(false);
  });

  it("shows the first-use notice once, only where telemetry could apply", async () => {
    const root = signIn(await mkdtemp(join(tmpdir(), "pathrule-telemetry-notice-")));
    const env = { PATHRULE_HOME: root, ...managed };
    try {
      for (const off of [{ CI: "true" }, { NO_TELEMETRY: "1" }, { DO_NOT_TRACK: "1" }]) {
        expect(await cliTelemetryFirstUseNotice({ ...env, ...off })).toBeNull();
      }
      // A build that does not send (no managed target) says nothing.
      expect(await cliTelemetryFirstUseNotice({ PATHRULE_HOME: root })).toBeNull();

      const notice = await cliTelemetryFirstUseNotice(env);
      expect(notice).toContain("It is off");
      expect(notice).toContain("pathrule telemetry enable");
      expect(notice).not.toMatch(/\n/);
      // Recorded so it never repeats, with no install id: nothing identifies the install yet.
      const saved = JSON.parse(await readFile(join(root, "telemetry.json"), "utf8"));
      expect(Date.parse(saved.notice_shown_at)).not.toBeNaN();
      expect(saved).not.toHaveProperty("pseudonymous_install_id");
      expect(await cliTelemetryFirstUseNotice(env)).toBeNull();
      // Showing it consents to nothing.
      await expect(
        recordCliTelemetryEvent(env, { eventName: "surface_viewed", result: "ok", appVersion: "t" }),
      ).resolves.toEqual({ recorded: false, reason: "default" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows no notice without an account, or once the person has chosen", async () => {
    const local = await mkdtemp(join(tmpdir(), "pathrule-telemetry-notice-local-"));
    const chosen = signIn(await mkdtemp(join(tmpdir(), "pathrule-telemetry-notice-chosen-")));
    try {
      expect(await cliTelemetryFirstUseNotice({ PATHRULE_HOME: local, ...managed })).toBeNull();
      await setCliTelemetryEnabled("false", { PATHRULE_HOME: chosen });
      expect(await cliTelemetryFirstUseNotice({ PATHRULE_HOME: chosen, ...managed })).toBeNull();
    } finally {
      await rm(local, { recursive: true, force: true });
      await rm(chosen, { recursive: true, force: true });
    }
  });

  it("drops the unsent queue when the person turns telemetry off, and reports the state", async () => {
    const root = consent(signIn(await mkdtemp(join(tmpdir(), "pathrule-telemetry-off-"))));
    const env = { PATHRULE_HOME: root, ...managed };
    const queue = join(root, "logs", "telemetry-queue.jsonl");
    try {
      await recordCliTelemetryEvent(env, { eventName: "surface_viewed", result: "ok", appVersion: "t" });
      expect((await cliTelemetryStatus(env)).queued_events).toBe(1);
      await setCliTelemetryEnabled("false", env);
      const { existsSync } = await import("node:fs");
      expect(existsSync(queue)).toBe(false);
      expect(await cliTelemetryStatus(env)).toMatchObject({
        enabled: { value: false, source: "config" },
        consent_mode: "opt-in",
        managed_build: true,
        signed_in: true,
        collecting: false,
        queued_events: 0,
      });
      expect(await cliTelemetryStatus({ PATHRULE_HOME: root })).toMatchObject({ managed_build: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
