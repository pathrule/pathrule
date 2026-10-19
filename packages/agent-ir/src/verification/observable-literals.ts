// SPDX-License-Identifier: Apache-2.0
/**
 * The code an evidence span names, in the form it takes in an edit or a command.
 *
 * Evidence spans are quoted from markdown, so the code in them is usually wrapped in backticks:
 * "wrap the parse in `safeParse()`". Neither the backticks nor the prose around them ever appear
 * in the file the agent edits, so matching the span as written could never attribute a use. This
 * reads the inline code out of a span (or keeps the span when it has none), and turns an empty call
 * `name()` into its call prefix `name(`, because the edit will pass arguments. It adds no
 * candidate the span did not name, so attribution stays as strict as before about WHAT counts.
 */
const INLINE_CODE = /`([^`\n]+)`/g;

export function observableLiterals(spans: readonly string[]): string[] {
  const out: string[] = [];
  for (const span of spans) {
    const code = [...span.matchAll(INLINE_CODE)].map((m) => m[1]!.trim()).filter((c) => c.length > 0);
    for (const literal of code.length > 0 ? code : [span]) {
      const call = /^([A-Za-z_$][\w$.]*)\(\)$/.exec(literal);
      const form = call ? `${call[1]}(` : literal;
      if (!out.includes(form)) out.push(form);
    }
  }
  return out;
}
