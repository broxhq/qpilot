import type { StepResult } from "./types";

export interface StepGroup {
  title?: string;
  steps: StepResult[];
}

/** Steps as the run page and the report show them: consecutive steps of one test case together. */
export function groupSteps(steps: StepResult[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (const s of steps) {
    const last = groups[groups.length - 1];
    if (last && last.title === s.group) last.steps.push(s);
    else groups.push({ title: s.group, steps: [s] });
  }
  return groups;
}
