// SPDX-License-Identifier: Apache-2.0
// Surgical content edits for memory/rule/skill updates.
//
// The problem this solves: to change one line of a long memory/rule/skill body,
// an AI client previously had to read the whole body and re-send the ENTIRE new
// content in `patch.content` — expensive (tokens + latency) and error-prone (it
// can silently drop or reword the parts it wasn't touching). `content_edit` lets
// the caller send only the DELTA; the update handler already fetches the current
// row, so the edit is applied server-side against the authoritative body.
//
// Pure and deterministic: (currentContent, edit) -> new content or a typed error.
// No I/O, no clock. The three update handlers (memories/rules/skills) share it,
// so the four surfaces (MCP / CLI / VS Code / host) get identical semantics.

/** One targeted edit against a stored body. Exactly one op per call. */
export type ContentEdit =
  /** Append text to the end of the body (blank line inserted between). */
  | { op: "append"; text: string }
  /** Prepend text to the start of the body (blank line inserted between). */
  | { op: "prepend"; text: string }
  /**
   * Replace the single occurrence of `find` with `replace` (like the editor's
   * str-replace). `find` MUST occur exactly once — 0 matches → not_found,
   * >1 → ambiguous (add surrounding context to make it unique).
   */
  | { op: "str_replace"; find: string; replace: string }
  /**
   * Replace a whole markdown section: everything from the heading whose text
   * equals `heading` through the line before the next heading of the same or
   * higher level (or end of body). `heading` may be given with or without its
   * leading `#`s; the matched heading line is preserved, `body` becomes its
   * new content. Lines inside fenced code blocks are never headings.
   */
  | { op: "replace_section"; heading: string; body: string };

export type ContentEditResult =
  | { ok: true; content: string }
  | { ok: false; code: "invalid_args" | "not_found" | "ambiguous"; message: string };

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
// A code fence line (CommonMark 4.5): up to three spaces, then three or more backticks
// or tildes, then an optional info string.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*?)\s*$/;

/** Normalise a heading target to its text (strip leading #s + whitespace). */
function headingText(raw: string): string {
  const m = raw.match(HEADING_RE);
  return (m ? (m[2] ?? raw) : raw).trim();
}

/**
 * Mark the lines that are code rather than markdown structure. A `# comment` in a
 * shell sample is not a heading: reading it as one ended a section in the middle of
 * its code block and left the rest of the old section behind, reported as success.
 *
 * CommonMark rules: a fence closes on the same character, at least as long, with
 * nothing after it, and a backtick fence's info string cannot contain a backtick.
 * `malformed` flags a body whose fences cannot be trusted: one that never closes, or
 * an opener with a language tag inside an open fence, which is almost always a
 * missing closer rather than a code sample about markdown.
 */
function scanFences(lines: string[]): { inCode: boolean[]; malformed: boolean } {
  const inCode = new Array<boolean>(lines.length).fill(false);
  let open: { marker: string; size: number } | null = null;
  let malformed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(FENCE_RE);
    const run = m?.[1] ?? "";
    const info = m?.[2] ?? "";
    if (open) {
      inCode[i] = true;
      if (m && run[0] === open.marker && run.length >= open.size) {
        if (info === "") open = null;
        else malformed = true;
      }
    } else if (m && !(run[0] === "`" && info.includes("`"))) {
      inCode[i] = true;
      open = { marker: run[0] ?? "", size: run.length };
    }
  }
  return { inCode, malformed: malformed || open !== null };
}

type SectionLookup =
  | { ok: true; start: number; end: number }
  | { ok: false; code: "not_found" | "ambiguous" };

/** Find the section headed `target`; lines flagged in `skip` are never headings. */
function locateSection(lines: string[], target: string, skip: boolean[] | null): SectionLookup {
  const headingAt = (i: number) => (skip?.[i] ? null : (lines[i] ?? "").match(HEADING_RE));
  const matches: Array<{ index: number; level: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = headingAt(i);
    if (m && (m[2] ?? "").trim().toLowerCase() === target) {
      matches.push({ index: i, level: (m[1] ?? "").length });
    }
  }
  if (matches.length === 0) return { ok: false, code: "not_found" };
  if (matches.length > 1) return { ok: false, code: "ambiguous" };
  const { index, level } = matches[0]!;
  // The end: the next heading at the same or higher level (fewer/equal #s).
  let end = lines.length;
  for (let i = index + 1; i < lines.length; i++) {
    const m = headingAt(i);
    if (m && (m[1] ?? "").length <= level) {
      end = i;
      break;
    }
  }
  return { ok: true, start: index, end };
}

function sameLookup(a: SectionLookup, b: SectionLookup): boolean {
  if (a.ok && b.ok) return a.start === b.start && a.end === b.end;
  return !a.ok && !b.ok && a.code === b.code;
}

function applyReplaceSection(current: string, heading: string, body: string): ContentEditResult {
  const target = headingText(heading).toLowerCase();
  if (!target) {
    return { ok: false, code: "invalid_args", message: "replace_section requires a non-empty heading." };
  }
  const lines = current.split("\n");
  const fences = scanFences(lines);
  const found = locateSection(lines, target, fences.inCode);
  // Reading the fences decides where the section ends. When they cannot be trusted,
  // proceed only if ignoring them gives the same answer; otherwise any choice can
  // delete content the caller never meant to touch.
  const plain = locateSection(lines, target, null);
  if (fences.malformed && !sameLookup(found, plain)) {
    return {
      ok: false,
      code: "ambiguous",
      message: `A code fence in this content is never closed, so where "${headingText(heading)}" ends is ambiguous. Fix the fence with str_replace first, or make this change with str_replace.`,
    };
  }
  if (!found.ok && found.code === "not_found") {
    const insideCode = plain.ok || plain.code === "ambiguous";
    return {
      ok: false,
      code: "not_found",
      message: insideCode
        ? `"${headingText(heading)}" only appears inside a fenced code block, which is code, not a heading. Use str_replace instead.`
        : `No markdown heading matching "${headingText(heading)}" was found. Use the exact heading text, or use str_replace / append instead.`,
    };
  }
  if (!found.ok) {
    return {
      ok: false,
      code: "ambiguous",
      message: `Multiple headings match "${headingText(heading)}". Sections must be uniquely named to use replace_section; use str_replace with surrounding context instead.`,
    };
  }
  // Splice with exactly one blank line at each seam. Blank lines elsewhere are left
  // alone: they can be meaningful, like the two between Python functions in a sample.
  const newBody = body.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "");
  const rebuilt = [
    ...lines.slice(0, found.start),
    lines[found.start] ?? "",
    "",
    ...(newBody ? [newBody, ""] : []),
    ...lines.slice(found.end),
  ];
  return { ok: true, content: rebuilt.join("\n").replace(/\s+$/, "") + "\n" };
}

/**
 * Apply a single `ContentEdit` to `current`, returning the new body or a typed
 * error. The caller (an update handler) has already fetched `current`, so this
 * stays a pure transform.
 */
export function applyContentEdit(current: string, edit: ContentEdit): ContentEditResult {
  switch (edit.op) {
    case "append": {
      if (!edit.text) {
        return { ok: false, code: "invalid_args", message: "append requires non-empty text." };
      }
      const base = current.replace(/\s+$/, "");
      const joined = base.length === 0 ? edit.text.replace(/\s+$/, "") : `${base}\n\n${edit.text.replace(/\s+$/, "")}`;
      return { ok: true, content: `${joined}\n` };
    }
    case "prepend": {
      if (!edit.text) {
        return { ok: false, code: "invalid_args", message: "prepend requires non-empty text." };
      }
      const rest = current.replace(/^\s+/, "");
      const head = edit.text.replace(/\s+$/, "");
      const joined = rest.length === 0 ? head : `${head}\n\n${rest}`;
      return { ok: true, content: joined.replace(/\s+$/, "") + "\n" };
    }
    case "str_replace": {
      if (!edit.find) {
        return { ok: false, code: "invalid_args", message: "str_replace requires a non-empty `find`." };
      }
      const n = countOccurrences(current, edit.find);
      if (n === 0) {
        return {
          ok: false,
          code: "not_found",
          message: "The `find` text was not found in the current content. Read the item to get its exact text.",
        };
      }
      if (n > 1) {
        return {
          ok: false,
          code: "ambiguous",
          message: `The \`find\` text appears ${n} times. Add surrounding context so it matches exactly once.`,
        };
      }
      // Spliced, not String.replace: that reads `$'`, `$&` and `$$` in the replacement
      // as patterns, so a shell line like IFS=$'\n' pasted in the rest of the body.
      const at = current.indexOf(edit.find);
      return { ok: true, content: current.slice(0, at) + edit.replace + current.slice(at + edit.find.length) };
    }
    case "replace_section":
      return applyReplaceSection(current, edit.heading, edit.body);
    default: {
      // Exhaustiveness guard — an unknown op is a programming error at the wrapper.
      return { ok: false, code: "invalid_args", message: "Unknown content_edit op." };
    }
  }
}
