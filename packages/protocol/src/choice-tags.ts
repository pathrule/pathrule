// SPDX-License-Identifier: Apache-2.0
//
// The closed vocabulary of trade-off tags a decision-card option may carry.
//
// A decision card lays out an agent's "A or B?" with each option's trade-offs; the person's
// pick is the best evidence of how they choose. The tags are closed so every choice stays
// comparable with every other. Studio renders and parses the card; whatever learns from the
// pick reads the same vocabulary from here, so the two sides cannot drift.

/** The trade-off tags an option may carry. Closed, so choices are comparable across conversations. */
export const CHOICE_TAGS = [
  "minimal-change",
  "refactor",
  "adds-dependency",
  "reuses-existing",
  "new-abstraction",
  "explicit",
  "performance",
  "simplicity",
  "robustness",
  "security",
  "speed",
  "tests",
  "backward-compatible",
] as const;
export type ChoiceTag = (typeof CHOICE_TAGS)[number];

export function isChoiceTag(value: unknown): value is ChoiceTag {
  return typeof value === "string" && (CHOICE_TAGS as readonly string[]).includes(value);
}
