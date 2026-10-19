// SPDX-License-Identifier: Apache-2.0
// The binding of one explicitly mapped workspace on the native Cloud: it reads the authenticated
// person from `/v1/me/identity`, checks the workspace (and its organization, when the mapping names
// one) and pins every later request to that person with `x-native-owner`. One binding serves one
// workspace and one owner. It never reads a local store, provisions a workspace or uploads anything.
import type { IntelligenceSurface } from "@pathrule/protocol/intelligence-delivery.js";

import { deliverIntelligenceProfiles } from "../../intelligence/profile-context.js";
import { createCloudFoundationAdapters } from "./foundation.js";
import { cloudHttp, type CloudTransport } from "./http.js";
import { createCloudIntelligenceProfileSource } from "./profile-source.js";
import { createCloudProjectHttpBackend } from "./project-backend.js";
import { createCloudSemanticClient, type CloudEmbeddingSpace } from "./semantic.js";
import { createCloudSignalsClient } from "./signals.js";
import { createCloudUserKnowledgeStore } from "./user-knowledge-store.js";

export interface CloudWorkspaceMapping {
  localWorkspaceId: string;
  cloudWorkspaceId: string;
  cloudOrganizationId?: string;
  localRootPath?: string;
  runtimeId?: string;
}

export interface NativeBindingInput {
  transport: CloudTransport | null;
  mapping: CloudWorkspaceMapping | null;
  /** The Host resolves its local edition before asking for an account binding. */
  localSelected?: boolean;
  embeddingSpace?: CloudEmbeddingSpace;
}

export async function resolveCloudNativeBinding(input: NativeBindingInput) {
  if (input.localSelected || !input.transport || !input.mapping) return null;
  const { transport } = input,
    mapping = Object.freeze({ ...input.mapping });
  if (!mapping.localWorkspaceId || !/^[a-zA-Z0-9_-]{1,64}$/.test(mapping.cloudWorkspaceId))
    throw new Error("Explicit workspace mapping required");
  const request = cloudHttp(transport);
  const { userId } = await request<{ userId: string }>("/v1/me/identity");
  if (typeof userId !== "string" || !userId)
    throw new Error("Native authenticated identity required");
  // Pin all subsequent requests to this person; token rotation/account switches cannot change owner.
  const pinned: CloudTransport = {
    ...transport,
    headers: async () => ({ ...(await transport.headers()), "x-native-owner": userId }),
  };
  const workspace = await cloudHttp(pinned)<{ id: string; organization_id: string }>(
    "/v1/workspaces/" + encodeURIComponent(mapping.cloudWorkspaceId),
  );
  if (workspace.id !== mapping.cloudWorkspaceId) throw new Error("Workspace mapping mismatch");
  if (
    mapping.cloudOrganizationId !== undefined &&
    workspace.organization_id !== mapping.cloudOrganizationId
  )
    throw new Error("Organization mapping mismatch");
  const source = createCloudIntelligenceProfileSource(pinned);
  const profileSource: typeof source = {
    profileContext: (args) =>
      args.workspaceId === mapping.cloudWorkspaceId
        ? source.profileContext(args)
        : Promise.resolve(null),
  };
  const { learning } = createCloudFoundationAdapters(pinned, mapping.cloudWorkspaceId);
  const knowledge = await createCloudProjectHttpBackend(pinned, mapping.cloudWorkspaceId, {
    localRootPath: mapping.localRootPath,
    runtimeId: mapping.runtimeId,
    embeddingSpace: input.embeddingSpace,
  });
  return {
    userId,
    mapping,
    workspaceId: mapping.cloudWorkspaceId,
    organizationId: workspace.organization_id,
    userKnowledgeStore: createCloudUserKnowledgeStore(pinned),
    profileSource,
    knowledge,
    learningClaimStore: learning,
    semantic: createCloudSemanticClient(pinned, mapping.cloudWorkspaceId, input.embeddingSpace),
    signals: createCloudSignalsClient(pinned),
    // Owner is never caller-supplied. The existing renderer owns section text, ids and version.
    deliverProfiles: (options: {
      userIntent: string;
      surface: IntelligenceSurface;
      exclude?: Iterable<string>;
      maxChars?: number;
    }) =>
      deliverIntelligenceProfiles(profileSource, {
        ...options,
        owner: userId,
        workspaceId: mapping.cloudWorkspaceId,
      }),
  };
}

export type CloudNativeBinding = NonNullable<Awaited<ReturnType<typeof resolveCloudNativeBinding>>>;
