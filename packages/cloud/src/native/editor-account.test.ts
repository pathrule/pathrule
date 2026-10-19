// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeNativeSession } from "./credentials.js";
import { editorBindingFailure } from "./editor-account.js";
import { attachNativeWorkspace } from "./workspaces.js";

const BASE = "https://cloud.example.test";
let home: string;
let env: NodeJS.ProcessEnv;
let repo: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "editor-failure-")));
  repo = join(home, "repo");
  env = { PATHRULE_HOME: home, PATHRULE_NATIVE_CLOUD_URL: BASE };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function signedInAndAttached() {
  await writeNativeSession(
    { base_url: BASE, user_id: "person-a", token: "t".repeat(40), expires_at: new Date(Date.now() + 7 * 864e5).toISOString() },
    { env },
  );
  await attachNativeWorkspace("person-a", { workspace_id: "ws-1", organization_id: "org-1", name: "Shop", root: repo }, env);
}
const answer = (status: number, body: unknown = {}) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("why a Cloud folder's workspace did not open", () => {
  it("signed out: no session on this machine", async () => {
    expect(await editorBindingFailure(repo, env, { fetch: answer(200) })).toBe("signed-out");
  });

  it("not attached for the person signed in", async () => {
    await signedInAndAttached();
    expect(await editorBindingFailure(join(home, "elsewhere"), env, { fetch: answer(200) })).toBe("not-attached");
  });

  it("tells offline, an expired session, no access and a Cloud failure apart", async () => {
    await signedInAndAttached();
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await editorBindingFailure(repo, env, { fetch: offline })).toBe("offline");
    expect(await editorBindingFailure(repo, env, { fetch: answer(401) })).toBe("signed-out");
    expect(await editorBindingFailure(repo, env, { fetch: answer(403) })).toBe("access-denied");
    expect(await editorBindingFailure(repo, env, { fetch: answer(404) })).toBe("access-denied");
    expect(await editorBindingFailure(repo, env, { fetch: answer(200, { id: "ws-1", archived_at: 1 }) })).toBe("access-denied");
    expect(await editorBindingFailure(repo, env, { fetch: answer(503) })).toBe("cloud-error");
    expect(await editorBindingFailure(repo, env, { fetch: answer(200, { id: "ws-1" }) })).toBe("cloud-error");
  });

  it("a Cloud that does not answer in time is offline", async () => {
    await signedInAndAttached();
    const hang = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    expect(await editorBindingFailure(repo, env, { fetch: hang, timeoutMs: 20 })).toBe("offline");
  });

  it("sends the token only to the session's own origin, for the attached workspace", async () => {
    await signedInAndAttached();
    const seen: string[] = [];
    const record = (async (url: URL | string, init?: { headers?: Record<string, string> }) => {
      seen.push(`${String(url)} ${init?.headers?.authorization?.slice(0, 7)}`);
      return new Response("{}", { status: 503 });
    }) as unknown as typeof fetch;
    await editorBindingFailure(repo, env, { fetch: record });
    expect(seen).toEqual([`${BASE}/v1/workspaces/ws-1 Bearer `]);
  });
});
