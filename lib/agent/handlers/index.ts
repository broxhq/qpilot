// Every tool the model can call.

import type { ToolContext, ToolResult } from "../context";
import type { ToolDef } from "../tool";
import { actionsTools } from "./actions";
import { networkTools } from "./network";
import { planTools } from "./plan";

// The order the model is given the tools in. It reads them top to bottom, so the
// order is part of the prompt: keep it deliberate rather than whatever the files give.
const ORDER = [
  "set_plan",
  "navigate",
  "snapshot",
  "click",
  "fill",
  "select",
  "hover",
  "press",
  "dismiss",
  "wait_for",
  "wait",
  "scroll_to",
  "scroll",
  "upload_file",
  "switch_tab",
  "handle_dialog",
  "note",
  "mock_request",
  "clear_mocks",
  "set_offline",
  "get_requests",
  "get_console",
  "ask_user",
  "report_step",
  "finish",
];

const byName = new Map<string, ToolDef>(
  [...planTools, ...actionsTools, ...networkTools].map((t) => [t.schema.name, t]),
);
const ordered = ORDER.map((name) => {
  const tool = byName.get(name);
  if (!tool) throw new Error(`Tool "${name}" is listed in ORDER but not defined`);
  return tool;
});
if (ordered.length !== byName.size) {
  throw new Error("A tool is defined but missing from ORDER in lib/agent/handlers/index.ts");
}

/** Schemas sent to the model. */
export const TOOLS = ordered.map((t) => t.schema);

/** Tools that act on the page and return its tree. */
export const PAGE_ACTIONS = new Set(ordered.filter((t) => t.page).map((t) => t.schema.name));

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = byName.get(name);
  return tool ? tool.run(input, ctx) : { content: `Unknown tool: ${name}` };
}
