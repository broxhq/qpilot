// State and types shared by the agent loop and the tool handlers.

import { type BrowserContext, type Page } from "playwright";
import { type StoredFile } from "../attachments";
import { NetworkMonitor } from "../network";
import { type Reviewer } from "./reviewer";

export type ReportStatus = "pass" | "fail" | "warn";

export interface ToolContext {
  runId: string;
  /** The active tab. Replaced when an action opens a new tab or switch_tab is called. */
  page: Page;
  context: BrowserContext;
  net: NetworkMonitor;
  /** Gives a second opinion on every pass — see reviewer.ts. */
  reviewer: Reviewer;
  step: { current: number };
  files: StoredFile[];
  /** The model can be shown screenshots. Turned off mid-run if the endpoint refuses one. */
  vision: boolean;
  /** A tab opened by the page that the agent hasn't been moved to yet. */
  incoming: Page | null;
  /** The page tree the model saw last — the next result says what changed against it. */
  lastTree: string | null;
  /** The same page uncut: changes are looked for here, the model's copy may be cut to the budget. */
  lastFull: string | null;
  /** false for all but the last page action of a turn: only that one returns the page tree. */
  wantTree: boolean;
  /** The tool being run right now. */
  tool: string;
  /** When the current tool call started — settling waits only for requests sent after it. */
  actionStarted: number;
  /** One-shot answer for the next native dialog, set by handle_dialog. */
  dialogPolicy: { action: "accept" | "dismiss"; text?: string } | null;
  /** set_plan has already been told once that the plan has more steps than the test case numbers. */
  planQueried: boolean;
  /** Things that happened on their own (dialog, new tab) — prepended to the next tool result. */
  notices: string[];
  /** The page at the moment a short-lived message was on it — the evidence for the step if it fails. */
  flashShot: Buffer | null;
  /** Writes the browser's sign-ins down for the next run. Called before the run is announced as finished. */
  persist: () => Promise<void>;
  /** Values typed into password fields or given as secret answers — masked in everything the UI shows. */
  secrets: Set<string>;
}

export interface ToolResult {
  content: string;
  /** A JPEG to show the model along with `content` (vision only). */
  image?: Buffer;
  observation?: string;
  finished?: boolean;
  /** One line for the step ledger: what was done and what came of it. */
  brief?: string;
  /** false when the action sent nothing and changed nothing on the page. Unset when that is not known. */
  effect?: boolean;
}

// Playwright prefixes refs of elements inside a (same-origin) iframe with the
// iframe's frame sequence, e.g. "f1e2" — plain "e12" is only the main frame.
export const REF_RE = /^(?:f\d+)?e\d+$/;
