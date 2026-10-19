// SPDX-License-Identifier: Apache-2.0
// pathrule:// URI scheme (design spec §3 key decision):
//   pathrule://<workspaceId>/<kind>/<id>/<slug>.md
// The slug is display-only; identity is (workspaceId, kind, id). Pure module.

export type ContentKind = "memory" | "rule" | "skill";

export interface ContentRef {
  workspaceId: string;
  kind: ContentKind;
  id: string;
}

export interface ContentUriParts {
  scheme: "pathrule";
  authority: string;
  path: string;
}

const KINDS: ReadonlySet<string> = new Set(["memory", "rule", "skill"]);

export function contentUriParts(ref: ContentRef, label: string): ContentUriParts {
  return {
    scheme: "pathrule",
    authority: ref.workspaceId,
    path: `/${ref.kind}/${ref.id}/${slugify(label)}.md`,
  };
}

export function parseContentUri(authority: string, path: string): ContentRef | null {
  const segments = path.replace(/^\//, "").split("/");
  const [kind, id] = segments;
  if (!authority || !kind || !id || !KINDS.has(kind)) return null;
  return { workspaceId: authority, kind: kind as ContentKind, id };
}

export function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "untitled";
}
