// SPDX-License-Identifier: Apache-2.0
// Deterministic slugifier for skill folder names. Browser-safe — no deps.
//
// Rules: ASCII-lowercase, kebab-case, strip punctuation. Collision handling
// (appending -<id-short>) is the caller's responsibility; this function
// returns a clean base slug.

const FALLBACK = "skill";

export function slugifySkillName(name: string): string {
  const base = (name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) return FALLBACK;
  // Cut, then trim again: a cut can land on a hyphen, and a slug never ends with one.
  return base.slice(0, 80).replace(/-+$/, "");
}

export function slugWithIdSuffix(name: string, id: string): string {
  const base = slugifySkillName(name);
  const shortId = id.replace(/-/g, "").slice(0, 8);
  return `${base}-${shortId}`;
}
