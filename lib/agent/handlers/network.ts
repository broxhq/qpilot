// Tools for requests and the console: mocks, offline, the request log.

import { type ToolDef } from "../tool";

export const networkTools: ToolDef[] = [
  {
    schema: {
      name: "mock_request",
      description:
        "Intercept requests whose URL matches and control the response. Call BEFORE the action that sends the request. status/body = answer without hitting the server; patch = merge fields into the REAL JSON response; abort = network error; delay_ms = slow it down. Stays active until clear_mocks.",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Part of the URL ('/api/cart') or a glob with * ('*/orders/*')." },
          method: { type: "string" },
          status: { type: "number" },
          body: { type: "string", description: "Response body, usually a JSON string." },
          content_type: { type: "string" },
          patch: { type: "object", description: "Merged into the real response; applied to every item if it is a list." },
          abort: { type: "boolean" },
          delay_ms: { type: "number" },
        },
        required: ["url"],
      },
    },
    run: async (input, ctx) => {
      const url = String(input.url ?? "").trim();
      if (!url) return { content: "Error: url is required — part of the request URL to intercept." };
      // models pass JSON either as a string or as an object — accept both
      const body =
        input.body === undefined || input.body === null
          ? undefined
          : typeof input.body === "string"
            ? input.body
            : JSON.stringify(input.body);
      let patch: unknown = input.patch;
      if (typeof patch === "string") {
        try {
          patch = JSON.parse(patch);
        } catch {
          return { content: "Error: patch must be JSON (an object or a list)." };
        }
      }
      const summary = await ctx.net.addMock({
        url,
        method: typeof input.method === "string" ? input.method : undefined,
        status: Number.isFinite(Number(input.status)) && input.status !== undefined ? Number(input.status) : undefined,
        body,
        contentType: typeof input.content_type === "string" ? input.content_type : undefined,
        patch: patch ?? undefined,
        abort: input.abort === true,
        delayMs: Number(input.delay_ms) || undefined,
      });
      return { content: `OK: ${summary}`, observation: `OK: ${summary.split("\n")[0]}` };
    },
  },

  {
    schema: {
      name: "clear_mocks",
      description: "Remove all mocks; reports how many requests each one matched.",
      input_schema: { type: "object", properties: {} },
    },
    run: async (input, ctx) => {
      const report = ctx.net.describeMocks();
      const n = await ctx.net.clearMocks();
      return { content: `OK: removed ${n} mock(s).\n${report}`, observation: `Removed ${n} mock(s)` };
    },
  },

  {
    schema: {
      name: "set_offline",
      description: "Turn the browser's network off (true) or back on (false).",
      input_schema: { type: "object", properties: { offline: { type: "boolean" } }, required: ["offline"] },
    },
    run: async (input, ctx) => {
      const offline = input.offline !== false;
      await ctx.context.setOffline(offline);
      return { content: `OK: the browser is now ${offline ? "OFFLINE — requests will fail" : "online"}.` };
    },
  },

  {
    schema: {
      name: "get_requests",
      description:
        "The Network tab: recent XHR/fetch calls and page loads with method, URL, status, request body and JSON response. `find` matches the URL or the request body, so an RPC method name works too.",
      input_schema: {
        type: "object",
        properties: {
          find: { type: "string", description: "Text in the URL or request body, e.g. 'orders' or 'getNotifications'." },
          method: { type: "string" },
          failed_only: { type: "boolean", description: "Only failed or 4xx/5xx." },
          limit: { type: "number", description: "Latest N matches, default 15." },
        },
      },
    },
    run: async (input, ctx) => {
      const list = ctx.net.requests({
        find: String(input.find ?? input.url ?? "").trim() || undefined,
        method: typeof input.method === "string" ? input.method : undefined,
        failedOnly: input.failed_only === true,
        limit: Number(input.limit) || undefined,
      });
      const mocks = ctx.net.describeMocks();
      return {
        content: mocks === "No active mocks." ? list : `${list}\n\nActive mocks:\n${mocks}`,
        observation: list.split("\n")[0],
      };
    },
  },

  {
    schema: {
      name: "get_console",
      description: "JavaScript console errors of the whole run.",
      input_schema: { type: "object", properties: {} },
    },
    run: async (input, ctx) => {
      const errors = ctx.net.allConsoleErrors();
      return {
        content: errors.length
          ? `${errors.length} console error(s):\n${errors.map((e) => `- ${e}`).join("\n")}`
          : "No console errors so far.",
        observation: `${errors.length} console error(s)`,
      };
    },
  },
];
