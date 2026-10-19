// SPDX-License-Identifier: Apache-2.0
// The agents' hook index after a Local Console write.
//
// A write through the host's store does not touch `<Pathrule home>/cache/<workspace>/hook-index.json`,
// the file the Pathrule hook reads on every prompt and tool call. The local MCP server leaves it to
// its next `get_context`, which rewrites it from the store; a person editing in the console has no
// such call coming, so the console rewrites it itself, the same way local `get_context` does: from
// the host's store, with the protocol channel resolved for the workspace's folder (so a workspace in
// signature mode keeps its protocol on the index), and without the person's preference, guidance or
// profile entries, which the writer then carries over from the index on disk. Nothing is written
// into the person's repository: the companion files are `pathrule sync`'s.
//
// Per workspace, a write that comes after a quiet period refreshes at once and answers "synced" (or
// "failed"); writes within 500 ms of the last refresh are folded into one trailing refresh and answer
// "scheduled".
import type { HostSession } from "@pathrule/host/session.js";
import { HOOK_CAPABLE_CLIENTS } from "@pathrule/integrations/client-renderers/protocol-channel.js";
import { resolveWorkspaceProtocolChannel } from "@pathrule/integrations/client-renderers/protocol-channel-fs.js";
import { syncHookIndex } from "@pathrule/integrations/index-writers/hook-index-writer.js";

export const HOOK_INDEX_DEBOUNCE_MS = 500;

export type HookIndexOutcome = "synced" | "scheduled" | "failed";

export interface HookIndexTarget {
  id: string;
  /** The folder the workspace is bound to: the index's `workspace_root`. */
  rootPath: string;
}

/** Rewrites one workspace's hook index; true when it was written. */
export type HookIndexSync = (target: HookIndexTarget) => Promise<boolean>;

interface Entry {
  target: HookIndexTarget;
  lastStartedAt: number;
  running: Promise<boolean> | null;
  timer: NodeJS.Timeout | null;
  /** A trailing refresh whose window has passed, waiting for the one in flight. */
  trailing: Promise<boolean> | null;
}

export interface HookIndexRefresherOptions {
  sync: HookIndexSync;
  debounceMs?: number;
  now?: () => number;
  log?(line: string): void;
}

export class HookIndexRefresher {
  private readonly entries = new Map<string, Entry>();
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private closed = false;

  constructor(private readonly options: HookIndexRefresherOptions) {
    this.debounceMs = options.debounceMs ?? HOOK_INDEX_DEBOUNCE_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /** After a write to `target`'s store. */
  async refresh(target: HookIndexTarget): Promise<HookIndexOutcome> {
    let entry = this.entries.get(target.id);
    if (!entry) {
      entry = {
        target,
        lastStartedAt: Number.NEGATIVE_INFINITY,
        running: null,
        timer: null,
        trailing: null,
      };
      this.entries.set(target.id, entry);
    }
    entry.target = target;
    if (this.closed) return "failed";
    const quiet = this.now() - entry.lastStartedAt >= this.debounceMs;
    if (quiet && !entry.running && !entry.timer && !entry.trailing) {
      return (await this.run(entry)) ? "synced" : "failed";
    }
    this.trail(entry);
    return "scheduled";
  }

  /** Runs every pending refresh now and waits for all of them. */
  async flush(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
        this.startTrailing(entry);
      }
      pending.push(entry.trailing ?? entry.running ?? Promise.resolve(true));
    }
    await Promise.allSettled(pending);
  }

  /** Flushes, then takes no more refreshes. */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  /** One trailing refresh, after the debounce window, covering every write until it starts. */
  private trail(entry: Entry): void {
    // A trailing refresh that has not started yet covers this write too.
    if (entry.timer || entry.trailing) return;
    const wait = Math.max(0, entry.lastStartedAt + this.debounceMs - this.now());
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.startTrailing(entry);
    }, wait);
    entry.timer.unref?.();
  }

  private startTrailing(entry: Entry): void {
    if (entry.trailing) return;
    // A refresh in flight may have read the store before the write that asked for this one.
    const trailing: Promise<boolean> = Promise.resolve(entry.running).then(() => {
      // From here on a new write needs a refresh of its own.
      if (entry.trailing === trailing) entry.trailing = null;
      return this.run(entry);
    });
    entry.trailing = trailing;
  }

  private run(entry: Entry): Promise<boolean> {
    entry.lastStartedAt = this.now();
    const target = entry.target;
    const running = this.options.sync(target).then(
      (ok) => {
        if (!ok) this.log(`hook index refresh failed for ${target.id}`);
        return ok;
      },
      (err: unknown) => {
        this.log(
          `hook index refresh threw for ${target.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      },
    );
    entry.running = running;
    void running.finally(() => {
      if (entry.running === running) entry.running = null;
    });
    return running;
  }
}

/** The production refresh: the host's store, the workspace's protocol channel, the index writer. */
export function hostHookIndexSync(
  session: HostSession,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void = () => {},
): HookIndexSync {
  return async ({ id, rootPath }) => {
    const store = await session.store(id);
    const channel = await resolveWorkspaceProtocolChannel({
      workspaceRoot: rootPath,
      enabled: HOOK_CAPABLE_CLIENTS,
      env,
    }).catch(() => ({ protocol: undefined }));
    const result = await syncHookIndex({
      backend: store,
      workspaceId: id,
      workspaceRoot: rootPath,
      env,
      protocol: channel.protocol,
    });
    if (!result.ok) log(`hook index for ${id}: ${result.error ?? "no payload returned"}`);
    return result.ok;
  };
}
