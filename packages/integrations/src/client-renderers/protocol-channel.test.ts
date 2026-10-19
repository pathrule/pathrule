// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { HOOK_CAPABLE_CLIENTS, resolveProtocolChannel } from "./protocol-channel.js";

describe("resolveProtocolChannel", () => {
  it("keeps the protocol on disk when no hook is installed", () => {
    const d = resolveProtocolChannel({ enabled: ["claude-code", "codex"], hookInstalled: [] });
    expect(d.signatureClients).toEqual([]);
    expect(d.protocolOnIndex).toBe(false);
  });

  it("moves the protocol to the hook only for a client whose hook is installed", () => {
    const d = resolveProtocolChannel({
      enabled: ["claude-code", "codex"],
      hookInstalled: ["claude-code"],
    });
    expect(d.signatureClients).toEqual(["claude-code"]);
    expect(d.protocolOnIndex).toBe(true);
  });

  // Windsurf can be enabled and can even be claimed as hook-installed by a
  // caller reading a stale record; it still has no hook builder, so its
  // protocol must not leave the disk.
  it("never signs a client Pathrule cannot install a hook for", () => {
    const d = resolveProtocolChannel({ enabled: ["windsurf"], hookInstalled: ["windsurf"] });
    expect(d.signatureClients).toEqual([]);
    expect(d.protocolOnIndex).toBe(false);
    expect(HOOK_CAPABLE_CLIENTS).not.toContain("windsurf");
  });

  it("ignores an installed hook for a client that is not enabled", () => {
    const d = resolveProtocolChannel({ enabled: ["windsurf"], hookInstalled: ["claude-code"] });
    expect(d.signatureClients).toEqual([]);
    expect(d.protocolOnIndex).toBe(false);
  });

  // The invariant that makes one decision safe to split across two writers.
  it("never disagrees with itself about whether the index needs the protocol", () => {
    const clients = ["claude-code", "cursor", "codex", "copilot", "windsurf"] as const;
    for (let mask = 0; mask < 1 << clients.length; mask += 1) {
      for (let hookMask = 0; hookMask < 1 << clients.length; hookMask += 1) {
        const enabled = clients.filter((_, i) => mask & (1 << i));
        const hookInstalled = clients.filter((_, i) => hookMask & (1 << i));
        const d = resolveProtocolChannel({ enabled, hookInstalled });
        expect(d.protocolOnIndex).toBe(d.signatureClients.length > 0);
        for (const id of d.signatureClients) {
          expect(enabled).toContain(id);
          expect(hookInstalled).toContain(id);
          expect(HOOK_CAPABLE_CLIENTS).toContain(id);
        }
      }
    }
  });

  // Migration ordering, enforced rather than documented. A workspace whose user
  // content is still sitting in a backup.* file must finish recovery before its
  // instruction file shrinks to three lines.
  it("holds the whole migration while a real backup is waiting to be restored", () => {
    const d = resolveProtocolChannel({
      enabled: ["claude-code", "codex"],
      hookInstalled: ["claude-code", "codex"],
      pendingRecovery: true,
    });
    expect(d.signatureClients).toEqual([]);
    expect(d.protocolOnIndex).toBe(false);
  });

  it("does not hold when nothing is pending", () => {
    const d = resolveProtocolChannel({
      enabled: ["codex"],
      hookInstalled: ["codex"],
      pendingRecovery: false,
    });
    expect(d.signatureClients).toEqual(["codex"]);
  });

  it("deduplicates a repeated client", () => {
    const d = resolveProtocolChannel({
      enabled: ["codex", "codex"],
      hookInstalled: ["codex"],
    });
    expect(d.signatureClients).toEqual(["codex"]);
  });
});
