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
  events: RunEvent[];
  steps: StepResult[];
  summary?: string;
  pending?: PendingQuestion | null;
}
