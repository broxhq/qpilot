// One tool the model can call: what it is told about it and what happens when it
// calls it — side by side, so the two cannot drift apart.

import type Anthropic from "@anthropic-ai/sdk";
import type { ToolContext, ToolResult } from "./context";

export interface ToolDef {
  schema: Anthropic.Tool;
  /** Acts on the page and returns its tree: only the last such call of a turn reads the page back. */
  page?: true;
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

// Descriptions are part of every model call, so they stay short: what the tool
// does and the one thing that is easy to get wrong. Behaviour rules live in the
// system prompt (prompt.ts).
export const ref = (what = "Element") => ({ type: "string", description: `${what} ref from the latest page tree, e.g. e12` });
export const label = { type: "string", description: "Short human-readable name for the log, e.g. 'Login button'" };
