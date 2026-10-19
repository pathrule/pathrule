// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  integrationFor,
  integrationRecordId,
  parseIntegrationRegistry,
  type IntegrationRecord,
} from "./integration-registry.js";
import {
  LAUNCHER_CONTRACT,
  compareRuntimeVersions,
  parseRuntimeManifest,
  runtimeCompatibility,
} from "./runtime-manifest.js";
import { foldDeliveryLedger, isDelivered, isSafeSessionId } from "./session-delivery.js";

const manifest = {
  schema_version: 1,
  launcher_contract: LAUNCHER_CONTRACT,
  runtime_version: "0.7.0",
  hook_extension_contract: 1,
  hook_index_schemas: [1, 2],
  hook: "/home/p/.pathrule/bin/pathrule-hook.js",
  cli: { node: "/usr/bin/node", entry: "/home/p/.pathrule/runtime/0.7.0/cli/dist/index.js" },
  mcp: {
    command: "/usr/bin/node",
    args: ["/x/index.js", "mcp", "run"],
    env: { PATHRULE_LOCAL: "1", SECRET_TOKEN: "never", OPENAI_API_KEY: "never", SERVICE_URL: "https://service.example" },
  },
  mode: "local",
  maintenance: { consent: true, recorded_at: "2026-10-10T00:00:00.000Z" },
  written_at: "2026-10-10T00:00:00.000Z",
};

describe("runtime manifest", () => {
  it("parses a well-formed manifest and drops non-allowlisted launch env", () => {
    const parsed = parseRuntimeManifest(manifest);
    expect(parsed?.runtime_version).toBe("0.7.0");
    expect(parsed?.mcp?.env).toEqual({ PATHRULE_LOCAL: "1", SERVICE_URL: "https://service.example" });
    expect(parsed?.maintenance.consent).toBe(true);
  });

  it("rejects another schema and missing fields", () => {
    expect(parseRuntimeManifest({ ...manifest, schema_version: 2 })).toBeNull();
    expect(parseRuntimeManifest({ ...manifest, cli: { node: "/usr/bin/node" } })).toBeNull();
    expect(parseRuntimeManifest(null)).toBeNull();
  });

  it("refuses another launcher contract and an older runtime", () => {
    expect(runtimeCompatibility(manifest, { launcherContract: LAUNCHER_CONTRACT, minRuntime: "0.7.0" })).toEqual({
      ok: true,
    });
    expect(
      runtimeCompatibility(manifest, { launcherContract: LAUNCHER_CONTRACT + 1, minRuntime: "0.1.0" }).ok,
    ).toBe(false);
    const old = runtimeCompatibility(manifest, { launcherContract: LAUNCHER_CONTRACT, minRuntime: "0.10.0" });
    expect(old.ok === false && old.reason).toBe("runtime_too_old");
    expect(compareRuntimeVersions("0.10.0", "0.9.9")).toBe(1);
  });
});

describe("session delivery ledger", () => {
  const receipt = (over: Record<string, unknown>) =>
    JSON.stringify({
      v: 1,
      type: "receipt",
      at: "t",
      workspace_id: "w",
      session_id: "s",
      epoch: 0,
      channel: "hook",
      item: { kind: "memory", id: "m1", hash: "h1", scope: "project" },
      provenance: { source: "hook-index" },
      status: "confirmed",
      ...over,
    });

  it("counts only the current epoch's confirmed receipts", () => {
    const state = foldDeliveryLedger([
      receipt({}),
      JSON.stringify({ v: 1, type: "epoch", at: "t", workspace_id: "w", session_id: "s", epoch: 1, reason: "compact" }),
      receipt({ epoch: 1, item: { kind: "rule", id: "r1", hash: "x", scope: "project" }, channel: "mcp" }),
      "not json",
    ]);
    expect(state.epoch).toBe(1);
    expect(isDelivered(state, "memory", "m1", "h1")).toBe(false);
    expect(isDelivered(state, "rule", "r1", "x")).toBe(true);
  });

  it("treats an edited item as undelivered and a failed delivery as never confirmed", () => {
    const state = foldDeliveryLedger([
      receipt({}),
      receipt({ item: { kind: "memory", id: "m2", hash: "a", scope: "user" } }),
      receipt({ item: { kind: "memory", id: "m2", hash: "a", scope: "user" }, status: "failed", reason: "provider_limit" }),
    ]);
    expect(isDelivered(state, "memory", "m1", "h1")).toBe(true);
    expect(isDelivered(state, "memory", "m1", "changed")).toBe(false);
    expect(isDelivered(state, "memory", "m2", "a")).toBe(false);
  });

  it("accepts only file-safe session ids", () => {
    expect(isSafeSessionId("798ff6bc-ce34-4216-bb8f-13b9666a67af")).toBe(true);
    expect(isSafeSessionId("../etc")).toBe(false);
    expect(isSafeSessionId("..")).toBe(false);
  });
});

describe("integration registry", () => {
  const record = (over: Partial<IntegrationRecord>): IntegrationRecord => ({
    id: "",
    provider: "claude-code",
    scope: "user",
    project_root: null,
    mode: "local",
    channel: "native-plugin",
    edition: "full",
    mcp: true,
    plugin_version: "0.7.0",
    runtime_version: "0.7.0",
    installed_at: "t",
    updated_at: "t",
    status: "installed",
    resources: [{ kind: "provider-plugin", provider: "claude-code", plugin: "pathrule", marketplace: "pathrule", scope: "user" }],
    ...over,
  });

  it("drops malformed records and resources, and recomputes ids", () => {
    const registry = parseIntegrationRegistry({
      schema_version: 1,
      integrations: [
        record({ id: "forged" }),
        { provider: "unknown-agent" },
        record({ scope: "project", project_root: null }),
        record({ provider: "codex", resources: [{ kind: "nope" } as never] }),
      ],
    });
    expect(registry.integrations.map((r) => r.id)).toEqual(["claude-code:user", "codex:user"]);
    expect(registry.integrations[1]?.resources).toEqual([]);
  });

  it("prefers the deepest project record that contains the cwd, then the user record", () => {
    const registry = parseIntegrationRegistry({
      schema_version: 1,
      integrations: [
        record({}),
        record({ scope: "project", project_root: "/repo", channel: "settings-hook" }),
        record({ scope: "project", project_root: "/repo/apps/web", mcp: false }),
      ],
    });
    const contains = (root: string, p: string) => p === root || p.startsWith(`${root}/`);
    expect(integrationFor(registry, "claude-code", "/repo/apps/web/src", contains)?.mcp).toBe(false);
    expect(integrationFor(registry, "claude-code", "/repo/x", contains)?.channel).toBe("settings-hook");
    expect(integrationFor(registry, "claude-code", "/elsewhere", contains)?.id).toBe("claude-code:user");
    expect(integrationRecordId("codex", "project", "/r")).toBe("codex:project:/r");
  });
});
