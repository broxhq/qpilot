// A scripted stand-in for the model: an OpenAI-compatible endpoint that answers
// each call with the next turn of a fixed script. It makes a run deterministic,
// so the agent loop, the tools and the report can be checked without a real model.
//
// A turn is a function of the latest page tree (to pick refs out of it) that
// returns the tool calls to make.

import http from "node:http";

const call = (name, args = {}) => ({
  id: `call_${Math.random().toString(36).slice(2, 10)}`,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

/** `ref(tree, /switch "Ad labelling"/)` → "e9" */
export function ref(tree, pattern) {
  // the result also lists what changed, without refs — only tree lines carry them
  const line = tree.split("\n").find((l) => pattern.test(l) && /\[ref=(?:f\d+)?e\d+\]/.test(l));
  const found = line?.match(/\[ref=((?:f\d+)?e\d+)\]/)?.[1];
  if (!found) throw new Error(`No element matching ${pattern} in the page tree:\n${tree}`);
  return found;
}

/**
 * Starts the model on a free port. `requests` keeps every request body, so a
 * test can look at what the agent sent; `visionChecks` keeps the "can you see?"
 * questions and `reviews` the second-opinion questions separately. `review(body)`
 * may return the reviewer's answer; by default every pass is confirmed.
 */
export function startModel(script, { review } = {}) {
  const requests = [];
  const visionChecks = [];
  const reviews = [];
  let turn = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method !== "POST") return res.end('{"data":[{"id":"scripted"}]}');
      const body = JSON.parse(raw);
      // a request without tools is not a turn of the run. With a picture it is the
      // agent asking "can you see this?" — a scripted model cannot, and says so.
      // Without one it is a pass handed over for a second opinion.
      if (!body.tools) {
        const answer = (content) => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
        if (body.messages.some((m) => Array.isArray(m.content))) {
          visionChecks.push(body);
          return answer("I cannot see images.");
        }
        reviews.push(body);
        return answer(review?.(body) ?? '{"verdict":"confirmed","reason":"The records show it."}');
      }
      requests.push(body);
      const results = body.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
      const tree = [...results].reverse().find((r) => /\[ref=/.test(r)) ?? "";
      const step = script[turn++];
      let calls;
      try {
        calls = step ? step(tree, call) : [call("finish", { status: "failed", summary: "The script ran out of turns." })];
      } catch (err) {
        calls = [call("finish", { status: "failed", summary: `Script error: ${err.message}` })];
      }
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "", tool_calls: calls }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, requests, visionChecks, reviews, close: () => server.close() })),
  );
}
