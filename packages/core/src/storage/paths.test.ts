// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  hashUserIdForPath,
  localRuntimePaths,
  userRuntimePaths,
  workspaceRuntimePaths,
} from "./paths.js";

describe("local runtime paths", () => {
  it("uses a stable hashed user id path segment", () => {
    const first = hashUserIdForPath("00000000-0000-4000-8000-000000000001");
    const second = hashUserIdForPath("00000000-0000-4000-8000-000000000001");

    expect(first).toBe(second);
    expect(first).toHaveLength(32);
    expect(first).not.toContain("00000000-0000-4000-8000-000000000001");
  });

  it("honors PATHRULE_HOME for tests and portable installs", () => {
    const paths = localRuntimePaths({ PATHRULE_HOME: "/tmp/pathrule-test" });
    expect(paths).toEqual({
      home: "/tmp/pathrule-test",
      activeUserFile: "/tmp/pathrule-test/active-user",
      credentialsFile: "/tmp/pathrule-test/credentials.json",
      accountOwnersFile: "/tmp/pathrule-test/account-owners.json",
      tokenLockFile: "/tmp/pathrule-test/.token-lock",
      embeddingSettingsFile: "/tmp/pathrule-test/embedding.json",
      embeddingCredentialsFile: "/tmp/pathrule-test/embedding-credentials.json",
      embeddingLockFile: "/tmp/pathrule-test/.embedding-lock",
      logsDir: "/tmp/pathrule-test/logs",
      supportDir: "/tmp/pathrule-test/support",
    });
  });

  it("namespaces user cache by security epoch", () => {
    const paths = userRuntimePaths("user-1", 42, { PATHRULE_HOME: "/tmp/pathrule-test" });
    expect(paths.userConfigFile).toMatch(
      /^\/tmp\/pathrule-test\/config\/users\/[a-f0-9]{32}\/config\.json$/,
    );
    expect(paths.epochCacheDir).toMatch(
      /^\/tmp\/pathrule-test\/cache\/users\/[a-f0-9]{32}\/epoch-42$/,
    );
  });

  it("places workspace cache below the epoch namespace", () => {
    const paths = workspaceRuntimePaths("user-1", "workspace-1", 7, {
      PATHRULE_HOME: "/tmp/pathrule-test",
    });

    expect(paths.workspaceCacheDir).toMatch(/\/epoch-7\/workspace-1$/);
  });
});
