// SPDX-License-Identifier: Apache-2.0
// Shared "full content OR surgical delta" resolution for the three update
// handlers. Each handler already fetches the current row; it hands the current
// body here along with the caller's `content` (full replacement) and/or
// `content_edit` (delta), and gets back the final body to persist — or a typed
// error to surface. Keeps append/str_replace/replace_section semantics identical
// across memory / rule / skill (and therefore across MCP / CLI / VS Code / host).

import { applyContentEdit, type ContentEdit } from "./content-edit.js";
import type { ToolError } from "./types.js";

export type ResolvedContent =
  | { ok: true; content: string | undefined }
  | { ok: false; error: ToolError };

export function resolveEditedContent(params: {
  currentContent: string;
  content?: string;
  contentEdit?: ContentEdit;
}): ResolvedContent {
  const { currentContent, content, contentEdit } = params;
  if (contentEdit && content !== undefined) {
    return {
      ok: false,
      error: { code: "invalid_args", message: "Pass either content or content_edit, not both." },
    };
  }
  if (contentEdit) {
    const res = applyContentEdit(currentContent, contentEdit);
    if (!res.ok) {
      // ContentEdit's own "ambiguous" maps onto the tool layer's invalid_args
      // (the request can't be applied as given); not_found/invalid_args pass through.
      const code = res.code === "ambiguous" ? "invalid_args" : res.code;
      return { ok: false, error: { code, message: res.message } };
    }
    return { ok: true, content: res.content };
  }
  // No edit requested — leave content unchanged (undefined = "don't touch").
  return { ok: true, content };
}
