// SPDX-License-Identifier: Apache-2.0
import type { z, ZodRawShape } from "zod";

/**
 * A ToolDef wraps a Zod object's raw shape (the mapping of field names
 * to ZodTypes) rather than a fully-built `z.object(...)` — that's the
 * form `McpServer.registerTool` expects so it can derive both the JSON
 * Schema and the runtime parser itself.
 */
export interface ToolDef<
  TArgs = Record<string, unknown>,
  TShape extends ZodRawShape = ZodRawShape,
> {
  name: string;
  title?: string;
  description: string;
  inputSchema: TShape;
  handler: (args: TArgs) => Promise<unknown>;
}

/** Helper that infers `TArgs` from a Zod raw shape so callers don't have to restate types. */
export type InferShape<T extends ZodRawShape> = z.infer<z.ZodObject<T>>;
