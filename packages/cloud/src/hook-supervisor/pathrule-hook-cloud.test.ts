// SPDX-License-Identifier: Apache-2.0
// The cloud extension's side of the hook extension contract (@pathrule/protocol/hook-extension.ts):
// the version and file name the hook loads it by, and every method the hook may call. The behaviour
// itself is pinned by the pathrule-hook-*.test.ts files beside this one, which drive the real hook.
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOOK_EXTENSION_CONTRACT,
  HOOK_EXTENSION_FILES,
  type HookCloudExtension,
  type HookExtensionHost,
  type HookExtensionModule,
} from "@pathrule/protocol/hook-extension.js";

const FILE = join(import.meta.dirname, "pathrule-hook-cloud.cjs");
const mod = createRequire(import.meta.url)(FILE) as HookExtensionModule<HookCloudExtension>;

const METHODS = {
  rankPrompt: true,
  askOnWorkConflict: true,
  exploreBash: true,
  recordToolOutcome: true,
  noteRouteFollow: true,
  logNavigation: true,
  logInjection: true,
} satisfies Record<keyof HookCloudExtension, true>;

const host = {
  pathruleHome: "/nonexistent-home",
  cacheDir: "/nonexistent-home/cache",
  binDir: "/nonexistent-home/bin",
  supervisorConfig: "/nonexistent-home/hook-supervisor.json",
  event: {},
  index: { workspace_id: "ws", workspace_root: "/repo" },
  workspaceId: "ws",
} as unknown as HookExtensionHost;

describe("the cloud hook extension", () => {
  it("speaks the protocol's contract version under the protocol's file name", () => {
    expect(mod.contract).toBe(HOOK_EXTENSION_CONTRACT);
    expect(basename(FILE)).toBe(HOOK_EXTENSION_FILES.cloud);
  });

  it("implements every method of the contract", () => {
    const ext = mod.create(host);
    for (const name of Object.keys(METHODS)) expect(typeof ext[name as keyof HookCloudExtension], name).toBe("function");
  });

  it("ranks nothing for an index without a hosted endpoint, so the hook ranks locally", () => {
    const ext = mod.create(host);
    expect(ext.rankPrompt({ index: host.index, text: "anything", limit: 8, minSimilarity: 0.4 })).toBeNull();
  });
});
