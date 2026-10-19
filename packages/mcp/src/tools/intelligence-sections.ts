// SPDX-License-Identifier: Apache-2.0
// The section of pathrule_get_context that is not a knowledge item: the signed-in person's team and
// personal profiles (Team Intelligence: the account provider's ranking, the account's render).
//
// One channel per session, so nothing arrives twice: a client whose Pathrule hook is installed gets
// the profiles at the session start (all four hook clients), and get_context leaves out exactly the
// entries the hook index carries for this person, so an entry this request ranks in that the session
// start did not carry still arrives. A section the caller already holds (`known_item_versions`, or sent
// earlier with the same `session_id`) is not sent again.
//
// The person is the one an account binds to this workspace when one does (`person`): the profiles are
// theirs, and the hook's entries are looked up under their id. Otherwise the no-account person's local
// file and the edition's profiles.

import { openPersonalIndexEntries } from "@pathrule/core/user-knowledge/user-knowledge-capture.js";
import { localRuntimePaths } from "@pathrule/core/storage/paths.js";
import { join } from "node:path";
import type { UserKnowledgeStore } from "@pathrule/core/user-knowledge/user-knowledge-persistence.js";
import { userKnowledgeStoreFor } from "@pathrule/core/user-knowledge/user-knowledge-store.js";
import type { AgentTargetId } from "@pathrule/core/skills/agent-targets.js";
import type { ToolContext } from "@pathrule/core/tools/types.js";
import { HOOK_CAPABLE_CLIENTS } from "@pathrule/integrations/client-renderers/protocol-channel.js";
import {
  hookDeliveredProfileIds,
  hookIndexProfiles,
} from "@pathrule/integrations/index-writers/hook-index-writer.js";
import { detectInstalledHooks } from "@pathrule/integrations/skills/disk-detection.js";
import { HOOK_PROFILE_BLOCK_MAX_CHARS } from "@pathrule/protocol/intelligence-delivery.js";

import type { McpPersonalAccount } from "../plugin.js";

/** A coding agent's session is the "chat" surface; a task run would say "tasks". */
const MCP_SURFACE = "chat";
const MAX_REMEMBERED_SESSIONS = 256;

export interface IntelligenceSectionsInput {
  ctx: ToolContext;
  /** The person an account binds to this workspace; absent or null binds nobody. */
  person?: McpPersonalAccount | null;
  workspaceId: string;
  /** The checkout the workspace is bound to; null when unknown. */
  localRootPath: string | null;
  /** The agent's working folder. */
  cwd: string;
  /** The workspace path the call resolved to (`resolved_workspace_path`). */
  path: string | null;
  userIntent: string;
  knownItemVersions?: readonly string[];
  /** The agent's or hook's session id, when the caller passes one. */
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seams. */
  installedHooks?: (workspaceRoot: string) => Promise<AgentTargetId[]>;
}

export interface IntelligenceSections {
  /** The person's team and personal profiles, ranked for this request. */
  intelligence_profiles?: string;
  /** The versions of the sections in this response, to pass back as `known_item_versions`. */
  item_versions?: string[];
}

// Versions already sent per (workspace, session); insertion order is the eviction order.
const sentInSession = new Map<string, Set<string>>();

/** Test seam. */
export function clearIntelligenceSectionMemory(): void {
  sentInSession.clear();
}

/**
 * What the hook index carries about the person for a session without a request, from the calls the
 * request path above makes: their preference lines (empty when nothing was learned), compiled by the
 * open compiler, and their team and personal profiles, bounded for the session start
 * (omitted without an account, which keeps what the index carries). The bound person's when an
 * account binds one, so the index is stamped with the owner the hook recognises.
 */
export async function hookIndexPersonEntries(input: {
  ctx: ToolContext;
  person: McpPersonalAccount | null;
  workspaceId: string;
  localRootPath: string | null;
  env?: NodeJS.ProcessEnv;
}) {
  const env = input.env ?? process.env;
  const bound = input.person ? await input.person.bind(input.workspaceId).catch(() => null) : null;
  const personal = bound ? { userId: bound.userId, userKnowledge: bound.userKnowledge } : {};
  const sessionStart = {
    userIntent: "",
    surface: MCP_SURFACE,
    maxChars: HOOK_PROFILE_BLOCK_MAX_CHARS,
  } as const;
  // Handled from the start: it runs while the person's entries compile.
  const delivery = bound?.intelligenceProfiles(sessionStart).catch(() => null);
  // The person's stored beliefs, through the open compiler (user-knowledge-capture.ts). A failure
  // compiles nothing: the writer keeps what the index carries.
  const entries = await openPersonalEntries(
    userKnowledgeStoreFor({ env, ...personal }),
    input.workspaceId,
    input.localRootPath,
    env,
  ).catch(() => undefined);
  return {
    // Stamped with the person they were compiled for: the hook withholds a bound account's entries
    // once it signs out.
    personal: entries ? { ...entries, personalOwner: bound?.userId ?? null } : {},
    intelligenceProfiles: delivery ? hookIndexProfiles(await delivery) : undefined,
  };
}

/** No engine: promote what the person said again in another session, then compile their active beliefs. */
async function openPersonalEntries(store: UserKnowledgeStore, workspaceId: string, root: string | null, env: NodeJS.ProcessEnv) {
  return openPersonalIndexEntries(store, join(localRuntimePaths(env).home, "cache", workspaceId), workspaceId, [root]);
}

async function hookServes(input: IntelligenceSectionsInput, clientId: AgentTargetId | null) {
  if (!clientId || !input.localRootPath || !HOOK_CAPABLE_CLIENTS.includes(clientId)) return false;
  const installed = await (input.installedHooks ?? detectInstalledHooks)(input.localRootPath).catch(
    () => [] as AgentTargetId[],
  );
  return installed.includes(clientId);
}

export async function intelligenceSections(
  input: IntelligenceSectionsInput,
): Promise<IntelligenceSections> {
  const env = input.env ?? process.env;
  const clientId = input.ctx.clientId ?? null;
  const [hooked, person] = await Promise.all([
    hookServes(input, clientId),
    input.person ? input.person.bind(input.workspaceId).catch(() => null) : Promise.resolve(null),
  ]);
  const deliver = person ? person.intelligenceProfiles : null;

  const profiles = await (async () => {
    if (!deliver) return null;
    const exclude = hooked
      ? await hookDeliveredProfileIds(env, input.workspaceId, person?.userId ?? input.ctx.userId)
      : [];
    return deliver({ userIntent: input.userIntent, surface: MCP_SURFACE, exclude }).catch(
      () => null,
    );
  })();

  const memoryKey = input.sessionId ? `${input.workspaceId}\u0000${input.sessionId}` : null;
  const sent = memoryKey ? sentInSession.get(memoryKey) : undefined;
  const known = new Set([...(input.knownItemVersions ?? []), ...(sent ?? [])]);
  const out: IntelligenceSections = {};
  const versions: string[] = [];

  if (profiles?.block && !known.has(profiles.version)) {
    out.intelligence_profiles = profiles.block;
    versions.push(profiles.version);
  }
  if (versions.length === 0) return out;
  out.item_versions = versions;

  if (memoryKey) {
    const next = new Set([...(sent ?? []), ...versions]);
    sentInSession.delete(memoryKey);
    sentInSession.set(memoryKey, next);
    while (sentInSession.size > MAX_REMEMBERED_SESSIONS) {
      const oldest = sentInSession.keys().next().value;
      if (oldest === undefined) break;
      sentInSession.delete(oldest);
    }
  }
  return out;
}
