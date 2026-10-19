// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertSupportBundleHasNoSecrets,
  redactSupportBundleValue,
  sanitizeBridgeSupportState,
} from "./support-bundle.js";

describe("support bundle redaction", () => {
  it("redacts tokens, env values, local paths, file contents, and emails", () => {
    const redacted = redactSupportBundleValue({
      access_token: "secret-access-token",
      env: { SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" },
      local_path: "/Users/sertan/private/repo",
      error: "failed for ada@example.com with Bearer abcdefghijklmnopqrstuvwxyz123456",
      file_content: "actual local file body",
      nested: {
        config_path: "C:\\Users\\sertan\\AppData\\Pathrule\\config.json",
      },
    });

    expect(redacted).toMatchObject({
      access_token: "[redacted]",
      env: "[redacted]",
      local_path: "[redacted-path]",
      file_content: "[redacted]",
      nested: {
        config_path: "[redacted-path]",
      },
    });
    expect(JSON.stringify(redacted)).not.toContain("ada@example.com");
    expect(JSON.stringify(redacted)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(() => assertSupportBundleHasNoSecrets(redacted)).not.toThrow();
  });

  it("exports bridge state without pair tokens or daemon session identifiers", () => {
    const state = sanitizeBridgeSupportState({
      paired: true,
      pair_token: "pair-token-secret",
      daemon_session_id: "daemon-session-secret",
      last_error: "bridge_pair_failed",
    });

    expect(state).toEqual({
      paired: true,
      pair_token: "[redacted]",
      daemon_session_id: "[redacted]",
      last_error: "bridge_pair_failed",
    });
  });
});
