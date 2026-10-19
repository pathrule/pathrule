// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { PATHRULE_CONTRACTS } from "./compatibility.js";
import {
  assessComponent,
  assessServiceContracts,
  canonicalReleaseJson,
  compareVersions,
  isNewerVersion,
  parseReleaseEnvelope,
  parseReleaseManifest,
  releaseManifestSigningPayload,
  type ReleaseManifest,
} from "./release-manifest.js";

const SHA512 = `${"A".repeat(86)}==`;

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    sequence: 7,
    generated_at: "2026-10-13T10:00:00Z",
    expires_at: "2027-04-11T10:00:00Z",
    source_commit: "b07c03802",
    components: {
      cli: {
        minimum_version: "1.0.0",
        restart: "new-session",
        contracts: { mcp_surface: 1, cloud_api: 1 },
        channels: {
          npm: {
            latest: {
              version: "1.0.1",
              published_at: "2026-10-13T09:00:00Z",
              verified_at: "2026-10-13T09:05:00Z",
              release_notes_url: "https://pathrule.io/changelog#1.0.1",
              integrity: { algorithm: "sha512", digest: SHA512 },
              package: "@pathrule/cli",
            },
          },
          homebrew: {
            latest: {
              version: "1.0.0",
              published_at: "2026-10-01T09:00:00Z",
              verified_at: "2026-10-01T09:30:00Z",
            },
          },
        },
      },
      vscode: {
        restart: "restart-extensions",
        channels: {
          "vscode-marketplace": {
            latest: {
              version: "0.8.1",
              published_at: "2026-10-13T09:00:00Z",
              verified_at: "2026-10-13T09:10:00Z",
              package: "pathrule.pathrule-vscode",
            },
          },
          // Open VSX failed this round: it still carries the previous verified release.
          "open-vsx": {
            latest: {
              version: "0.8.0",
              published_at: "2026-10-01T09:00:00Z",
              verified_at: "2026-10-01T09:10:00Z",
            },
          },
        },
      },
      cloud: {
        restart: "none",
        accepts: { cloud_api: { min: 1, max: 2 }, mcp_surface: { min: 1, max: 1 } },
        channels: {},
      },
    },
    ...overrides,
  };
}

function parsed(raw: Record<string, unknown> = manifest()): ReleaseManifest {
  const result = parseReleaseManifest(raw);
  if (!result.ok) throw new Error(result.detail);
  return result.manifest;
}

describe("release manifest parsing", () => {
  it("accepts a well-formed manifest", () => {
    const m = parsed();
    expect(m.sequence).toBe(7);
    expect(m.components.cli?.channels.npm?.latest?.version).toBe("1.0.1");
    expect(m.components.cloud?.accepts?.cloud_api).toEqual({ min: 1, max: 2 });
  });

  it("keeps components, channels and tracks it does not know out of the parse", () => {
    const raw = manifest();
    const components = raw.components as Record<string, Record<string, unknown>>;
    components.jetbrains = { restart: "none", channels: {} };
    (components.cli!.channels as Record<string, unknown>).scoop = {};
    (components.cli!.channels as Record<string, Record<string, unknown>>).npm!.beta = {
      version: "2.0.0-beta.1",
      published_at: "2026-10-13T09:00:00Z",
      verified_at: "2026-10-13T09:00:00Z",
    };
    const m = parsed(raw);
    expect(Object.keys(m.components)).not.toContain("jetbrains");
    expect(Object.keys(m.components.cli!.channels)).toEqual(["npm", "homebrew"]);
    expect(Object.keys(m.components.cli!.channels.npm!)).toEqual(["latest"]);
  });

  it("names a newer schema as unsupported rather than invalid", () => {
    expect(parseReleaseManifest(manifest({ schema_version: 2 }))).toMatchObject({
      ok: false,
      reason: "unsupported_schema",
    });
    expect(parseReleaseManifest(manifest({ schema_version: "1" }))).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  const tampered: Array<[string, (raw: any) => void]> = [
    ["a zero sequence", (r) => (r.sequence = 0)],
    ["a fractional sequence", (r) => (r.sequence = 1.5)],
    ["an expiry before generation", (r) => (r.expires_at = "2026-10-12T10:00:00Z")],
    ["a lifetime beyond 400 days", (r) => (r.expires_at = "2028-10-13T10:00:00Z")],
    ["a non-ISO date", (r) => (r.generated_at = "yesterday")],
    [
      "a version that is not semver",
      (r) => (r.components.cli.channels.npm.latest.version = "latest"),
    ],
    [
      "an http release notes URL",
      (r) => (r.components.cli.channels.npm.latest.release_notes_url = "http://x.io"),
    ],
    [
      "a URL with credentials",
      (r) => (r.components.cli.channels.npm.latest.release_notes_url = "https://a:b@x.io"),
    ],
    [
      "a javascript: URL",
      (r) => (r.components.cli.channels.npm.latest.artifact_url = "javascript:alert(1)"),
    ],
    [
      "a short sha256",
      (r) =>
        (r.components.cli.channels.npm.latest.integrity = { algorithm: "sha256", digest: "abc" }),
    ],
    [
      "an unknown digest algorithm",
      (r) =>
        (r.components.cli.channels.npm.latest.integrity = {
          algorithm: "md5",
          digest: "a".repeat(32),
        }),
    ],
    [
      "verification before publication",
      (r) => (r.components.cli.channels.npm.latest.verified_at = "2026-10-13T08:00:00Z"),
    ],
    ["an unknown restart", (r) => (r.components.cli.restart = "reboot")],
    [
      "an inverted contract range",
      (r) => (r.components.cloud.accepts.cloud_api = { min: 3, max: 1 }),
    ],
    ["a negative size", (r) => (r.components.cli.channels.npm.latest.size_bytes = -1)],
    [
      "a shell command as a package",
      (r) => (r.components.cli.channels.npm.latest.package = "x; rm -rf ~"),
    ],
    ["a non-hex commit", (r) => (r.source_commit = "main")],
    ["channels that are not an object", (r) => (r.components.cli.channels = [])],
  ];
  for (const [name, mutate] of tampered) {
    it(`refuses ${name}`, () => {
      const raw = manifest();
      mutate(raw);
      expect(parseReleaseManifest(raw)).toMatchObject({ ok: false, reason: "invalid" });
    });
  }
});

describe("canonical signing payload", () => {
  it("does not depend on key order or whitespace", () => {
    const a = { b: 1, a: { d: [1, "x"], c: null } };
    const b = JSON.parse(JSON.stringify({ a: { c: null, d: [1, "x"] }, b: 1 }, null, 2));
    expect(canonicalReleaseJson(a)).toBe(canonicalReleaseJson(b));
    expect(canonicalReleaseJson(a)).toBe('{"a":{"c":null,"d":[1,"x"]},"b":1}');
  });

  it("drops undefined members the way JSON does, and refuses what JSON cannot carry", () => {
    expect(canonicalReleaseJson({ a: undefined, b: 2 })).toBe('{"b":2}');
    expect(() => canonicalReleaseJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalReleaseJson({ f: () => 1 })).toThrow();
  });

  it("is domain-separated", () => {
    expect(releaseManifestSigningPayload({ a: 1 })).toBe('pathrule-release-manifest/v1\n{"a":1}');
  });
});

describe("envelope shape", () => {
  it("accepts signed + signatures", () => {
    expect(
      parseReleaseEnvelope({
        signed: {},
        signatures: [{ keyid: "b07b4192b7ed05c8", sig: "eA==" }],
      }),
    ).not.toBeNull();
  });
  it("refuses an envelope without signatures or with a malformed key id", () => {
    expect(parseReleaseEnvelope({ signed: {}, signatures: [] })).toBeNull();
    expect(
      parseReleaseEnvelope({ signed: {}, signatures: [{ keyid: "x", sig: "eA==" }] }),
    ).toBeNull();
    expect(
      parseReleaseEnvelope({ signatures: [{ keyid: "b07b4192b7ed05c8", sig: "eA==" }] }),
    ).toBeNull();
    expect(parseReleaseEnvelope([])).toBeNull();
  });
});

describe("semantic versions", () => {
  it("orders releases, prereleases and numeric parts", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-1")).toBe(1);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0+build.5", "1.0.0")).toBe(0);
    expect(compareVersions("latest", "1.0.0")).toBeNull();
  });

  it("never calls a downgrade or a guess newer", () => {
    expect(isNewerVersion("1.0.1", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(isNewerVersion("0.0.11", "0.3.2")).toBe(false);
    expect(isNewerVersion("garbage", "1.0.0")).toBe(false);
    expect(isNewerVersion(null, "1.0.0")).toBe(false);
  });
});

describe("assessing an installed component", () => {
  const m = parsed();

  it("reports an update on the install's own channel", () => {
    expect(
      assessComponent(m, {
        component: "cli",
        distribution: "npm",
        track: "latest",
        installedVersion: "1.0.0",
      }),
    ).toMatchObject({
      status: "update_available",
      latest: { version: "1.0.1" },
      restart: "new-session",
    });
  });

  it("is up to date when the install's channel has not published the newer release", () => {
    // npm has 1.0.1, Homebrew only verified 1.0.0: a Homebrew install has nothing to install yet.
    expect(
      assessComponent(m, {
        component: "cli",
        distribution: "homebrew",
        track: "latest",
        installedVersion: "1.0.0",
      }),
    ).toMatchObject({ status: "up_to_date" });
  });

  it("does not offer Open VSX users a release only the VS Code Marketplace verified", () => {
    expect(
      assessComponent(m, {
        component: "vscode",
        distribution: "open-vsx",
        track: "latest",
        installedVersion: "0.8.0",
      }).status,
    ).toBe("up_to_date");
    expect(
      assessComponent(m, {
        component: "vscode",
        distribution: "vscode-marketplace",
        track: "latest",
        installedVersion: "0.8.0",
      }).status,
    ).toBe("update_available");
  });

  it("requires an update below the minimum when the channel can deliver one", () => {
    expect(
      assessComponent(m, {
        component: "cli",
        distribution: "npm",
        track: "latest",
        installedVersion: "0.9.0",
      }),
    ).toMatchObject({
      status: "update_required",
      compatibility: { ok: false, reason: "below_minimum" },
    });
  });

  it("stays quiet when ahead, unknown on a track the channel does not publish", () => {
    expect(
      assessComponent(m, {
        component: "cli",
        distribution: "npm",
        track: "latest",
        installedVersion: "1.1.0",
      }).status,
    ).toBe("ahead");
    expect(
      assessComponent(m, {
        component: "cli",
        distribution: "npm",
        track: "stable",
        installedVersion: "1.0.0",
      }).status,
    ).toBe("unknown");
    expect(
      assessComponent(m, {
        component: "codex-plugin",
        distribution: "codex-marketplace",
        track: "latest",
        installedVersion: "1.0.0",
      }).status,
    ).toBe("unknown");
  });
});

describe("service contracts", () => {
  const m = parsed();

  it("asks nothing of a client whose contracts the service still accepts", () => {
    expect(assessServiceContracts(m, "cloud", PATHRULE_CONTRACTS)).toEqual({ ok: true });
    expect(assessServiceContracts(m, "remote-mcp", PATHRULE_CONTRACTS)).toEqual({ ok: true });
  });

  it("names the outdated side", () => {
    expect(assessServiceContracts(m, "cloud", { cloud_api: 0 })).toMatchObject({
      ok: false,
      reason: "client_outdated",
      contract: "cloud_api",
    });
    expect(assessServiceContracts(m, "cloud", { cloud_api: 3 })).toMatchObject({
      ok: false,
      reason: "service_outdated",
    });
  });
});
