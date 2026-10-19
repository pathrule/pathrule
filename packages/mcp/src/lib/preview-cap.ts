// SPDX-License-Identifier: Apache-2.0
/**
 * Cap memory/rule preview strings for list surfaces.
 * Normalises whitespace (newline + tab + multi-space runs) to single spaces
 * so previews stay tight, then truncates to `max` chars and appends `…`.
 */
export function capPreview(input: string, max: number): string {
  const normalised = input.replace(/\s+/g, " ").trim();
  if (normalised.length <= max) return normalised;
  return normalised.slice(0, max) + "…";
}
