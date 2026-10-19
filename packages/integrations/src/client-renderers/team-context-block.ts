// SPDX-License-Identifier: Apache-2.0
// Team context block: the one personalization surface Pathrule compiles into
// turn-zero instruction files.
//
// Why this channel and not the hook: the hook channel is paid PER TURN. The
// 2026-08-23 audit measured 157K tokens accumulated across 60 prompts in one
// long session, so anything constant belongs in the compiled file where the
// prompt cache pays for it once. This block is constant for a workspace, so it
// rides the compiled file.
//
// Why it is appended LAST in the file: a cached prefix is invalidated from the
// first changed byte onward. Team membership changes far more often than
// compiled knowledge, so the volatile block sits at the END and leaves the
// knowledge prefix byte-identical.
//
// Hard limits:
//   - one block, once per file, never a second one
//   - at most TEAM_BLOCK_TOKEN_BUDGET tokens including the heading
//   - structured input only, rendered into fixed sentence frames
//   - no evaluative content: no performance, speed, quality or seniority claim
//
// The last point is enforced structurally rather than by review: this module
// accepts only names, paths, tags and a declared decision scope. There is no
// field an evaluative sentence could travel in, and free text is length-capped
// and whitespace-collapsed so a compiled file can never grow a paragraph here.

/** A derived ownership claim: who is the reference for which area. */
export interface TeamPathOwner {
  name: string;
  /** Workspace-relative path or area label the person is the reference for. */
  area: string;
}

/** A DECLARED decision scope. Never derived: see the plan, section 7. */
export interface TeamDecisionOwner {
  name: string;
  scope: string;
}

export interface TeamContextBlock {
  /** Organization display name. */
  teamName?: string | null;
  /** The person this file is compiled for. */
  userName?: string | null;
  /** The viewer's own derived areas, already evidence-backed upstream. */
  userAreas?: readonly string[];
  /** Other members, with the single area each is the reference for. */
  owners?: readonly TeamPathOwner[];
  /** Declared decision owners. */
  decisionOwners?: readonly TeamDecisionOwner[];
}

export const TEAM_CONTEXT_HEADING = "## Team (Pathrule)";

/** Section 11 budget. A block over this is trimmed, never split in two. */
export const TEAM_BLOCK_TOKEN_BUDGET = 120;

/** At most this many owners are named, whatever the budget allows. */
const MAX_OWNERS = 3;
const MAX_DECISION_OWNERS = 2;
const MAX_USER_AREAS = 3;

const MAX_NAME_CHARS = 40;
const MAX_AREA_CHARS = 48;

/**
 * The actionable half of the block. Reserved before anything else is measured,
 * because a list of owners with no instruction is data the agent will not act
 * on, and an instruction with no owners is noise.
 */
const GUIDANCE =
  "Address the user by name. When a decision touches another person's area, " +
  "point at its owner instead of deciding for them.";

/**
 * Conservative token estimate: 3.5 chars per token against the ~4 that English
 * prose actually averages. The headroom covers names, diacritics and paths,
 * which tokenize worse than prose, so a block that passes this check is under
 * 120 real tokens rather than near it.
 */
export function estimateBlockTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Collapse to a single line and cap. Keeps a compiled file from growing prose. */
function clean(value: string | null | undefined, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1).trimEnd()}...` : flat;
}

function cleanOwners(owners: readonly TeamPathOwner[] | undefined): TeamPathOwner[] {
  const seen = new Set<string>();
  const out: TeamPathOwner[] = [];
  for (const owner of owners ?? []) {
    const name = clean(owner?.name, MAX_NAME_CHARS);
    const area = clean(owner?.area, MAX_AREA_CHARS);
    if (!name || !area) continue;
    // Escaped, not a raw byte: a literal NUL in the source makes git treat
    // this file as binary. A separator that cannot occur in either half is
    // still the right key, so keep the character and spell it out.
    const key = `${name}\u0000${area}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, area });
  }
  // Deterministic bytes for the prompt cache: same input set, same order.
  out.sort((a, b) => a.name.localeCompare(b.name, "en") || a.area.localeCompare(b.area, "en"));
  return out.slice(0, MAX_OWNERS);
}

function cleanDecisionOwners(
  owners: readonly TeamDecisionOwner[] | undefined,
): TeamDecisionOwner[] {
  const out: TeamDecisionOwner[] = [];
  for (const owner of owners ?? []) {
    const name = clean(owner?.name, MAX_NAME_CHARS);
    const scope = clean(owner?.scope, MAX_AREA_CHARS);
    if (!name || !scope) continue;
    out.push({ name, scope });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "en") || a.scope.localeCompare(b.scope, "en"));
  return out.slice(0, MAX_DECISION_OWNERS);
}

function identityLine(block: TeamContextBlock): string | null {
  const team = clean(block.teamName, MAX_NAME_CHARS);
  const user = clean(block.userName, MAX_NAME_CHARS);
  const areas = (block.userAreas ?? [])
    .map((a) => clean(a, MAX_AREA_CHARS))
    .filter((a): a is string => a !== null)
    .slice(0, MAX_USER_AREAS);

  if (!team && !user) return null;
  const parts: string[] = [];
  if (team) parts.push(`Team: ${team}.`);
  if (user) {
    parts.push(areas.length > 0 ? `User: ${user} (${areas.join(", ")}).` : `User: ${user}.`);
  }
  return parts.join(" ");
}

function ownersLine(owners: TeamPathOwner[]): string | null {
  if (owners.length === 0) return null;
  return `Reference for each area: ${owners.map((o) => `${o.name} (${o.area})`).join(", ")}.`;
}

function decisionsLine(owners: TeamDecisionOwner[]): string | null {
  if (owners.length === 0) return null;
  return `Declared decision scope: ${owners.map((o) => `${o.name} (${o.scope})`).join(", ")}.`;
}

/**
 * Render the block, or null when there is nothing worth spending tokens on.
 *
 * Trimming drops whole lines from the lowest-value end (decision scope, then
 * owners) and never truncates mid-sentence, so a trimmed block still reads as
 * something an agent can act on. The guidance line is reserved up front and is
 * the last thing dropped, and if only the guidance survives the block is
 * suppressed entirely: an instruction with nobody to point at is noise.
 */
export function renderTeamContextBlock(block: TeamContextBlock | null | undefined): string | null {
  if (!block) return null;

  const identity = identityLine(block);
  const owners = ownersLine(cleanOwners(block.owners));
  const decisions = decisionsLine(cleanDecisionOwners(block.decisionOwners));
  if (!identity && !owners && !decisions) return null;

  // Lowest value last: this is the order lines get dropped in.
  const candidates = [identity, owners, decisions].filter((l): l is string => l !== null);

  const fixedCost = estimateBlockTokens(`${TEAM_CONTEXT_HEADING}\n\n${GUIDANCE}\n`);
  const kept: string[] = [];
  let spent = fixedCost;
  for (const line of candidates) {
    const cost = estimateBlockTokens(`${line}\n`);
    if (spent + cost > TEAM_BLOCK_TOKEN_BUDGET) break;
    kept.push(line);
    spent += cost;
  }
  if (kept.length === 0) return null;

  return `${TEAM_CONTEXT_HEADING}\n\n${kept.join("\n")}\n\n${GUIDANCE}\n`;
}
