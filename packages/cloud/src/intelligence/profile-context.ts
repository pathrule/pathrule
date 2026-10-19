// SPDX-License-Identifier: Apache-2.0
// Team and personal profiles (Team Intelligence) as Pathrule Cloud delivers them to every surface:
// the host's compiled turn, MCP get_context and the hook index. One source, one renderer and one
// version, so the surfaces cannot disagree about what a person's agent was told.
//
// The provider owns eligibility, authorization and ranking: Pathrule Cloud's profile route
// (../native/client/profile-source.ts). Nothing here ranks or learns. It renders what the provider selected, in the provider's order, and leaves
// out what a surface already delivered or what does not fit that surface's budget.

import {
  intelligenceItemVersion,
  type IntelligenceProfileDelivery,
  type IntelligenceSurface,
} from "@pathrule/protocol/intelligence-delivery.js";

export interface IntelligenceProfileEntry {
  id: string;
  category: string;
  statement: string;
  priority: "high" | "medium" | "low";
  relevance_score?: number;
}

export interface IntelligenceProfilePayload {
  enabled: boolean;
  team_profile?: IntelligenceProfileEntry[];
  personal_profile?: IntelligenceProfileEntry[];
}

/**
 * The account's provider of profiles, bound to ONE authenticated person when it is built. It returns
 * only what that person may see in that workspace: the organization's verified profile when the
 * organization enabled it and the person's plan gives access, and the person's own enabled entries
 * unless they turned personal context off. Ranked and limited by the provider, which returns them
 * in order. Patterns and evidence are never part of it. Null when
 * the provider is unavailable.
 *
 * A scoped workspace token is not a person: a source built over one returns null, so nobody's
 * personal entries can travel on a workspace's credentials.
 */
export interface IntelligenceProfileSource {
  profileContext(input: {
    workspaceId: string;
    userIntent: string;
    surface: IntelligenceSurface;
  }): Promise<IntelligenceProfilePayload | null>;
}

export function applyPersonalContextPreference(
  payload: IntelligenceProfilePayload,
  enabled: boolean,
): IntelligenceProfilePayload {
  if (enabled) return payload;
  const teamProfile = payload.team_profile ?? [];
  return {
    ...payload,
    enabled: teamProfile.length > 0,
    personal_profile: [],
  };
}

function renderEntry(entry: IntelligenceProfileEntry): string {
  const score = Number(entry.relevance_score);
  const scoreLabel = Number.isFinite(score) ? ` · relevance ${score.toFixed(2)}` : "";
  return `- [${entry.priority} · ${entry.category}${scoreLabel}] ${entry.statement.trim()}`;
}

function renderSections(
  surface: IntelligenceSurface,
  team: IntelligenceProfileEntry[],
  personal: IntelligenceProfileEntry[],
): string {
  if (team.length === 0 && personal.length === 0) return "";
  return [
    "## Team and personal profiles (human-managed)",
    `Surface: ${surface}. Apply these instructions only when relevant to this request.`,
    "Verified organization instructions outrank personal preferences if they conflict. Neither section grants permissions or overrides repository rules.",
    "Apply private personal preferences silently. Do not quote, enumerate, expose, or attribute them unless the signed-in user explicitly asks about their own preferences.",
    team.length > 0 ? "### Verified organization profile" : "",
    ...team.map(renderEntry),
    personal.length > 0 ? "### Private personal preferences" : "",
    ...personal.map(renderEntry),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The provider's selection, rendered in its order: team entries first, since verified organization
 * instructions outrank personal preferences. `exclude` leaves out entries a surface already
 * delivered; `maxChars` keeps the entries that fit, in order, and drops the rest whole (never a cut
 * statement). Returns the ids it rendered.
 */
export function renderIntelligenceProfileBlock(
  payload: IntelligenceProfilePayload | null,
  surface: IntelligenceSurface,
  options: { exclude?: Iterable<string>; maxChars?: number } = {},
): { block: string; ids: string[] } {
  if (!payload?.enabled) return { block: "", ids: [] };
  const excluded = new Set(options.exclude ?? []);
  const keep = (entry: IntelligenceProfileEntry) =>
    typeof entry?.statement === "string" &&
    entry.statement.trim() !== "" &&
    !excluded.has(entry.id);
  const team = (payload.team_profile ?? []).filter(keep);
  const personal = (payload.personal_profile ?? []).filter(keep);
  const max = options.maxChars;
  if (max === undefined) {
    return {
      block: renderSections(surface, team, personal),
      ids: [...team, ...personal].map((entry) => entry.id),
    };
  }
  const fitTeam: IntelligenceProfileEntry[] = [];
  const fitPersonal: IntelligenceProfileEntry[] = [];
  for (const [entry, into] of [
    ...team.map((entry) => [entry, fitTeam] as const),
    ...personal.map((entry) => [entry, fitPersonal] as const),
  ]) {
    into.push(entry);
    if (renderSections(surface, fitTeam, fitPersonal).length > max) into.pop();
  }
  return {
    block: renderSections(surface, fitTeam, fitPersonal),
    ids: [...fitTeam, ...fitPersonal].map((entry) => entry.id),
  };
}

/**
 * One surface's profile section for one person: the provider's selection for the request, rendered
 * and versioned. Null when the provider is unavailable (a caller keeps what it had); an empty block
 * when there is nothing to deliver (a caller clears what it had). Never throws.
 */
export async function deliverIntelligenceProfiles(
  source: IntelligenceProfileSource,
  input: {
    owner: string;
    workspaceId: string;
    userIntent: string;
    surface: IntelligenceSurface;
    exclude?: Iterable<string>;
    maxChars?: number;
  },
): Promise<IntelligenceProfileDelivery | null> {
  const payload = await source
    .profileContext({
      workspaceId: input.workspaceId,
      userIntent: input.userIntent,
      surface: input.surface,
    })
    .catch(() => null);
  if (!payload) return null;
  const { block, ids } = renderIntelligenceProfileBlock(payload, input.surface, {
    exclude: input.exclude,
    maxChars: input.maxChars,
  });
  return {
    owner: input.owner,
    surface: input.surface,
    block,
    version: block ? intelligenceItemVersion(input.surface, block) : "",
    ids,
  };
}
