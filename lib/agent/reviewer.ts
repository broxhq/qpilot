// A second opinion on every pass.
//
// The model that performs a step also judges it, with the whole run in its
// context — and it tends to see what it set out to see. So each "pass" is handed
// to a reviewer: the same model with a clean context, given only the step, the
// agent's claim and what the tools actually returned while the step ran.
//
// The reviewer cannot pass or fail a step. It can only object, and an objection
// turns the pass into a warn with the reason next to it — a person decides.
// It runs alongside the agent, not in its way: nothing waits for it until finish.

import { appendFile } from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { addStats, getRun, pushEvent, saveScreenshot } from "../store";
import { askText, type ProviderConfig } from "../provider";
import { redact, stripRefs } from "./redact";
import type { ToolContext } from "./context";

const REVIEW_TIMEOUT_MS = 30_000;

// What one tool call may contribute to the record, and the record as a whole.
const MAX_FACT_CHARS = 3_000;
const MAX_FACTS_CHARS = 14_000;
const MAX_TREE_CHARS = 14_000;

// Calls that are about the run, not about the page: nothing for a reviewer in them.
const NOT_FACTS = new Set(["set_plan", "report_step", "finish"]);

const SYSTEM = `You review one verdict of a QA agent that runs manual test cases in a browser.

The agent performed a step and reported it as PASS. You get the test case, the step, the agent's evidence, and the records: what the agent's tools returned while it worked on the step, and the page tree as the agent last saw it. The records are the facts. The agent's evidence is a claim.

Decide whether the facts show the expected result of THIS step. Answer with one JSON object and nothing else:
{"verdict": "confirmed" | "contradicted" | "cannot_tell", "reason": "<one sentence>"}

- confirmed — the records show the expected result.
- contradicted — the records show the expected result does NOT hold: the page or the requests say something different from what is expected, or what the evidence cites is not in the records and they show something else in its place.
- cannot_tell — the records are not enough to decide: the evidence is about something seen on a screenshot, a state that was on screen only briefly, a value the records do not carry.

Rules:
- Judge only the expected result of this step. Other steps and anything else on the page are not your concern.
- Wording differences do not matter; meaning does. "Shown: Order created" confirms "a success message appears".
- contradicted needs a fact you can point to. If you are not sure, answer cannot_tell.
- reason: one sentence in the language of the test case, quoting the fact you rely on.`;

type Verdict = "confirmed" | "contradicted" | "cannot_tell";

/** The first JSON object in the answer; models wrap it in prose or a code fence. */
function parseVerdict(answer: string): { verdict: Verdict; reason: string } | null {
  const raw = answer.match(/\{[\s\S]*\}/)?.[0];
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as { verdict?: unknown; reason?: unknown };
    if (obj.verdict !== "confirmed" && obj.verdict !== "contradicted" && obj.verdict !== "cannot_tell") return null;
    return { verdict: obj.verdict, reason: String(obj.reason ?? "").trim() };
  } catch {
    return null;
  }
}

/** A tool result without the page tree in it: the tree is given to the reviewer once, not per action. */
function withoutTree(name: string, input: Record<string, unknown>, text: string): string {
  // a block read on purpose (snapshot near) is evidence in itself
  if (name === "snapshot" && typeof input.near === "string") return text;
  if (text.startsWith("URL: ")) return "(the page tree was read)";
  const at = text.indexOf("\n\nURL: ");
  return at >= 0 ? text.slice(0, at) : text;
}

export class Reviewer {
  /** What the tools returned since the last reported step. */
  private facts: string[] = [];
  private pending: Promise<void>[] = [];
  // an escape hatch, not a setting
  private readonly enabled = !["0", "false"].includes(process.env.QPILOT_REVIEW ?? "");

  get on(): boolean {
    return this.enabled;
  }

  constructor(
    private readonly cfg: ProviderConfig,
    private readonly client: Anthropic | null,
    private readonly testCase: string,
  ) {}

  /** Keep what a tool call returned, for the review of the step it belongs to. */
  record(name: string, input: Record<string, unknown>, result: string): void {
    if (!this.enabled || NOT_FACTS.has(name)) return;
    const args = JSON.stringify(input).slice(0, 300);
    const body = withoutTree(name, input, result).trim().slice(0, MAX_FACT_CHARS);
    this.facts.push(`${name} ${args}\n→ ${body}`);
  }

  /**
   * Called when a step is reported. For a pass, asks for the second opinion in
   * the background; either way the record starts over for the next step.
   */
  review(
    ctx: ToolContext,
    step: { num: number; description: string; expected?: string; evidence?: string; status: string },
    shot: Buffer | undefined,
  ): void {
    const facts = this.facts;
    this.facts = [];
    if (!this.enabled || step.status !== "pass") return;

    // the latest records matter most: drop from the front when there are too many
    let record = facts.map((f, i) => `${i + 1}. ${f}`).join("\n\n");
    if (record.length > MAX_FACTS_CHARS) record = "…\n" + record.slice(-MAX_FACTS_CHARS);
    const tree = stripRefs(ctx.lastTree ?? "").slice(0, MAX_TREE_CHARS);

    const question = [
      "Test case:\n```\n" + this.testCase + "\n```",
      `Step under review: ${step.num}) ${step.description}`,
      `Expected result, as the agent restated it: ${step.expected ?? "(not given — take it from the test case)"}`,
      `Agent's verdict: PASS\nAgent's evidence: ${step.evidence ?? "(none)"}`,
      "Records — what the tools returned while the agent worked on this step, in order:\n" + (record || "(no tool calls)"),
      "The page tree as the agent last saw it:\n" + (tree || "(none)"),
    ].join("\n\n");

    this.pending.push(this.ask(ctx, step.num, question, shot).catch(() => {}));
  }

  private async ask(ctx: ToolContext, num: number, question: string, shot: Buffer | undefined): Promise<void> {
    const { runId } = ctx;
    const res = await askText(this.cfg, this.client, SYSTEM, question, REVIEW_TIMEOUT_MS);
    // the call runs beside the agent's own, so its time is not added to modelMs —
    // that would count the same seconds twice
    addStats(runId, { calls: 1, inputTokens: res.inputTokens, outputTokens: res.outputTokens });

    // QPILOT_REVIEW_LOG=<file>: every question and answer, to audit the reviewer itself
    const log = process.env.QPILOT_REVIEW_LOG;
    if (log) await appendFile(log, JSON.stringify({ runId, num, question, answer: res.text }) + "\n").catch(() => {});

    const opinion = parseVerdict(res.text);
    if (opinion?.verdict !== "contradicted") return;
    const current = getRun(runId)?.steps.find((s) => s.num === num);
    if (!current || current.status !== "pass") return;

    let screenshot: string | undefined;
    if (shot) {
      saveScreenshot(runId, num, shot);
      screenshot = `/api/run/${runId}/shot/${num}`;
    }
    pushEvent(runId, {
      ts: Date.now(),
      kind: "step",
      stepNum: num,
      step: {
        ...current,
        status: "warn",
        screenshot,
        reviewer: redact(ctx, stripRefs(opinion.reason)) || "—",
      },
    });
  }

  /** Wait for the opinions still on their way — before the run is closed. */
  async settle(): Promise<void> {
    await Promise.allSettled(this.pending.splice(0));
  }
}
