// SPDX-License-Identifier: Apache-2.0
// Memory context paths: the paths a memory is also relevant to, beyond its own node. The write and
// update tools accept them as `related_paths` and hand them to the backend with the write
// (core backend/memory-links.ts).

/**
 * Client-side pre-validation: trim, drop empty entries, cap at 32. The backend validates and
 * canonicalises what is left.
 *
 * `null` or omitted means "not given" (an update keeps the stored links). An array, even one that
 * is empty after trimming, is given: `[]` clears the links, as the update tool documents. This
 * used to return null for `[]`, so the documented clear did nothing.
 */
export function prepareRelatedPaths(raw: string[] | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null;
  return raw
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, 32);
}
