// SPDX-License-Identifier: Apache-2.0
export interface SkillInvocationMarker {
  raw: string;
  name: string;
  start: number;
  end: number;
}

const TOKEN_RE = /^[A-Za-z0-9_-]+/;
const LEFT_BOUNDARY_RE = /[\s([{'"`]/;

/**
 * Reserved token namespace. `::pathrule:*` tokens are NEVER skill invocations.
 * They are product directives (currently `::pathrule:package:<slug>` pattern
 * imports). Reserving the whole `::pathrule:` prefix here GUARANTEES such a
 * token can never be parsed as a skill name (it would otherwise be read as the
 * skill `pathrule`, since the skill token stops at the first colon) and so can
 * never trigger the find-skills protocol.
 */
const RESERVED_PREFIX = "pathrule:";

/** Pattern import directive: `::pathrule:package:<slug>`. */
const PATTERN_IMPORT_RE = /^pathrule:package:([a-z0-9][a-z0-9-]*)/i;

export function normalizeSkillInvocationName(value: string): string {
  return value.trim().toLowerCase();
}

export function extractSkillInvocationMarkers(prompt: string): SkillInvocationMarker[] {
  const masked = maskMarkdownCode(prompt);
  const markers: SkillInvocationMarker[] = [];

  for (let i = 0; i < masked.length - 2; i += 1) {
    if (masked[i] !== ":" || masked[i + 1] !== ":") continue;
    const prev = i === 0 ? "" : (masked[i - 1] ?? "");
    if (prev && !LEFT_BOUNDARY_RE.test(prev)) continue;

    const rest = masked.slice(i + 2);

    // Reserved: ::pathrule:* is a product directive, not a skill. Skip it so it
    // never reaches skill matching / find-skills.
    if (rest.slice(0, RESERVED_PREFIX.length).toLowerCase() === RESERVED_PREFIX) {
      i += 1 + RESERVED_PREFIX.length;
      continue;
    }

    const match = rest.match(TOKEN_RE);
    if (!match?.[0]) continue;

    const raw = match[0];
    markers.push({
      raw,
      name: normalizeSkillInvocationName(raw),
      start: i,
      end: i + 2 + raw.length,
    });
    i += 1 + raw.length;
  }

  return dedupeMarkers(markers);
}

export interface PatternImportMarker {
  slug: string;
  raw: string;
  start: number;
  end: number;
}

/**
 * Extract `::pathrule:package:<slug>` pattern-import directives from a prompt.
 * Shares the same boundary + code-masking rules as skill markers, and is fully
 * separate from skill invocation (the reserved namespace above guarantees no
 * overlap).
 */
export function extractPatternImportMarkers(prompt: string): PatternImportMarker[] {
  const masked = maskMarkdownCode(prompt);
  const out: PatternImportMarker[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < masked.length - 2; i += 1) {
    if (masked[i] !== ":" || masked[i + 1] !== ":") continue;
    const prev = i === 0 ? "" : (masked[i - 1] ?? "");
    if (prev && !LEFT_BOUNDARY_RE.test(prev)) continue;

    const match = masked.slice(i + 2).match(PATTERN_IMPORT_RE);
    if (!match?.[1]) continue;

    const slug = match[1].toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      slug,
      raw: masked.slice(i, i + 2 + match[0].length),
      start: i,
      end: i + 2 + match[0].length,
    });
    i += 1 + match[0].length;
  }

  return out;
}

function dedupeMarkers(markers: SkillInvocationMarker[]): SkillInvocationMarker[] {
  const seen = new Set<string>();
  const out: SkillInvocationMarker[] = [];
  for (const marker of markers) {
    if (seen.has(marker.name)) continue;
    seen.add(marker.name);
    out.push(marker);
  }
  return out;
}

function maskMarkdownCode(input: string): string {
  let out = "";
  let i = 0;
  let inFence = false;
  let inInline = false;

  while (i < input.length) {
    if (input.startsWith("```", i)) {
      inFence = !inFence;
      out += "   ";
      i += 3;
      continue;
    }

    const ch = input[i] ?? "";
    if (!inFence && ch === "`") {
      inInline = !inInline;
      out += " ";
      i += 1;
      continue;
    }

    out += inFence || inInline ? (ch === "\n" ? "\n" : " ") : ch;
    i += 1;
  }

  return out;
}
