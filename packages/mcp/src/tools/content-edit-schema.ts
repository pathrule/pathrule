// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Shared zod schema for the `content_edit` field on update_memory / update_rule /
 * update_skill. A surgical delta the server applies against the item's current
 * body, so the caller never re-sends the whole content just to change part of it.
 */
export const contentEditSchema = z
  .discriminatedUnion("op", [
    z
      .object({ op: z.literal("append"), text: z.string().min(1) })
      .describe("Append text to the end of the body (a blank line is inserted before it)."),
    z
      .object({ op: z.literal("prepend"), text: z.string().min(1) })
      .describe("Prepend text to the start of the body (a blank line is inserted after it)."),
    z
      .object({ op: z.literal("str_replace"), find: z.string().min(1), replace: z.string() })
      .describe(
        "Replace the SINGLE occurrence of `find` with `replace`. `find` must match exactly once — add surrounding context if it appears multiple times.",
      ),
    z
      .object({ op: z.literal("replace_section"), heading: z.string().min(1), body: z.string() })
      .describe(
        "Replace a whole markdown section: `heading` (its text, with or without leading #s) is preserved and everything under it up to the next same-or-higher heading becomes `body`.",
      ),
  ])
  .describe(
    "Surgical edit applied to the CURRENT body server-side — send only the delta instead of the whole content. Mutually exclusive with `content`. Ops: append | prepend | str_replace | replace_section.",
  );
