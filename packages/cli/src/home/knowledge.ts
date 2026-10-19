// SPDX-License-Identifier: Apache-2.0
// What the knowledge browser reads: every node of the local workspace with the memories, rules and
// skills attached to it (the workspace overview), and one item's body when the person opens it. All
// through the Pathrule host, the stores' one owner; nothing here writes.
//
// Opening the browser is the person's action, so it may start the host, as `pathrule memory list`
// does. Cloud knowledge is not read here: a Cloud workspace opens in Pathrule Web.
import type { HostSession } from "@pathrule/host/session.js";

import { cliHostSession } from "../local/host-session.js";
import { sanitize } from "./explain.js";
import { displayPath, reasonOf, STORE_TIMEOUT_MS, withTimeout } from "./snapshot.js";

export type KnowledgeKind = "memory" | "rule" | "skill";

export interface KnowledgeEntry {
  kind: KnowledgeKind;
  id: string;
  title: string;
  /** The node the item is attached to, as the home shows paths ("/" for the root). */
  path: string;
  /** A rule's priority. */
  priority?: string;
}

export interface KnowledgeItem {
  entry: KnowledgeEntry;
  /** The stored body, as written: the screen makes it safe to print. */
  body: string;
  updatedAt: string | null;
}

export interface KnowledgeReader {
  entries: KnowledgeEntry[];
  read(entry: KnowledgeEntry): Promise<KnowledgeItem | null>;
  close(): Promise<void>;
}

export interface KnowledgeReaderInput {
  env: NodeJS.ProcessEnv;
  session?: HostSession;
}

/** Opens the workspace's knowledge for reading, or throws with a reason safe to show. */
export async function openKnowledgeReader(
  input: KnowledgeReaderInput,
  workspaceId: string,
): Promise<KnowledgeReader> {
  const session = input.session ?? cliHostSession(input.env);
  const owned = !input.session;
  const close = async () => {
    if (owned) await session.close().catch(() => {});
  };
  try {
    const store = await withTimeout(
      session.store(workspaceId),
      STORE_TIMEOUT_MS,
      `The Pathrule host did not answer within ${STORE_TIMEOUT_MS / 1000} s.`,
    );
    const overview = await withTimeout(
      store.workspaceOverview(workspaceId),
      STORE_TIMEOUT_MS,
      `The Pathrule host did not answer within ${STORE_TIMEOUT_MS / 1000} s.`,
    );
    const entries: KnowledgeEntry[] = [];
    for (const node of overview) {
      const path = displayPath(node.relative_path);
      for (const m of node.memories)
        entries.push({ kind: "memory", id: m.id, title: m.title, path });
      for (const r of node.rules) {
        entries.push({ kind: "rule", id: r.id, title: r.name, path, priority: r.priority });
      }
      for (const k of node.skills) entries.push({ kind: "skill", id: k.id, title: k.name, path });
    }
    return {
      entries,
      async read(entry) {
        const row =
          entry.kind === "memory"
            ? await store.readMemory(entry.id)
            : entry.kind === "rule"
              ? await store.readRule(entry.id)
              : await store.readSkill(entry.id);
        if (!row) return null;
        return { entry, body: row.content ?? "", updatedAt: row.updatedAt ?? null };
      },
      close,
    };
  } catch (err) {
    await close();
    throw new Error(sanitize(reasonOf(err), input.env));
  }
}
