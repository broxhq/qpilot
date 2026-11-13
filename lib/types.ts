export type RunStatus = "running" | "waiting" | "paused" | "passed" | "failed" | "error";

export type StepStatus = "queued" | "pass" | "fail" | "warn" | "skipped";

export interface StepResult {
  num: number;
  description: string;
  status: StepStatus;
  /** Expected result as the test case states it; `evidence` is what was actually seen. */
  expected?: string;
  evidence?: string;
  screenshot?: string;
  /** JS console errors logged while the step ran — shown as a note, never changes the status. */
  consoleErrors?: string[];
  /** A mock with a guessed response shape answered a request on this step. */
  mockUnverified?: boolean;
  /** The agent said pass, the second opinion objected (see lib/agent/reviewer.ts): why. The status is then warn. */
  reviewer?: string;
  group?: string;
}

export interface PlanGroup {
  title?: string;
  steps: string[];
}

export interface PendingQuestion {
  id: string;
  prompt: string;
  secret: boolean;
}

/**
 * A file the user attached to the run (CSV, image, PDF…) so the agent can feed
 * it to a file input on the page. What the UI sees — the on-disk path stays
 * server-side in the store.
 */
export interface Attachment {
  name: string;
  size: number;
}

export interface RunEvent {
  ts: number;
  kind:
    | "thought"
    | "action"
    | "observation"
    | "info"
    | "plan"
    | "step"
    | "question"
    | "answer"
    | "paused"
    | "resumed"
    | "done"
    | "error";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  step?: StepResult;
  steps?: StepResult[];
  status?: RunStatus;
  summary?: string;
  question?: PendingQuestion;
  stepNum?: number;
  /** For kind "info": what happened on its own, so the UI can say it in the run's language. */
  info?:
    | { type: "newTab" | "tabClosed"; url: string }
    | { type: "dialog"; dialog: string; message: string; accepted: boolean };
}

export interface Run {
  id: string;
  createdAt: number;
  status: RunStatus;
  title: string;
  testCase: string;
  /** Language of the test case — the run page renders in it. See lib/i18n.ts. */
  language: "ru" | "en";
  /** The model of this run can see screenshots (found out by the agent, see lib/agent/vision.ts). */
  vision?: boolean;
  /** false = the run was started with a visible browser ("Run with preview"). */
  headless: boolean;
  events: RunEvent[];
  steps: StepResult[];
  attachments: Attachment[];
  summary?: string;
  pending?: PendingQuestion | null;
  /** Where the run's time went — shown on the run page so a slow model is visible as such. */
  stats?: RunStats;
}

export interface RunStats {
  /** Model round trips. */
  calls: number;
  modelMs: number;
  /** Time spent acting in the browser (clicks, waiting for the page, snapshots). */
  browserMs: number;
  inputTokens: number;
  outputTokens: number;
}
