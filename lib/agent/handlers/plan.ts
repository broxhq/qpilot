// Tools that are about the run itself: the plan, verdicts, notes, questions to the user.

import { askQuestion, getRun, pushEvent, saveScreenshot, setPlan } from "../../store";
import { dict } from "../../i18n";
import { type PlanGroup, type RequestProof } from "../../types";
import { runChecks } from "../checks";
import { type ReportStatus } from "../context";
import { captureEvidence } from "../page";
import { FLASH_NOTE } from "../flash";
import { redact, redactDeep, stripRefs } from "../redact";
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

      // A plan longer than the test case is the model making a step out of an
      // expected result ("Press Save" + "the status shows Saved"): the report then
      // has two steps where the tester wrote one. The count is a fact of the text,
      // so it is stated — once; the same plan sent again is taken as meant.
      const numbered = (getRun(runId)?.testCase ?? "").split("\n").filter((l) => /^\s*\d+[.)]\s+\S/.test(l)).length;
      const planned = groups.reduce((n, g) => n + g.steps.length, 0);
      if (numbered > 0 && planned > numbered && !ctx.planQueried) {
        ctx.planQueried = true;
        return {
          content:
            `Error: the plan was not set. The test case numbers ${numbered} step(s) and your plan has ${planned}. ` +
            "A step and its expected result are ONE plan step: the expected result is what you check on that step, not a step of its own. Preconditions are not steps either. " +
            `Call set_plan again with one plan step per numbered step. If the test case really has ${planned} steps, send the same plan again and it will be accepted.`,
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
              "What you actually saw, one or two sentences: a verbatim quote from the page, a request and its status, a dialog text. For a 'changed / did not change' check give the value before and after for every element checked. For a step about several items, one clause per item.",
          },
          checks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["page_has", "page_lacks", "request_has", "request_lacks"] },
                text: { type: "string", description: "The exact text: as the page shows it, or as it stands in the request's URL or body." },
                request: { type: "number", description: "For request_has / request_lacks: the #number of the request. Leave out to look in every request." },
              },
              required: ["kind", "text"],
            },
            description:
              "The expected result put as literal conditions, when it can be: a text that must (page_has) or must not (page_lacks) be on the page, a field or value that must (request_has) or must not (request_lacks) be in a request. The framework runs them on the real page and the request log and records what it found next to your verdict. A pass needs every one of them to hold.",
          },
          requests: {
            type: "array",
            items: { type: "number" },
            description:
              "When the evidence is a request (sent / not sent, a field in its body, its status): the #numbers of up to 3 such requests, from get_requests or \"After this action\". They are attached to the step in full — quote only the telling part in evidence.",
          },
          not_checked: {
            type: "array",
            items: { type: "string" },
            description:
              "Only for a step that covers several items (each, every, all, a list of values): the items you did NOT check. Leave it out when you checked every one.",
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
      // something (a toast, an error line) that came and went after the model's last look: the verdict was
      // written without it. The note itself is put in front of this answer.
      if (ctx.notices.some((n) => n.startsWith(FLASH_NOTE))) {
        return {
          content:
            "Error: not recorded. Something appeared on the page and vanished after your last look — it is in the NOTE above. Take it into account and call report_step again.",
        };
      }
      const clean = (v: unknown) => redact(ctx, stripRefs(String(v))).trim();
      // The conditions the model named are run on the real page and the request
      // log. A pass with one that does not hold is turned down once, with what is
      // there instead; reported as pass again, it is recorded as a warn.
      const ran = await runChecks(ctx, input.checks);
      const broken = status === "pass" ? ran.filter((c) => !c.holds) : [];
      if (broken.length > 0 && ctx.checksQueried !== num) {
        ctx.checksQueried = num;
        return {
          content:
            "Error: not recorded. The framework ran your checks on the page and the request log. A pass needs every one of them to hold, and these do not:\n" +
            broken.map((c) => `- ${c.kind} "${c.text}": ${c.note ?? "does not hold"}`).join("\n") +
            "\nRead what is there. If the expected result does not hold, report the step as fail and quote what the page or the request shows. If a check was worded wrongly, correct it. A pass reported again with a check that does not hold is recorded as warn.",
        };
      }
      const disputed = broken.length > 0;
      // "Repeat for every country" judged on one country is not a pass: the
      // agent says what it left out, and the framework draws the conclusion.
      const skipped = Array.isArray(input.not_checked)
        ? input.not_checked.map((v) => clean(v)).filter(Boolean).slice(0, 30)
        : [];
      const partial = (status === "pass" && skipped.length > 0) || disputed;
      const words = dict(getRun(runId)?.language);
      const coverage =
        (skipped.length ? ` ${words.notChecked}: ${skipped.join(", ")}.` : "") +
        (disputed ? ` ${words.checkFailed}: ${broken.map((c) => `«${redact(ctx, c.text)}»`).join(", ")}.` : "");
      // JPEG goes to the store and is served via a separate GET — never inlined in events/SSE
      let screenshot: string | undefined;
      const flashShot = ctx.flashShot;
      ctx.flashShot = null;
      if (status === "fail" || status === "warn" || partial) {
        // the page with the message still on it says more than the page after it
        const buf = flashShot ?? (await captureEvidence(page));
        if (buf) {
          saveScreenshot(runId, num, buf);
          screenshot = `/api/run/${runId}/shot/${num}`;
        }
      }
      // a pass gets a second opinion; if it objects, the step needs the page as it was now
      const passShot = status === "pass" && !partial && ctx.reviewer.on ? await captureEvidence(page) : undefined;
      // console errors since the previous step: a note for the reader, not a verdict —
      // third-party scripts make most consoles noisy, so they never change the status
      const consoleErrors = ctx.net.takeConsoleErrors().slice(0, 5).map((e) => redact(ctx, e));
      // the requests the verdict is about go with the step: a screenshot of the
      // page does not show that a field is missing from a request body
      const named = [
        ...(Array.isArray(input.requests) ? input.requests : input.requests == null ? [] : [input.requests]).map((v) => Number(String(v).replace(/^#/, ""))),
        // a request a check was about is evidence as well
        ...ran.flatMap((c) => (c.request === undefined ? [] : [c.request])),
      ]
        .filter((n, i, all) => Number.isInteger(n) && all.indexOf(n) === i)
        .slice(0, 5);
      ctx.flashSeen = [];
      ctx.seenTexts = [];
      ctx.checksQueried = null;
      const checks = ran.map((c) => ({ kind: c.kind, text: redact(ctx, c.text), request: c.request, where: c.where, present: c.present, holds: c.holds }));
      const requests = ctx.net.proof(named, String(input.evidence ?? "")).map((r) => redactDeep(ctx, r) as RequestProof);
      const step = {
        num,
        // the card keeps the tester's wording from the plan unless the model says the step went differently
        description:
          (input.description ? clean(input.description).replace(/^\s*\d+[.)]\s*/, "") : "") ||
          planned?.description ||
          `Step ${num}`,
        status: partial ? ("warn" as const) : status,
        expected: input.expected ? clean(input.expected) : undefined,
        evidence: input.evidence || coverage ? `${input.evidence ? clean(input.evidence) : ""}${coverage}`.trim() : undefined,
        screenshot,
        checks: checks.length ? checks : undefined,
        requests: requests.length ? requests : undefined,
        consoleErrors: consoleErrors.length ? consoleErrors : undefined,
        // a made-up response body whose shape was never compared to a real one
        // answered a request on this step — the reader should know before trusting a fail
        mockUnverified: ctx.net.takeUnverifiedMockHits() > 0 || undefined,
      };
      pushEvent(runId, { ts: Date.now(), kind: "step", step, stepNum: num });
      // the reviewer reads the model's own words, not the masked copy shown in the UI
      ctx.reviewer.review(
        ctx,
        {
          num,
          description: planned?.description ?? step.description,
          expected: input.expected ? stripRefs(String(input.expected)) : undefined,
          evidence: input.evidence ? stripRefs(String(input.evidence)) : undefined,
          status: partial ? "warn" : status,
        },
        passShot,
      );
      // the next step to work on is the first one still queued, not blindly num + 1
      const upcoming = plan.find((s) => s.num !== num && s.status === "queued");
      ctx.step.current = upcoming?.num ?? num + 1;
      return {
        content: `OK: step ${step.num} = ${step.status}${disputed ? " (recorded as warn, not pass: a check the framework ran does not hold)" : partial ? " (recorded as warn, not pass: part of what the step covers was not checked)" : ""}. ${upcoming ? `Next: step ${upcoming.num} — "${upcoming.description}".` : "That was the last step — call finish."}`,
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
      // second opinions still on their way can change a step — wait before closing the run
      await ctx.reviewer.settle();
      // the sign-ins are on disk by the time the run is shown as finished
      await ctx.persist();
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
