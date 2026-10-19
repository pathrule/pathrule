// SPDX-License-Identifier: Apache-2.0
// Two sections of a get_context answer that read state beside the context bundle: the
// preloaded memory body, returned by reference when the hook already delivered it in this
// session, and the runtime indicator line. Kept out of get-context.ts (a tracked hotspot);
// the statements and comments are the tool's own, moved with the workspace and backend as
// parameters.

import type { KnowledgeBackend } from "@pathrule/core";
import { runtimeIndicatorLine } from "@pathrule/core/tools/runtime-events.js";
import {
  alreadyDelivered,
  deliverySession,
  recordMcpDeliveries,
  type McpDelivery,
} from "../lib/delivery.js";
import { capPreview } from "../lib/preview-cap.js";

const PRELOADED_MEMORY_BODY_MAX_CHARS = 700;

export interface PreloadedMemory {
  id: string;
  title: string;
  content: string;
}

/** The bodies of the memories the router preloads; undefined when none is loaded. */
export async function loadPreloadedMemories(
  backend: KnowledgeBackend,
  workspaceId: string,
  preloadIds: string[],
  args: { session_id?: string; include_delivered?: boolean },
): Promise<PreloadedMemory[] | undefined> {
  if (preloadIds.length === 0) return undefined;
  // Through the backend seam (readMemory per id). preloadIds is capped at 1 (see resolveInlineIds),
  // so this is a single fetch — behavior-neutral, backend-agnostic.
  const loaded = (await Promise.all(preloadIds.map((id) => backend.readMemory(id)))).filter(
    (m): m is NonNullable<typeof m> => m !== null,
  );
  if (loaded.length === 0) return undefined;
  // A body the hook already delivered in this session (same version, current epoch) is
  // returned as a reference, unless the caller asks for it again. Anything sent is recorded.
  const session = await deliverySession(workspaceId, args.session_id);
  const sent: McpDelivery[] = [];
  const extraPreloadedMemories: PreloadedMemory[] = [];
  for (const m of loaded) {
    const delivered =
      !args.include_delivered && session
        ? await alreadyDelivered(workspaceId, session, "memory", m.id, m.content).catch(() => false)
        : false;
    if (delivered) {
      extraPreloadedMemories.push({
        id: m.id,
        title: m.title,
        content:
          "(Already delivered in this session; its body is above. Pass include_delivered: true to get it again.)",
      });
      continue;
    }
    extraPreloadedMemories.push({
      id: m.id,
      title: m.title,
      content: capPreview(m.content, PRELOADED_MEMORY_BODY_MAX_CHARS),
    });
    if (m.content.length <= PRELOADED_MEMORY_BODY_MAX_CHARS) {
      sent.push({ kind: "memory", id: m.id, content: m.content });
    }
  }
  void recordMcpDeliveries({
    workspaceId,
    session,
    event: "pathrule_get_context",
    items: sent,
    repeat: args.include_delivered === true,
  });
  return extraPreloadedMemories;
}

/**
 * The application's runtime issues under this path, as counts only (never what it sent). A
 * backend that keeps runtime events locally answers it; Cloud's would cost a request, so it
 * is not asked here.
 */
export async function loadRuntimeLine(
  backend: KnowledgeBackend,
  workspaceId: string,
  path: string,
): Promise<string | null> {
  let runtimeLine: string | null = null;
  try {
    if (backend.runtimeEventIndicator) {
      runtimeLine = runtimeIndicatorLine(await backend.runtimeEventIndicator(workspaceId, path));
    }
  } catch {
    // An indicator never fails get_context.
  }
  return runtimeLine;
}
