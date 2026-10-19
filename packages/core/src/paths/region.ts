// SPDX-License-Identifier: Apache-2.0
//
// Anchored regions: how Pathrule owns PART of a file whose name belongs to the
// user.
//
// Several agent clients read a fixed filename that predates Pathrule
// (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`). For those we cannot invent our own
// name, and taking the whole file means the user's instructions stop reaching
// the agent. So Pathrule owns a marked region inside the file and never touches
// a byte outside it.
//
// The anchors are HTML comments, which every client strips before the content
// reaches the model, so they cost nothing in context.
//
// Pure and deterministic: same inputs, same bytes.

import { USER_INSTRUCTION_BASENAMES, isPathruleManaged, opensWithPathruleBanner } from "./ownership.js";

export interface RegionAnchors {
  begin: string;
  end: string;
}

/** The knowledge/protocol region Pathrule maintains inside a user-owned file. */
export const PATHRULE_REGION: RegionAnchors = {
  begin: "<!-- pathrule:begin (managed by Pathrule; edits inside this region are overwritten) -->",
  end: "<!-- pathrule:end -->",
};

/** True when the file already carries this region (both anchors, in order). */
export function hasRegion(body: string, anchors: RegionAnchors = PATHRULE_REGION): boolean {
  const begin = body.indexOf(anchors.begin);
  if (begin < 0) return false;
  return body.indexOf(anchors.end, begin + anchors.begin.length) > begin;
}

/**
 * Replace (or append) the anchored region, leaving everything outside it byte-identical.
 *
 *   1. both anchors present  → replace what is between them
 *   2. only `begin` present  → recover: treat the rest of the file as the region
 *   3. no anchors            → append the region at the end
 *
 * Always returns a body ending in exactly one newline.
 */
export function spliceRegion(
  body: string,
  sectionBody: string,
  anchors: RegionAnchors = PATHRULE_REGION,
): string {
  const region = `${anchors.begin}\n${sectionBody.trim()}\n${anchors.end}\n`;

  const beginIdx = body.indexOf(anchors.begin);
  const endIdx =
    beginIdx < 0 ? -1 : body.indexOf(anchors.end, beginIdx + anchors.begin.length);

  if (beginIdx >= 0 && endIdx > beginIdx) {
    const before = body.slice(0, beginIdx);
    const after = body.slice(endIdx + anchors.end.length);
    return normalizeTail(before + region + after.replace(/^\n+/, "\n"));
  }

  if (beginIdx >= 0) {
    // Truncated region (someone deleted the end anchor): rebuild from `begin`.
    return normalizeTail(body.slice(0, beginIdx) + region);
  }

  const base = body.trimEnd();
  return normalizeTail(base === "" ? region : `${base}\n\n${region}`);
}

/**
 * The file with Pathrule's region removed: the user's own content.
 * Used to tell "this file is entirely ours" from "the user owns part of it",
 * and by the recovery flow to show what a user would keep.
 */
export function stripRegion(body: string, anchors: RegionAnchors = PATHRULE_REGION): string {
  const beginIdx = body.indexOf(anchors.begin);
  if (beginIdx < 0) return body;
  const endIdx = body.indexOf(anchors.end, beginIdx + anchors.begin.length);
  const after = endIdx > beginIdx ? body.slice(endIdx + anchors.end.length) : "";
  return `${body.slice(0, beginIdx).trimEnd()}\n${after.trimStart()}`.trim();
}

/**
 * The full merge-region decision, in ONE place so every writer behaves
 * identically: the multi-client disk writer, the dedicated root-CLAUDE.md
 * writer, and the CLI.
 *
 *   - no file yet            → Pathrule's body alone, but still anchored, so a
 *                             user can add content around it later and the next
 *                             sync will respect it;
 *   - a file Pathrule fully  → replaced (nothing of the user's is in there).
 *     owned before anchors     Detected by banner, not by path.
 *     existed
 *   - anything else          → the user's file. Keep every byte outside the
 *                             region; refresh only the region.
 */
export function mergeRegionInto(
  existing: string | null,
  sectionBody: string,
  anchors: RegionAnchors = PATHRULE_REGION,
): string {
  if (existing === null) return spliceRegion("", sectionBody, anchors);
  // Only a file that OPENS with Pathrule's banner was Pathrule's as a whole; a person's file that merely
  // quotes a banner keeps every byte, and gets the region appended.
  const legacyPathruleOwned = !hasRegion(existing, anchors) && opensWithPathruleBanner(existing);
  return spliceRegion(legacyPathruleOwned ? "" : existing, sectionBody, anchors);
}

/**
 * True when NOTHING in this file belongs to the user, so removing the file is
 * safe. The distinction from `isPathruleManaged` is load-bearing: a file with an
 * anchored region is mostly the user's, and deleting it because it "looks like
 * ours" would destroy their instructions. Any deletion path must gate on this.
 */
export function isEntirelyPathrule(
  body: string,
  anchors: RegionAnchors = PATHRULE_REGION,
): boolean {
  if (!isPathruleManaged(body)) return false;
  // A banner with no anchors is a file Pathrule owned outright, from before
  // regions existed. There is no user content in it to protect.
  if (!hasRegion(body, anchors)) return true;
  return stripRegion(body, anchors).trim() === "";
}

function normalizeTail(s: string): string {
  return `${s.replace(/\n+$/, "")}\n`;
}

/** Any spelling of the anchors an older Pathrule wrote: `<!-- pathrule:begin … -->` and `<!-- pathrule:end -->`. */
const BEGIN_ANY = /<!--\s*pathrule:begin\b[^>]*-->/g;
const END_ANY = /<!--\s*pathrule:end\s*-->/g;

/** Where Pathrule's region sits in a file, or why that cannot be told. */
export type RegionBounds =
  | { kind: "none" }
  | { kind: "one"; begin: number; end: number }
  | { kind: "ambiguous"; reason: string };

/**
 * Exactly one begin and one end anchor, in that order, is a region whose bytes are known to be Pathrule's.
 * Anything else (an anchor lost, a second region, the end before the begin) is ambiguous: where Pathrule's
 * text stops and the person's starts cannot be told, so no cleanup may touch the file.
 */
export function regionBounds(body: string): RegionBounds {
  const begins = [...body.matchAll(BEGIN_ANY)];
  const ends = [...body.matchAll(END_ANY)];
  if (begins.length === 0 && ends.length === 0) return { kind: "none" };
  if (begins.length !== 1 || ends.length !== 1) {
    return { kind: "ambiguous", reason: `${begins.length} begin and ${ends.length} end markers of a Pathrule region` };
  }
  const begin = begins[0]!.index!;
  const endAt = ends[0]!.index!;
  if (endAt < begin) return { kind: "ambiguous", reason: "the end marker of a Pathrule region comes before its begin marker" };
  return { kind: "one", begin, end: endAt + ends[0]![0].length };
}

/**
 * The file without Pathrule's region, the inverse of `spliceRegion`: the region's own line end and the one
 * blank line it was appended after go with it, and every other byte stays as the person had it. "" when
 * nothing else was in the file.
 */
export function retractRegion(body: string, bounds: { begin: number; end: number }): string {
  let before = body.slice(0, bounds.begin);
  let after = body.slice(bounds.end);
  if (after.startsWith("\n")) after = after.slice(1);
  if (after === "" && before.endsWith("\n\n")) before = before.slice(0, -1);
  return before.trim() === "" && after.trim() === "" ? "" : before + after;
}

/** What of a file is Pathrule's, decided once for every cleanup (sync's sweep, eject, detach). */
export type PathruleShare =
  /** Nothing: never touched. */
  | { kind: "none" }
  /** An anchored region in the person's file; `rest` is the file without it ("" when nothing else). */
  | { kind: "region"; rest: string }
  /** Pathrule wrote the whole file. */
  | { kind: "whole" }
  /** Pathrule's marker is there, but not where its text ends: left as it is, and said so. */
  | { kind: "ambiguous"; reason: string };

/**
 * A file under a name the person owns (USER_INSTRUCTION_BASENAMES) is Pathrule's as a whole only when it
 * opens with Pathrule's banner; a name Pathrule invented is its own whenever a marker is in it.
 */
export function pathruleShare(path: string, body: string): PathruleShare {
  if (!isPathruleManaged(body) && regionBounds(body).kind === "none") return { kind: "none" };
  const bounds = regionBounds(body);
  if (bounds.kind === "ambiguous") return bounds;
  if (bounds.kind === "one") {
    const rest = retractRegion(body, bounds);
    return rest === "" ? { kind: "whole" } : { kind: "region", rest };
  }
  const name = path.split("/").pop() ?? path;
  if (USER_INSTRUCTION_BASENAMES.has(name)) return opensWithPathruleBanner(body) ? { kind: "whole" } : { kind: "none" };
  return { kind: "whole" };
}
