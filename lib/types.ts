export type RunStatus = "running" | "waiting" | "paused" | "passed" | "failed" | "error";

export type StepStatus = "queued" | "pass" | "fail" | "warn" | "skipped";

export interface StepResult {
  num: number;
  description: string;
  status: StepStatus;
  evidence?: string;
  screenshot?: string;
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
}

export interface Run {
  id: string;
  createdAt: number;
  status: RunStatus;
  title: string;
  testCase: string;
  /** Language of the test case — the run page renders in it. See lib/i18n.ts. */
  language: "ru" | "en";
  events: RunEvent[];
  steps: StepResult[];
  attachments: Attachment[];
  summary?: string;
  pending?: PendingQuestion | null;
}
