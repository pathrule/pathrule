// SPDX-License-Identifier: Apache-2.0
// One line a person can act on, with the real cause and nothing secret.
import { describe, expect, it } from "vitest";

import { explainInstallFailure, sanitize } from "./explain.js";

const env = { HOME: "/Users/dev" } as NodeJS.ProcessEnv;

// The reasons the capability host reported in real runs on 2026-10-10.
const NOT_PUBLISHED =
  "npm: npm install @pathrule/example-capability@0.6.1 failed: npm error 404 | npm error 404  The requested resource '@pathrule/example-capability@0.6.1' could not be found or you do not have permission to access it. | npm error 404 | npm error A complete log of this run can be found in: /Users/dev/.npm/_logs/2026-10-09T23_24_38_423Z-debug-0.log";
const OFFLINE =
  "npm: npm install @pathrule/example-capability@0.6.1 failed: npm error   requiredBy: '.' | npm error } | npm error | npm error If you are behind a proxy, please make sure that the | npm error 'proxy' config is set properly.  See: 'npm help config' | npm error A complete log of this run can be found in: /Users/dev/.npm/_logs/x-debug-0.log";

describe("explaining a capability install failure", () => {
  it("names a package npm does not have, without claiming anything else", () => {
    expect(explainInstallFailure(NOT_PUBLISHED, env)).toBe(
      "@pathrule/example-capability@0.6.1 is not available from the npm registry (404).",
    );
  });

  it("says offline for a registry npm could not reach", () => {
    expect(explainInstallFailure(OFFLINE, env)).toBe(
      "npm could not reach its registry (offline, a proxy or a firewall).",
    );
    expect(explainInstallFailure("npm: connect ECONNREFUSED 127.0.0.1:9", env)).toMatch(/offline/);
  });

  it("names permission, a full disk, refused auth, and a Cloud install that was not tried", () => {
    expect(explainInstallFailure("npm: EACCES: permission denied, mkdir '/x'", env)).toMatch(
      /not allowed/,
    );
    expect(explainInstallFailure("npm: ENOSPC: no space left on device", env)).toBe(
      "the disk is full.",
    );
    expect(explainInstallFailure("npm: npm error code E401", env)).toMatch(/authentication/);
    expect(
      explainInstallFailure(
        "not tried: Pathrule Cloud also needs the host, which could not be prepared",
        env,
      ),
    ).toMatch(/^not tried/);
  });

  it("falls back to the first meaningful line of the real error, sanitised", () => {
    expect(
      explainInstallFailure(
        "verify: the plugin did not load: Cannot find module '/Users/dev/.pathrule/capabilities/x/index.js' | npm error A complete log of this run can be found in: /Users/dev/.npm/_logs/a.log",
        env,
      ),
    ).toBe(
      "verify: the plugin did not load: Cannot find module '~/.pathrule/capabilities/x/index.js'",
    );
  });
});

describe("sanitising a message for the terminal", () => {
  it("shows the home directory as ~ and removes credentials, tokens and escapes", () => {
    const text = sanitize(
      "\x1b[31mfailed\x1b[39m at /Users/dev/.pathrule for https://user:s3cret@registry.example.com/x with Bearer abcdefghijklmnop1234 and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U and ghp_ABCDEFGHIJKLMNOPQRSTUV123456",
      env,
    );
    expect(text).toBe(
      "failed at ~/.pathrule for https://***@registry.example.com/x with [redacted] and [redacted] and [redacted]",
    );
  });

  it("keeps one bounded line", () => {
    expect(sanitize("a\nb\n\nc", env)).toBe("a b c");
    expect(sanitize("x".repeat(500), env, 20)).toHaveLength(20);
  });
});
