// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";

const cloudCalls = vi.hoisted(() => ({
  loginNativeDevice: vi.fn(),
  readNativeSession: vi.fn(),
  signOutNative: vi.fn(),
}));

vi.mock("@pathrule/cloud/native/credentials.js", async (original) => ({
  ...(await original<object>()),
  loginNativeDevice: cloudCalls.loginNativeDevice,
  readNativeSession: cloudCalls.readNativeSession,
  signOutNative: cloudCalls.signOutNative,
}));

const { cloudCapabilities, vscodeCloud } = await import("./cloud.js");

beforeEach(() => {
  for (const call of Object.values(cloudCalls)) call.mockReset();
});

describe("the extension's capabilities", () => {
  it("compose Pathrule Cloud, as the CLI it carries does, and the account", () => {
    const capabilities = cloudCapabilities();
    expect(capabilities.cliPlugins.map((plugin) => plugin.name)).toEqual(["cloud"]);
    expect(capabilities.cloud).toBe(vscodeCloud);
  });
});

describe("the extension where no Pathrule Cloud is named", () => {
  // A source build with no Cloud baked in, and a run that names none.
  const env = { HOME: "/home/test", PATHRULE_HOME: "/home/test/.pathrule" } as NodeJS.ProcessEnv;

  it("is not available, and has no session, no binding and nothing to adopt", async () => {
    expect(vscodeCloud.available(env)).toBe(false);
    await expect(vscodeCloud.hasSession(env)).resolves.toBe(false);
    await expect(vscodeCloud.resolveBinding("/repo", env)).resolves.toBeNull();
    await expect(vscodeCloud.adoptableAccount(env)).resolves.toBeNull();
    expect(cloudCalls.readNativeSession).not.toHaveBeenCalled();
  });

  it("says so instead of signing in or reading the account", async () => {
    await expect(vscodeCloud.signIn({ env, onPending: () => {} })).rejects.toThrow(
      /names no Pathrule Cloud/,
    );
    await expect(vscodeCloud.setupPlan("/repo", env)).rejects.toThrow(/names no Pathrule Cloud/);
    expect(cloudCalls.loginNativeDevice).not.toHaveBeenCalled();
  });
});

describe("the extension on Pathrule Cloud", () => {
  const native = {
    HOME: "/home/test",
    // The native session file lives under PATHRULE_HOME: name one that holds no session, so the
    // machine running the tests (which may be signed in to Pathrule Cloud) never leaks into them.
    PATHRULE_HOME: "/home/test/.pathrule",
    PATHRULE_NATIVE_CLOUD_URL: "https://cloud.example.test",
    PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-cli-test",
  } as NodeJS.ProcessEnv;

  it("signs in with Pathrule Cloud's device flow and shows the approval page", async () => {
    cloudCalls.loginNativeDevice.mockImplementation(async (input) => {
      await input.onCode({
        user_code: "WXYZ2345",
        verification_uri: "https://cloud.example.test/device",
        verification_uri_complete: "https://cloud.example.test/device?user_code=WXYZ2345",
      });
      return { userId: "user-1", expiresAt: "2099-01-01T00:00:00.000Z", replaced: null };
    });
    cloudCalls.readNativeSession.mockResolvedValue(null);
    const pending: unknown[] = [];
    const who = await vscodeCloud.signIn({ env: native, onPending: (p) => void pending.push(p) });
    expect(who).toBe("user-1");
    expect(pending).toEqual([
      {
        userCode: "WXYZ2345",
        verificationUri: "https://cloud.example.test/device?user_code=WXYZ2345",
      },
    ]);
    expect(cloudCalls.loginNativeDevice.mock.calls[0]![0]).toMatchObject({
      baseUrl: "https://cloud.example.test",
      clientId: "pathrule-cli-test",
    });
  });

  it("reads and ends the shared native session, and offers no other session to adopt", async () => {
    cloudCalls.readNativeSession.mockResolvedValue({ user_id: "user-1" });
    expect(vscodeCloud.available(native)).toBe(true);
    expect(await vscodeCloud.hasSession(native)).toBe(true);
    expect(await vscodeCloud.adoptableAccount(native)).toBeNull();
    await vscodeCloud.signOut(native);
    expect(cloudCalls.signOutNative).toHaveBeenCalledTimes(1);
    // Bindings and setup go to Pathrule Cloud (native/editor-account.ts, tested against the Worker
    // in the Cloud service): here the session has no token to send.
    expect(await vscodeCloud.resolveBinding("/repo", native)).toBeNull();
    await expect(vscodeCloud.setupPlan("/repo", native)).rejects.toThrow(
      /Not signed in to Pathrule Cloud/,
    );
  });
});
