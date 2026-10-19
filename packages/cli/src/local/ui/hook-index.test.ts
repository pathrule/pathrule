// SPDX-License-Identifier: Apache-2.0
// The hook index refresh after a console write: at once after a quiet period, folded into one
// trailing refresh within the debounce window, never two at a time for a workspace, reported
// honestly, and flushed before the console stops.
import { describe, expect, it } from "vitest";

import { HookIndexRefresher, type HookIndexTarget } from "./hook-index.js";

const A: HookIndexTarget = { id: "ws-a", rootPath: "/repo/a" };
const B: HookIndexTarget = { id: "ws-b", rootPath: "/repo/b" };

function recorder(answer: (target: HookIndexTarget) => Promise<boolean> = async () => true) {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const sync = async (target: HookIndexTarget) => {
    calls.push(target.id);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await answer(target);
    } finally {
      inFlight -= 1;
    }
  };
  return { calls, sync, maxInFlight: () => maxInFlight };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("HookIndexRefresher", () => {
  it("refreshes at once after a quiet period, per workspace", async () => {
    const { calls, sync } = recorder();
    const refresher = new HookIndexRefresher({ sync, debounceMs: 60 });
    expect(await refresher.refresh(A)).toBe("synced");
    expect(await refresher.refresh(B)).toBe("synced");
    expect(calls).toEqual(["ws-a", "ws-b"]);
  });

  it("folds writes within the window into one trailing refresh", async () => {
    const { calls, sync } = recorder();
    const refresher = new HookIndexRefresher({ sync, debounceMs: 60 });
    expect(await refresher.refresh(A)).toBe("synced");
    expect(await refresher.refresh(A)).toBe("scheduled");
    expect(await refresher.refresh(A)).toBe("scheduled");
    expect(calls).toEqual(["ws-a"]);
    await sleep(150);
    expect(calls).toEqual(["ws-a", "ws-a"]);
    // Quiet again: the next write refreshes at once.
    expect(await refresher.refresh(A)).toBe("synced");
    expect(calls).toHaveLength(3);
  });

  it("never runs two refreshes of a workspace at a time, and runs one after a slow one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const { calls, sync, maxInFlight } = recorder(async () => {
      if (first) {
        first = false;
        await gate;
      }
      return true;
    });
    const refresher = new HookIndexRefresher({ sync, debounceMs: 10 });
    const slow = refresher.refresh(A);
    await sleep(30);
    // The slow refresh may have read the store before this write: another one follows it.
    expect(await refresher.refresh(A)).toBe("scheduled");
    await sleep(30);
    expect(calls).toEqual(["ws-a"]);
    release();
    expect(await slow).toBe("synced");
    await refresher.flush();
    expect(calls).toEqual(["ws-a", "ws-a"]);
    expect(maxInFlight()).toBe(1);
  });

  it("says when a refresh failed, thrown or reported", async () => {
    const lines: string[] = [];
    const reported = new HookIndexRefresher({
      sync: async () => false,
      log: (line) => lines.push(line),
    });
    expect(await reported.refresh(A)).toBe("failed");
    const thrown = new HookIndexRefresher({
      sync: async () => {
        throw new Error("disk full");
      },
      log: (line) => lines.push(line),
    });
    expect(await thrown.refresh(A)).toBe("failed");
    expect(lines.join("\n")).toContain("disk full");
  });

  it("runs the pending refreshes when flushed, and none after it closed", async () => {
    const { calls, sync } = recorder();
    const refresher = new HookIndexRefresher({ sync, debounceMs: 60_000 });
    await refresher.refresh(A);
    expect(await refresher.refresh(A)).toBe("scheduled");
    await refresher.close();
    expect(calls).toEqual(["ws-a", "ws-a"]);
    expect(await refresher.refresh(A)).toBe("failed");
    expect(calls).toHaveLength(2);
  });
});
