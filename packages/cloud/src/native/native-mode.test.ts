// SPDX-License-Identifier: Apache-2.0
// When the build or the run names Pathrule Cloud, the CLI's MCP server and host compose its native
// account; where none is named, it has no account at all.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostPluginContext } from "@pathrule/host/plugin.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { cloudMcpPlugin } = await import("../mcp/plugin.js");
const { cloudCliHostPlugin } = await import("../cli/host-plugin.js");

let home: string;
let nativeEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pathrule-native-mode-"));
  nativeEnv = {
    PATHRULE_HOME: home,
    PATHRULE_NATIVE_CLOUD_URL: "https://cloud.pathrule.io",
    PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-cli-production",
  };
});
afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function fakeHostContext(env: NodeJS.ProcessEnv) {
  const provided: unknown[] = [];
  const methods: string[] = [];
  const ctx = {
    env,
    provideAccount: (edition: unknown) => provided.push(edition),
    registerMethod: (name: string) => methods.push(name),
    keepAlive: () => () => {},
    log: () => {},
  } as unknown as HostPluginContext;
  return { ctx, provided, methods };
}

describe("Pathrule Cloud's native account in the CLI's MCP server and host", () => {
  it("serves the MCP server through the open tools, with the person and the Project bound", () => {
    const plugin = cloudMcpPlugin({ env: nativeEnv });
    expect(plugin.tools).toEqual([]);
    expect(plugin.personalAccount).toBeDefined();
    expect(plugin.projectAccount).toBeDefined();
  });

  it("has no account where no Pathrule Cloud is named: the open server alone", () => {
    const plugin = cloudMcpPlugin({ env: { PATHRULE_HOME: home } });
    expect(plugin.tools).toEqual([]);
    expect(plugin.personalAccount).toBeUndefined();
    expect(plugin.projectAccount).toBeUndefined();
  });

  it("gives the host the native edition, and no daemon job or mirror queue", async () => {
    const { ctx, provided, methods } = fakeHostContext(nativeEnv);
    const plugin = cloudCliHostPlugin();
    await plugin.activate!(ctx);
    expect(provided).toHaveLength(1);
    expect(methods).toEqual([]);
    await plugin.deactivate?.();
  });

  it("answers a signed-out person with no Project and no person, without the legacy backend", async () => {
    const plugin = cloudMcpPlugin({ env: nativeEnv });
    expect(
      await plugin.projectAccount!.resolveContext({ workspaceId: null, cwd: home }),
    ).toBeNull();
    expect(await plugin.personalAccount!.bind("ws-1")).toBeNull();
  });
});
