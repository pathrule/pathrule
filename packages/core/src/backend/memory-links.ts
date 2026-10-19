// SPDX-License-Identifier: Apache-2.0
/**
 * A memory's secondary context links (`relatedPaths`): the workspace paths it is also relevant
 * to, beyond the node that owns it. One rule for every backend and for the write handlers, so
 * the same input stores the same links in every edition.
 *
 * A link is never a second owner. The owner is the memory's `nodeId`, it moves only by an explicit
 * re-home, and a link equal to the owner's path is dropped as redundant. Links are delivered like
 * an attachment (the hook places the memory's stub under each linked path, exact and descendant
 * paths inherit it), but the stub still names the owner, so a linked memory never outranks one
 * that is actually attached where the work happens.
 *
 * Update semantics, the same everywhere: omitted keeps the stored links, `[]` clears them, a list
 * replaces them.
 *
 * Pure on purpose: no Node import, so the cloud backend can share it in any bundle.
 */
import { normalizeNodePath } from "../tools/node-path.js";

/** The most links one memory may carry: the MCP tools' contract and the hosted store's limit. */
export const MAX_MEMORY_RELATED_PATHS = 32;

/** A rejected `relatedPaths` input. The write handlers report it as invalid arguments. */
export class RelatedPathsError extends Error {
  readonly code = "invalid_related_paths";
  constructor(message: string) {
    super(message);
    this.name = "RelatedPathsError";
  }
}

export function isRelatedPathsError(err: unknown): err is RelatedPathsError {
  return (
    err instanceof RelatedPathsError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === "invalid_related_paths")
  );
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function normalizeOne(raw: string): string {
  if (raw.includes("\\") || CONTROL_CHARS.test(raw)) {
    throw new RelatedPathsError(`invalid related path: ${JSON.stringify(raw)}`);
  }
  const path = normalizeNodePath(raw);
  // The root is not a link: attaching the memory at "/" is how it applies everywhere.
  if (path === "/" || path.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new RelatedPathsError(`invalid related path: ${JSON.stringify(raw)}`);
  }
  return path;
}

/**
 * Validate and canonicalise a link list against the memory's owner path: blank entries are
 * skipped, each path takes the workspace form (`/a/b`), duplicates and the owner's own path are
 * dropped, and the result is sorted so equal inputs store equal lists. Throws `RelatedPathsError`
 * for a root, traversal, backslash or control-character path, or more than 32 entries.
 */
export function normalizeRelatedPaths(raw: readonly string[], ownerPath: string | null): string[] {
  if (!Array.isArray(raw) || raw.some((p) => typeof p !== "string")) {
    throw new RelatedPathsError("related_paths must be an array of strings");
  }
  const given = raw.filter((p) => p.trim() !== "");
  if (given.length > MAX_MEMORY_RELATED_PATHS) {
    throw new RelatedPathsError(
      `too many related_paths (max ${MAX_MEMORY_RELATED_PATHS}, got ${given.length})`,
    );
  }
  const owner = ownerPath === null ? null : normalizeNodePath(ownerPath);
  const links = new Set<string>();
  for (const p of given) {
    const path = normalizeOne(p);
    if (path !== owner) links.add(path);
  }
  return [...links].sort();
}

/**
 * The links a memory carries after a write: `next` replaces them when given (validated against
 * the owner path), otherwise the stored ones stay, minus the owner's path in case the memory was
 * just re-homed onto one of its own links.
 */
export function nextRelatedPaths(
  stored: readonly string[],
  next: readonly string[] | undefined,
  ownerPath: string | null,
): string[] {
  if (next !== undefined) return normalizeRelatedPaths(next, ownerPath);
  const owner = ownerPath === null ? null : normalizeNodePath(ownerPath);
  return [...new Set(stored)].filter((p) => p !== owner).sort();
}
