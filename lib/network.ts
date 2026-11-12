import type { BrowserContext, Page, Request, Route } from "playwright";

// What a manual tester does with Charles / the DevTools Network tab, for the
// agent: substitute or patch responses, fail or slow requests down, and read
// back what the page actually sent and received. One instance per run.
//
// Everything that leaves this module for the model or the UI is masked first:
// request/response bodies routinely carry tokens and passwords.

const MAX_LOG = 300;
const MAX_BODY_CHARS = 1200;
const MAX_CAPTURE_BYTES = 200_000;
const MAX_DELAY_MS = 30_000;
const MAX_CONSOLE = 100;
// A request open for this long is long polling, not a page that is still loading.
const LONG_POLL_MS = 8000;

const SENSITIVE_KEY =
  /pass(word|wd)?|token|secret|authorization|cookie|session|otp|cvv|cvc|api[-_]?key|signature/i;
const MASK = "•••";

export interface MockInput {
  url: string;
  method?: string;
  status?: number;
  body?: string;
  contentType?: string;
  patch?: unknown;
  abort?: boolean;
  delayMs?: number;
}

interface MockRule extends MockInput {
  id: number;
  hits: number;
  match: (url: string) => boolean;
  /** A made-up body installed before any real response for this URL was seen. */
  unverified: boolean;
}

interface LogEntry {
  n: number;
  method: string;
  url: string;
  type: string;
  status?: number;
  failed?: string;
  mocked?: boolean;
  reqBody?: string;
  resBody?: string;
  /** The agent's page action that preceded the request — what tells cause from coincidence. */
  after: string;
  /** Field paths of the real JSON response ("[].name", "user.id") — the shape a mock must match. */
  shape?: string[];
  isList?: boolean;
}

export interface RequestFilter {
  /** Text in the URL or in the request body (RPC APIs name the method in the body). */
  find?: string;
  method?: string;
  failedOnly?: boolean;
  limit?: number;
}

// "/api/cart" is a substring match; a pattern with * is a glob ("*orders/*").
function urlMatcher(pattern: string): (url: string) => boolean {
  if (!pattern.includes("*")) return (url) => url.includes(pattern);
  const re = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
  );
  // a glob without a scheme is meant as "anywhere in the URL"
  const loose = /^https?:/.test(pattern)
    ? re
    : new RegExp(re.source.replace(/^\^/, "").replace(/\$$/, ""));
  return (url) => loose.test(url);
}

function maskDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) =>
        SENSITIVE_KEY.test(k) && val != null && typeof val !== "object"
          ? [k, MASK]
          : [k, maskDeep(val)],
      ),
    );
  }
  return v;
}

/** Mask secrets in a request/response body and cut it to a readable size. */
export function maskBody(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let text = raw;
  try {
    text = JSON.stringify(maskDeep(JSON.parse(raw)));
  } catch {
    // form-encoded or plain text: mask key=value pairs with sensitive names
    text = raw.replace(
      /([\w.-]+)=([^&\s]+)/g,
      (m, k: string) => (SENSITIVE_KEY.test(k) ? `${k}=${MASK}` : m),
    );
  }
  text = text
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, MASK) // JWT
    .replace(/\bBearer\s+[\w.~+/-]+=*/gi, `Bearer ${MASK}`);
  return text.length > MAX_BODY_CHARS
    ? `${text.slice(0, MAX_BODY_CHARS)}… (${text.length} chars total)`
    : text;
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(k)) u.searchParams.set(k, MASK);
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** Field paths of a JSON value, lists collapsed to their first item: "[].name", "user.id". */
function shapeOf(v: unknown, prefix = "", depth = 0, out: string[] = []): string[] {
  if (depth > 3 || out.length >= 80) return out;
  if (Array.isArray(v)) {
    if (v.length) shapeOf(v[0], `${prefix}[]`, depth + 1, out);
  } else if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.push(path);
      shapeOf(val, path, depth + 1, out);
    }
  }
  return out;
}

/** Objects merge recursively, lists and scalars are replaced. */
function deepMerge(base: unknown, patch: unknown): unknown {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (Array.isArray(base) && isObj(patch)) return base.map((item) => deepMerge(item, patch));
  if (!isObj(base) || !isObj(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class NetworkMonitor {
  private mocks: MockRule[] = [];
  private nextMockId = 1;
  private routed = false;
  private log: LogEntry[] = [];
  private byRequest = new WeakMap<Request, LogEntry>();
  private mockedRequests = new WeakSet<Request>();
  private seq = 0;
  private consoleErrors: string[] = [];
  private consoleRead = 0;
  private unverifiedHits = 0;
  private marker = "(nothing yet — before the first action)";
  /** Requests sent and not yet answered, with the time they started. */
  private inflight = new Map<Request, number>();
  private context: BrowserContext;

  constructor(context: BrowserContext) {
    this.context = context;
    context.on("request", (req) => this.onRequest(req));
    context.on("response", (res) => {
      const entry = this.byRequest.get(res.request());
      if (!entry) return;
      entry.status = res.status();
      if (this.mockedRequests.has(res.request())) entry.mocked = true;
      if (entry.type !== "fetch" && entry.type !== "xhr") return;
      const type = res.headers()["content-type"] ?? "";
      const size = Number(res.headers()["content-length"] ?? 0);
      if (!/json|text|xml/.test(type) || size > MAX_CAPTURE_BYTES) return;
      const mocked = this.mockedRequests.has(res.request());
      res.text().then(
        (t) => {
          entry.resBody = maskBody(t);
          if (mocked) return; // only real responses are a reference for mocks
          try {
            const json = JSON.parse(t);
            entry.shape = shapeOf(json);
            entry.isList = Array.isArray(json);
          } catch {}
        },
        () => {},
      );
    });
    context.on("requestfailed", (req) => {
      this.inflight.delete(req);
      const entry = this.byRequest.get(req);
      if (entry) entry.failed = req.failure()?.errorText ?? "failed";
    });
    context.on("requestfinished", (req) => {
      this.inflight.delete(req);
    });
  }

  /**
   * Resolves once no API call or page load started after `since` has been in
   * flight for `quietMs`, or after `maxMs`. Called after every action so the snapshot is
   * taken when the page has answered, not while it is still loading. Requests
   * that have been open for a long time (long polling) don't hold it up.
   */
  async waitForQuiet(since: number, maxMs = 4000, quietMs = 300): Promise<void> {
    const started = Date.now();
    let quietSince = Date.now();
    while (Date.now() - started < maxMs) {
      const now = Date.now();
      // only requests the action itself caused: a page that polls its server
      // every few seconds would otherwise make every action wait the full maxMs
      const busy = [...this.inflight.values()].some((t) => t >= since - 50 && now - t < LONG_POLL_MS);
      if (busy) quietSince = now;
      else if (now - quietSince >= quietMs) return;
      await sleep(80);
    }
  }

  /** Called before every page action: requests from now on are listed as sent after it. */
  mark(action: string): void {
    this.marker = action;
  }

  /** Console errors are per page — call for every page (tab) of the run. */
  wirePage(page: Page): void {
    const push = (text: string) => {
      if (this.consoleErrors.length < MAX_CONSOLE) {
        this.consoleErrors.push(text.length > 300 ? `${text.slice(0, 300)}…` : text);
      }
    };
    page.on("console", (m) => {
      if (m.type() === "error") push(m.text());
    });
    page.on("pageerror", (err) => push(`Uncaught: ${err.message}`));
  }

  private onRequest(req: Request): void {
    const type = req.resourceType();
    // the Network tab filtered to what a tester looks at: API calls and page loads
    if (type !== "fetch" && type !== "xhr" && type !== "document") return;
    const entry: LogEntry = {
      n: ++this.seq,
      method: req.method(),
      url: maskUrl(req.url()),
      type,
      reqBody: maskBody(req.postData()),
      after: this.marker,
    };
    this.inflight.set(req, Date.now());
    this.byRequest.set(req, entry);
    this.log.push(entry);
    if (this.log.length > MAX_LOG) this.log.shift();
  }

  // ── mocks ───────────────────────────────────────────────────────────────────

  /**
   * How a made-up body compares to the last REAL response for the same URL.
   * The model otherwise guesses field names, and a wrong guess looks like a bug
   * in the page ("undefined" in the UI) when it is a bug in the mock.
   */
  private checkAgainstReal(input: MockInput): { verified: boolean; advice: string } {
    if (input.body === undefined || input.abort || input.patch !== undefined) {
      return { verified: true, advice: "" };
    }
    // an error answer is not expected to look like the success response
    if ((input.status ?? 200) >= 400) return { verified: true, advice: "" };
    const match = urlMatcher(input.url);
    const method = input.method?.toUpperCase();
    const real = [...this.log]
      .reverse()
      .find((e) => e.shape && !e.mocked && (!method || e.method === method) && match(e.url));
    if (!real) {
      return {
        verified: false,
        advice:
          "WARNING: no real response for this URL has been seen in this run, so the field names in your body are a guess. If the real request can be made, do it properly: clear_mocks → trigger the request once for real → get_requests to read the response → mock_request again with a body in that shape. Or use patch, which needs no shape. If you keep the guess and the page then shows empty/\"undefined\" values, that is the mock's fault — do not report it as a bug in the page.",
      };
    }
    let mock: unknown;
    try {
      mock = JSON.parse(input.body);
    } catch {
      return {
        verified: true,
        advice: `Real response for this URL (${real.method} → ${real.status}): ${real.resBody ?? ""}\nYour body is not JSON — make sure that is intended.`,
      };
    }
    const sample = `Real response seen for this URL (${real.method} → ${real.status}): ${real.resBody ?? ""}`;
    if (Array.isArray(mock) !== real.isList) {
      return {
        verified: true,
        advice: `${sample}\nMISMATCH: the real response is ${real.isList ? "a list" : "an object"}, your body is ${Array.isArray(mock) ? "a list" : "an object"}. Call mock_request again with a body in the real shape.`,
      };
    }
    const mine = new Set(shapeOf(mock));
    const emptyList = Array.isArray(mock) && mock.length === 0;
    const missing = emptyList ? [] : real.shape!.filter((k) => !mine.has(k));
    const extra = [...mine].filter((k) => !real.shape!.includes(k));
    if (missing.length === 0 && extra.length === 0) {
      return { verified: true, advice: "Your body matches the shape of the real response for this URL." };
    }
    const parts = [sample];
    if (missing.length) parts.push(`Fields of the real response missing from your body: ${missing.slice(0, 20).join(", ")}`);
    if (extra.length) parts.push(`Fields in your body that the real response does not have: ${extra.slice(0, 20).join(", ")}`);
    parts.push("If the page needs those fields, call mock_request again with a corrected body.");
    return { verified: true, advice: parts.join("\n") };
  }

  async addMock(input: MockInput): Promise<string> {
    const check = this.checkAgainstReal(input);
    const rule: MockRule = {
      unverified: !check.verified,
      ...input,
      method: input.method?.toUpperCase(),
      delayMs: input.delayMs ? Math.min(Math.max(0, input.delayMs), MAX_DELAY_MS) : undefined,
      id: this.nextMockId++,
      hits: 0,
      match: urlMatcher(input.url),
    };
    // a body checked against the real response supersedes an earlier guess:
    // the step should not carry the "unverified mock" note once the guess was fixed
    if (check.verified && rule.body !== undefined && (rule.status ?? 200) < 400) {
      this.unverifiedHits = 0;
    }
    this.mocks.push(rule);
    if (!this.routed) {
      await this.context.route("**/*", this.handle);
      this.routed = true;
    }
    const what = rule.abort
      ? "fail with a network error"
      : rule.patch !== undefined
        ? "pass to the server, then patch the JSON response"
        : rule.status !== undefined || rule.body !== undefined
          ? `answer ${rule.status ?? 200} without hitting the server`
          : "pass through";
    const delay = rule.delayMs ? `, delayed by ${rule.delayMs}ms` : "";
    const head = `mock #${rule.id}: ${rule.method ?? "any method"} "${rule.url}" → ${what}${delay}. It applies to requests sent from now on.`;
    return check.advice ? `${head}\n${check.advice}` : head;
  }

  async clearMocks(): Promise<number> {
    const n = this.mocks.length;
    this.mocks = [];
    if (this.routed) {
      await this.context.unroute("**/*", this.handle).catch(() => {});
      this.routed = false;
    }
    return n;
  }

  /** "mock #1 … — matched 2 requests", so the model can tell a mock that never fired. */
  describeMocks(): string {
    if (this.mocks.length === 0) return "No active mocks.";
    return this.mocks
      .map((m) => `mock #${m.id} ${m.method ?? "ANY"} "${m.url}" — matched ${m.hits} request(s)`)
      .join("\n");
  }

  private handle = async (route: Route): Promise<void> => {
    const req = route.request();
    // the newest matching rule wins, so a mock can be overridden mid-run
    const rule = [...this.mocks]
      .reverse()
      .find((m) => (!m.method || m.method === req.method()) && m.match(req.url()));
    if (!rule) return route.fallback();

    rule.hits++;
    if (rule.unverified) this.unverifiedHits++;
    this.mockedRequests.add(req);
    try {
      if (rule.delayMs) await sleep(rule.delayMs);
      if (rule.abort) return await route.abort("failed");

      if (rule.patch !== undefined) {
        const res = await route.fetch();
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          return await route.fulfill({ response: res }); // not JSON — nothing to patch
        }
        return await route.fulfill({
          response: res,
          json: deepMerge(json, rule.patch),
          ...(rule.status !== undefined ? { status: rule.status } : {}),
        });
      }

      if (rule.status !== undefined || rule.body !== undefined) {
        const body = rule.body ?? "";
        const looksJson = /^\s*[[{]/.test(body);
        // a made-up response to a cross-origin API call still has to pass CORS
        const origin = req.headers()["origin"];
        return await route.fulfill({
          status: rule.status ?? 200,
          contentType: rule.contentType ?? (looksJson ? "application/json" : "text/plain"),
          body,
          headers: origin
            ? {
                "access-control-allow-origin": origin,
                "access-control-allow-credentials": "true",
              }
            : undefined,
        });
      }

      return await route.continue(); // delay only
    } catch {
      // page closed or navigated away mid-request — nothing left to answer
      await route.continue().catch(() => {});
    }
  };

  // ── reading back ────────────────────────────────────────────────────────────

  requests(filter: RequestFilter = {}): string {
    const match = filter.find ? urlMatcher(filter.find) : null;
    const inBody = (e: LogEntry) => !!filter.find && !!e.reqBody?.includes(filter.find);
    const method = filter.method?.toUpperCase();
    const limit = Math.min(Math.max(1, filter.limit ?? 15), 40);
    const hits = this.log.filter(
      (e) =>
        (!match || match(e.url) || inBody(e)) &&
        (!method || e.method === method) &&
        (!filter.failedOnly || e.failed || (e.status ?? 0) >= 400),
    );
    if (hits.length === 0) {
      return `No matching requests (${this.log.length} recorded in total). Only XHR/fetch calls and page loads are recorded.`;
    }
    const shown = hits.slice(-limit);
    const lines = shown.map((e) => {
      const outcome = e.failed
        ? `FAILED (${e.failed})`
        : e.status !== undefined
          ? String(e.status)
          : "pending";
      const head = `#${e.n} ${e.method} ${e.url} → ${outcome}${e.mocked ? " [mocked]" : ""}`;
      const parts = [head, `  sent after: ${e.after}`];
      if (e.reqBody) parts.push(`  request body: ${e.reqBody}`);
      if (e.resBody) parts.push(`  response body: ${e.resBody}`);
      return parts.join("\n");
    });
    const more = hits.length > shown.length ? `\n(${hits.length - shown.length} earlier matches not shown — narrow the filter)` : "";
    return `${hits.length} matching request(s), oldest first. "sent after" is your action that preceded the request — a request sent after navigate, or before the step's own action, was not caused by that action:\n${lines.join("\n")}${more}`;
  }

  /** Errors logged since the previous call — for the per-step note in the report. */
  takeConsoleErrors(): string[] {
    const fresh = this.consoleErrors.slice(this.consoleRead);
    this.consoleRead = this.consoleErrors.length;
    return fresh;
  }

  /** Did a guessed-shape mock answer any request since the previous call? */
  takeUnverifiedMockHits(): number {
    const n = this.unverifiedHits;
    this.unverifiedHits = 0;
    return n;
  }

  allConsoleErrors(): string[] {
    return [...this.consoleErrors];
  }
}
