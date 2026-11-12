// State and types shared by the agent loop and the tool handlers.

import { type BrowserContext, type Page } from "playwright";
import { type StoredFile } from "../attachments";
import { NetworkMonitor } from "../network";

export type ReportStatus = "pass" | "fail" | "warn";

export interface ToolContext {
  runId: string;
  /** The active tab. Replaced when an action opens a new tab or switch_tab is called. */
  page: Page;
  context: BrowserContext;
  net: NetworkMonitor;
  step: { current: number };
  files: StoredFile[];
  /** A tab opened by the page that the agent hasn't been moved to yet. */
  incoming: Page | null;
  /** The page tree the model saw last — the next result says what changed against it. */
  lastTree: string | null;
  /** false for all but the last page action of a turn: only that one returns the page tree. */
  wantTree: boolean;
  /** When the current tool call started — settling waits only for requests sent after it. */
  actionStarted: number;
  /** One-shot answer for the next native dialog, set by handle_dialog. */
  dialogPolicy: { action: "accept" | "dismiss"; text?: string } | null;
  /** Things that happened on their own (dialog, new tab) — prepended to the next tool result. */
  notices: string[];
  /** Values typed into password fields or given as secret answers — masked in everything the UI shows. */
  secrets: Set<string>;
}

export interface ToolResult {
  content: string;
  observation?: string;
  finished?: boolean;
}

/** One tool: what the model sent, the run's state, and what goes back to the model. */
export type Handlers = Record<
  string,
  (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
>;

// Playwright prefixes refs of elements inside a (same-origin) iframe with the
// iframe's frame sequence, e.g. "f1e2" — plain "e12" is only the main frame.
export const REF_RE = /^(?:f\d+)?e\d+$/;

// Tools that act on the page and return its tree through actionResult.
export const PAGE_ACTIONS = new Set([
  "navigate", "click", "fill", "select", "hover", "press", "scroll", "scroll_to",
  "dismiss", "wait", "wait_for", "upload_file", "switch_tab",
]);
