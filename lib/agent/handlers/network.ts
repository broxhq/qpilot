// Tools for requests and the console: mocks, offline, the request log.

import { type Handlers } from "../context";

export const networkHandlers: Handlers = {
  mock_request: async (input, ctx) => {
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

  clear_mocks: async (input, ctx) => {
    const report = ctx.net.describeMocks();
    const n = await ctx.net.clearMocks();
    return { content: `OK: removed ${n} mock(s).\n${report}`, observation: `Removed ${n} mock(s)` };
  },

  set_offline: async (input, ctx) => {
    const offline = input.offline !== false;
    await ctx.context.setOffline(offline);
    return { content: `OK: the browser is now ${offline ? "OFFLINE — requests will fail" : "online"}.` };
  },

  get_requests: async (input, ctx) => {
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

  get_console: async (input, ctx) => {
    const errors = ctx.net.allConsoleErrors();
    return {
      content: errors.length
        ? `${errors.length} console error(s):\n${errors.map((e) => `- ${e}`).join("\n")}`
        : "No console errors so far.",
      observation: `${errors.length} console error(s)`,
    };
  },
};
