// Tools that are about the run itself: the plan, verdicts, notes, questions to the user.

import { askQuestion, getRun, pushEvent, saveScreenshot, setPlan } from "../../store";
import { type PlanGroup } from "../../types";
import { type ReportStatus } from "../context";
import { captureEvidence } from "../page";
import { redact, stripRefs } from "../redact";
import { type ToolDef } from "../tool";

export const planTools: ToolDef[] = [
  {
    schema: {
      name: "set_plan",
      description:
        "First call of the run. One group per test case; each step is the tester's step (action and expected result) without a leading number. Preconditions are not steps.",
      input_schema: {
        type: "object",
        properties: {
          groups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "Test case title; omit if it has none." },
                steps: { type: "array", items: { type: "string" } },
              },
              required: ["steps"],
            },
          },
        },
        required: ["groups"],
      },
    },
    run: async (input, ctx) => {
      const { runId } = ctx;
      // tolerate sloppy formats: accept steps as a newline-separated string too
      const toSteps = (v: unknown): string[] =>
        Array.isArray(v)
          ? v.map((s) => String(s).trim()).filter(Boolean)
          : typeof v === "string"
            ? v.split("\n").map((s) => s.trim()).filter(Boolean)
            : [];

      let groups: PlanGroup[];
      if (Array.isArray(input.groups)) {
        groups = (input.groups as unknown[])
          .map((g) => {
            const obj = (g ?? {}) as { title?: unknown; steps?: unknown };
            return {
              title:
                typeof obj.title === "string" && obj.title.trim()
                  ? obj.title.trim()
                  : undefined,
              steps: toSteps(obj.steps),
            };
          })
          .filter((g) => g.steps.length > 0);
      } else {
        const flat = toSteps(input.steps);
        groups = flat.length ? [{ steps: flat }] : [];
      }

      // reject an empty plan loudly — otherwise the UI shows no steps and
      // report_step would append them one by one
      if (groups.length === 0) {
        return {
          content:
            'Error: set_plan received no steps. Call set_plan again with groups=[{title:"TC-01...", steps:["step one", "step two", ...]}] — steps must be a non-empty array of strings.',
        };
      }

      setPlan(runId, groups);
      ctx.step.current = 1;

      const lines: string[] = [];
      let n = 0;
      for (const g of groups) {
        if (g.title) lines.push(g.title);
        for (const s of g.steps) lines.push(`  ${++n}) ${s}`);
      }
      return { content: `OK: plan set (${n} steps):\n${lines.join("\n")}` };
    },
  },

  {
    schema: {
      name: "note",
      description:
        "Save a fact you will need later: a value to compare, an id, a state before a change. Notes stay in your context for the whole run; old page trees do not.",
      input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    run: async (input) => {
      const text = String(input.text ?? "").trim();
      return { content: text ? "OK: noted — it stays in your context." : "Error: text is required." };
    },
  },

  {
    schema: {
      name: "ask_user",
      description:
        "Ask the user for ONE value the test case does not give and you cannot know: a login, phone, OTP, captcha. Name the field on screen.",
      input_schema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "What to enter, e.g. 'Enter the SMS code'." },
          secret: { type: "boolean", description: "true for passwords and codes." },
        },
        required: ["prompt"],
      },
    },
    run: async (input, ctx) => {
      const { runId } = ctx;
      const prompt = String(input.prompt ?? "");
      const secret = Boolean(input.secret);
      const answer = await askQuestion(runId, prompt, secret);
      if (secret && answer) ctx.secrets.add(answer);
      return {
        content: answer,
        observation: secret ? "User entered a secret value" : `User replied: ${answer}`,
      };
    },
  },

  {
    schema: {
      name: "report_step",
      description:
        "Record the verdict of one step, AFTER you have seen the result of its actions. Screenshot for fail/warn is automatic.",
      input_schema: {
        type: "object",
        properties: {
          // Order matters: the model writes the fields in this order, so it states
          // what it saw BEFORE it commits to a verdict. With status first it picked
          // the verdict and then wrote evidence to fit it.
          num: { type: "number", description: "Step number from the plan." },
          expected: { type: "string", description: "Expected result of the step, copied from the test case." },
          evidence: {
            type: "string",
            description:
              "What you actually saw, one or two sentences: a verbatim quote from the page, a request and its status, a dialog text. For a 'changed / did not change' check give the value before and after for every element checked.",
          },
          status: {
            type: "string",
            enum: ["pass", "fail", "warn"],
            description: "Decided from the evidence you just wrote: pass only if it shows the expected result.",
          },
          description: { type: "string", description: "Only if the step went differently from the plan: one line saying what was done." },
        },
        required: ["num", "evidence", "status"],
      },
    },
    run: async (input, ctx) => {
      const { page, runId } = ctx;
      const status = input.status as ReportStatus;
      // The model sometimes sends no num, a null or a number outside the plan.
      // Taken at face value that step lands outside the plan as a stray card and
      // every later event loses its step, so fall back to the next unreported one.
      const plan = getRun(runId)?.steps ?? [];
      let num = Number(input.num);
      if (!Number.isInteger(num) || (plan.length > 0 && !plan.some((s) => s.num === num))) {
        num = ctx.step.current;
      }
      const planned = plan.find((s) => s.num === num);
      if (plan.length > 0 && !planned) {
        return {
          content: `Error: the plan has ${plan.length} steps and all of them are reported. Call finish.`,
        };
      }
      if (planned && planned.status !== "queued") {
        const next = plan.find((s) => s.status === "queued");
        return {
          content: `Error: step ${num} is already reported as ${planned.status} — each step is reported exactly once. ${next ? `Go on with step ${next.num}: "${next.description}".` : "All steps are reported — call finish."}`,
        };
      }
      // JPEG goes to the store and is served via a separate GET — never inlined in events/SSE
      let screenshot: string | undefined;
      if (status === "fail" || status === "warn") {
        const buf = await captureEvidence(page);
        if (buf) {
          saveScreenshot(runId, num, buf);
          screenshot = `/api/run/${runId}/shot/${num}`;
        }
      }
      const clean = (v: unknown) => redact(ctx, stripRefs(String(v))).trim();
      // console errors since the previous step: a note for the reader, not a verdict —
      // third-party scripts make most consoles noisy, so they never change the status
      const consoleErrors = ctx.net.takeConsoleErrors().slice(0, 5).map((e) => redact(ctx, e));
      const step = {
        num,
        // the card keeps the tester's wording from the plan unless the model says the step went differently
        description:
          (input.description ? clean(input.description).replace(/^\s*\d+[.)]\s*/, "") : "") ||
          planned?.description ||
          `Step ${num}`,
        status,
        expected: input.expected ? clean(input.expected) : undefined,
        evidence: input.evidence ? clean(input.evidence) : undefined,
        screenshot,
        consoleErrors: consoleErrors.length ? consoleErrors : undefined,
        // a made-up response body whose shape was never compared to a real one
        // answered a request on this step — the reader should know before trusting a fail
        mockUnverified: ctx.net.takeUnverifiedMockHits() > 0 || undefined,
      };
      pushEvent(runId, { ts: Date.now(), kind: "step", step, stepNum: num });
      // the next step to work on is the first one still queued, not blindly num + 1
      const upcoming = plan.find((s) => s.num !== num && s.status === "queued");
      ctx.step.current = upcoming?.num ?? num + 1;
      return {
        content: `OK: step ${step.num} = ${step.status}. ${upcoming ? `Next: step ${upcoming.num} — "${upcoming.description}".` : "That was the last step — call finish."}`,
      };
    },
  },

  {
    schema: {
      name: "finish",
      description: "End the run after the last step is reported.",
      input_schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["passed", "failed"] },
          summary: { type: "string", description: "1–2 sentences, in the language of the test case." },
        },
        required: ["status", "summary"],
      },
    },
    run: async (input, ctx) => {
      const { runId } = ctx;
      const status = (input.status as string) === "passed" ? "passed" : "failed";
      pushEvent(runId, {
        ts: Date.now(),
        kind: "done",
        status,
        summary: redact(ctx, stripRefs(String(input.summary ?? ""))),
      });
      return { content: "OK: run finished", finished: true };
    },
  },
];
