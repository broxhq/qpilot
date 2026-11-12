// Every tool the model can call, by name. Schemas live in lib/tools.ts.

import type { Handlers, ToolContext, ToolResult } from "../context";
import { actionHandlers } from "./actions";
import { networkHandlers } from "./network";
import { planHandlers } from "./plan";

const HANDLERS: Handlers = { ...planHandlers, ...actionHandlers, ...networkHandlers };

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const handler = HANDLERS[name];
  return handler ? handler(input, ctx) : { content: `Unknown tool: ${name}` };
}
