// "stopped": the user ended the run. The verdicts given so far stand; the rest was not run.
export type RunStatus = "running" | "waiting" | "paused" | "passed" | "failed" | "error" | "stopped";

export type StepStatus = "queued" | "pass" | "fail" | "warn" | "skipped";

/**
 * A request the verdict of a step rests on, as the request log has it: what a
 * tester would show from the Network tab. Secrets are masked before it gets here.
 */
export interface RequestProof {
  method: string;
  url: string;
  /** Resource type as the Network tab names it: fetch, xhr, ping (sendBeacon), image… */
  type: string;
  status?: number;
  failed?: string;
  mocked?: boolean;
  /** The agent's action that preceded the request. */
  after: string;
  requestBody?: string;
  responseBody?: string;
}

/**
 * A literal condition of a step's expected result, run by the framework: a text
 * on the page, or in the URL or body of a request. `present` is what was found,
 * `holds` whether that is what the condition asked for.
 */
export interface StepCheck {
  kind: "page_has" | "page_lacks" | "request_has" | "request_lacks";
  text: string;
  /** The request's number in the log, when the check named one. */
  request?: number;
  /** "POST host/path" of the request the check was about, or found the text in. */
  where?: string;
  present: boolean;
  holds: boolean;
}

export interface StepResult {
  num: number;
  description: string;
  status: StepStatus;
  /** Expected result as the test case states it; `evidence` is what was actually seen. */
  expected?: string;
  evidence?: string;
  screenshot?: string;
  /** Conditions of the expected result that the framework ran itself, with what it found. */
  checks?: StepCheck[];
  /** The requests the evidence is about — attached in full, next to the screenshot. */
  requests?: RequestProof[];
  /** JS console errors logged while the step ran — shown as a note, never changes the status. */
  consoleErrors?: string[];
  /** A mock with a guessed response shape answered a request on this step. */
  mockUnverified?: boolean;
  /** The agent said pass, the second opinion objected (see lib/agent/reviewer.ts): why. The status is then warn. */
  reviewer?: string;
  /**
   * The framework closed the step: the agent spent its actions without a verdict.
   * Such a step is a warn — nothing was shown to be broken — but the run is not a pass.
   */
  cutOff?: boolean;
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
    | { type: "flash"; message: string }
    | { type: "session" }
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
