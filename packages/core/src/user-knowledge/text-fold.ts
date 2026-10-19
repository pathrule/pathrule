// SPDX-License-Identifier: Apache-2.0
/**
 * Case- and accent-fold text so the hook, the host and every stored term compare the same bytes.
 *
 * Lower-case, then decompose and drop combining marks, which folds accents in every script that has them
 * ("Değişiklik" and "degisiklik", "Größe" and "grosse", "déjà" and "deja", Vietnamese tones, Arabic
 * harakat). A handful of Latin letters are their own letter rather than a base plus a mark, so NFD leaves
 * them alone; they are mapped explicitly, for every language that has one (Turkish ı, Polish ł,
 * Danish/Norwegian ø and æ, Croatian/Vietnamese đ, Icelandic ð and þ, Maltese ħ, Sami ŧ, German ß, French
 * œ). The rule is per LETTER, never per language: no language gets treatment another one with the same
 * kind of letter does not. Scripts without case or marks (CJK) pass through unchanged.
 * `pathrule-hook.js` applies the same rule.
 *
 * Its own module because both relevance (`user-delivery.ts`) and the risk gate (`risk-gate.ts`) need
 * it, and neither should import the other.
 */
const NON_DECOMPOSING: Readonly<Record<string, string>> = {
  ı: "i", ł: "l", ø: "o", đ: "d", ð: "d", ħ: "h", ŧ: "t", ß: "ss", æ: "ae", œ: "oe", þ: "th",
};

export function foldText(text: string): string {
  return text.toLowerCase().replace(/[ıłøđðħŧßæœþ]/g, (c) => NON_DECOMPOSING[c] ?? c).normalize("NFD").replace(/\p{M}+/gu, "");
}

/** Folded words of a text, split on anything that is not a letter or digit in any script. */
export function foldedWords(text: string): string[] {
  return foldText(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}
