import type { BrowserContext, Page, Request, Route } from "playwright";

// What a manual tester does with Charles / the DevTools Network tab, for the
// agent: substitute or patch responses, fail or slow requests down, and read
// back what the page actually sent and received. One instance per run.
//
// Everything that leaves this module for the model or the UI is masked first:
// request/response bodies routinely carry tokens and passwords.

const MAX_LOG = 300;
// Scripts, styles, images and fonts are kept apart: a page loads hundreds of
// them, and they must not push the API calls out of the journal.
const MAX_ASSETS = 500;
const ASSET_TYPES = new Set(["script", "stylesheet", "image", "font", "media", "manifest", "texttrack"]);
// What is printed of a body, and what is kept of it to search in: an analytics
// batch names the event the tester asks about far past the first screenful.
const MAX_BODY_CHARS = 1200;
const MAX_KEPT_BODY = 40_000;
const MAX_URL_CHARS = 500;
const MAX_CAPTURE_BYTES = 200_000;
const MAX_DELAY_MS = 30_000;
const MAX_CONSOLE = 100;
// A request open for this long is long polling, not a page that is still loading.
const LONG_POLL_MS = 8000;

const MAX_DIGEST_REQUESTS = 5;
const DIGEST_BODY_CHARS = 220;

/** Host and path, without the query: enough to tell which call it was. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 70 ? `…${u.pathname.slice(-70)}` : u.pathname;
    return `${u.host}${path}${u.search ? "?…" : ""}`;
  } catch {
    return url.slice(0, 90);
  }
}

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
  /** Masked and kept long (MAX_KEPT_BODY): searched in full, printed in part. */
  reqBody?: string;
  resBody?: string;
  /** Everything `find` looks through, lower-cased; built on the first search. */
  hay?: string;
  /** The agent's page action that preceded the request — what tells cause from coincidence. */
  after: string;
  /** Field paths of the real JSON response ("[].name", "user.id") — the shape a mock must match. */
  shape?: string[];
  isList?: boolean;
}

export interface RequestFilter {
  /** Text in the URL, its query string or the request body, in any letter case (RPC and analytics APIs name the method or event there). */
  find?: string;
  method?: string;
  /** Resource type as the Network tab names it: fetch, xhr, document, ping, image, script… */
  type?: string;
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

/** Mask secrets in a request/response body. */
function maskText(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let text = raw.length > MAX_KEPT_BODY * 4 ? raw.slice(0, MAX_KEPT_BODY * 4) : raw;
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
    // a JSON fragment inside other text (a form field, a decoded query string)
    .replace(/"([\w.-]+)"(\s*:\s*)"[^"]*"/g, (m, k: string, sep: string) => (SENSITIVE_KEY.test(k) ? `"${k}"${sep}"${MASK}"` : m))
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, MASK) // JWT
    .replace(/\bBearer\s+[\w.~+/-]+=*/gi, `Bearer ${MASK}`);
  return text;
}

/** A text cut to a readable size — around `needle` when it lies past the cut. */
function clip(text: string, max = MAX_BODY_CHARS, needle?: string): string {
  if (text.length <= max) return text;
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0 || at + needle!.length <= max) return `${text.slice(0, max)}… (${text.length} chars total)`;
  const from = Math.max(0, at - Math.floor(max / 4));
  return `…${text.slice(from, from + max)}${from + max < text.length ? "…" : ""} (${text.length} chars total, shown around the match)`;
}

/** Mask secrets in a request/response body and cut it to a readable size. */
export function maskBody(raw: string | null | undefined): string | undefined {
  const text = maskText(raw);
  return text === undefined ? undefined : clip(text);
}

/** A request body as the journal keeps it: masked, long enough to search in. */
function keptBody(raw: string | null | undefined): string | undefined {
  const text = maskText(raw);
  return text && text.length > MAX_KEPT_BODY ? text.slice(0, MAX_KEPT_BODY) : text;
}

function unescapeUrl(text: string): string {
  if (!/%[0-9a-f]{2}/i.test(text)) return "";
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text.replace(/%([0-9a-f]{2})/gi, (m, h: string) => (parseInt(h, 16) < 128 ? String.fromCharCode(parseInt(h, 16)) : m));
  }
}

/**
 * The same request the way a person would read it: the query string and form
 * fields with %XX undone, and base64 values (how several analytics SDKs pack
 * an event) decoded when what comes out is text.
 */
function decodedParts(e: LogEntry): string[] {
  const out: string[] = [];
  for (const raw of [e.url, e.reqBody ?? ""]) {
    const plain = maskText(unescapeUrl(raw)) ?? "";
    if (plain) out.push(plain);
    for (const token of (plain || raw).match(/[A-Za-z0-9+/_-]{24,}={0,2}/g)?.slice(0, 12) ?? []) {
      const text = Buffer.from(token.slice(0, MAX_KEPT_BODY), "base64").toString("utf-8");
      if (text.length >= 12 && /^[\x20-\x7e\s\u00a0-\u04ff]+$/.test(text) && /[{"=:]/.test(text)) out.push(maskText(text) ?? "");
    }
  }
  return out;
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

/** " [ping]" for anything that is not a plain API call or page load: how it was sent is part of the evidence. */
const kindOf = (e: LogEntry) => (e.type === "fetch" || e.type === "xhr" || e.type === "document" ? "" : ` [${e.type}]`);

// what a tester would call the type → what the browser calls it
const TYPE_ALIASES: Record<string, string> = {
  beacon: "ping",
  sendbeacon: "ping",
  img: "image",
  pixel: "image",
  js: "script",
  css: "stylesheet",
  style: "stylesheet",
  doc: "document",
};

/** Everything `find` looks through, lower-cased: the URL and the body as sent, and as they read once decoded. */
function haystack(e: LogEntry): string {
  e.hay ??= [e.url, e.reqBody ?? "", ...decodedParts(e)].join("\n").toLowerCase();
  return e.hay;
}

export class NetworkMonitor {
  private mocks: MockRule[] = [];
  private nextMockId = 1;
  private routed = false;
  /** API calls, page loads, beacons — what the page said to a server. */
  private log: LogEntry[] = [];
  /** Scripts, styles, images, fonts — searched by `find`, not listed by default. */
  private assets: LogEntry[] = [];
  /** Entries pushed out of the two lists: "not found" must say when it has not seen everything. */
  private dropped = 0;
  private byRequest = new WeakMap<Request, LogEntry>();
  private mockedRequests = new WeakSet<Request>();
  private seq = 0;
  private consoleErrors: string[] = [];
  private consoleRead = 0;
  private unverifiedHits = 0;
  private marker = "(nothing yet — before the first action)";
  /** Where the journal and the console stood when the current action began. */
  private markSeq = 0;
  private markConsole = 0;
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
    this.markSeq = this.seq;
    this.markConsole = this.consoleErrors.length;
  }

  /**
   * What followed the action marked last: the requests it sent and what the
   * console said. Handed to the model with the result of every action — "did
   * anything happen, and what did the server answer" is the first thing a
   * tester looks at when a click seems to do nothing.
   */
  sinceMark(): { total: number; calls: number; requests: string[]; consoleErrors: string[] } {
    const sent = this.log.filter((e) => e.n > this.markSeq);
    // what the action submitted says more than what the page fetched afterwards
    const ordered = [...sent.filter((e) => e.method !== "GET"), ...sent.filter((e) => e.method === "GET")];
    const requests = ordered.slice(0, MAX_DIGEST_REQUESTS).map((e) => {
      const outcome = e.failed ? `FAILED (${e.failed})` : e.status !== undefined ? String(e.status) : "pending";
      const telling = e.method !== "GET" || e.failed || (e.status ?? 0) >= 400;
      // a beacon is answered with nothing: what it carried is what there is to read
      const said = e.type === "ping" ? e.reqBody : telling ? e.resBody : undefined;
      const body = said ? ` ${said.replace(/\s+/g, " ").slice(0, DIGEST_BODY_CHARS)}` : "";
      return `${e.method} ${shortUrl(e.url)}${kindOf(e)} → ${outcome}${e.mocked ? " [mocked]" : ""}${body}`;
    });
    return {
      total: sent.length,
      // a beacon is the page telling its analytics about the click, not the page answering it
      calls: sent.filter((e) => e.type !== "ping").length,
      requests,
      consoleErrors: this.consoleErrors.slice(this.markConsole, this.markConsole + 3).map((t) => t.slice(0, 200)),
    };
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
    void this.wireBodies(page);
  }

  /**
   * Playwright has no body for a request whose payload is a Blob — which is how
   * sendBeacon is usually called. The browser does: ask it over the debugging
   * protocol, for the requests that came without one.
   */
  private async wireBodies(page: Page): Promise<void> {
    try {
      const cdp = await this.context.newCDPSession(page);
      await cdp.send("Network.enable");
      cdp.on("Network.requestWillBeSent", (e) => {
        const { request } = e;
        if (!request.hasPostData || request.postData !== undefined) return;
        // a file upload is not something to read back
        const type = Object.entries(request.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
        if (/^multipart\//i.test(String(type))) return;
        cdp.send("Network.getRequestPostData", { requestId: e.requestId }).then(
          ({ postData }) => this.lateBody(request.method, request.url, postData),
          () => {},
        );
      });
    } catch {
      // not Chromium, or the page is already gone: such bodies stay unread
    }
  }

  private lateBody(method: string, url: string, body: string, retry = true): void {
    const masked = maskUrl(url);
    const entry = [...this.log].reverse().find((e) => e.method === method && e.url === masked && e.reqBody === undefined);
    if (entry) {
      entry.reqBody = keptBody(body);
      entry.hay = undefined;
    } else if (retry) {
      // the protocol answered before Playwright announced the request
      setTimeout(() => this.lateBody(method, url, body, false), 250);
    }
  }

  private onRequest(req: Request): void {
    const type = req.resourceType();
    const url = req.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    // The Network tab on "All". It used to be the Fetch/XHR filter, and an
    // analytics event sent with sendBeacon or as an image was "not sent".
    const asset = ASSET_TYPES.has(type);
    const entry: LogEntry = {
      n: ++this.seq,
      method: req.method(),
      url: maskUrl(url),
      type,
      reqBody: asset ? undefined : keptBody(req.postData()),
      after: this.marker,
    };
    // only an API call or a page load is worth waiting for before reading the page
    if (type === "fetch" || type === "xhr" || type === "document") this.inflight.set(req, Date.now());
    this.byRequest.set(req, entry);
    const list = asset ? this.assets : this.log;
    list.push(entry);
    if (list.length > (asset ? MAX_ASSETS : MAX_LOG)) {
      list.shift();
      this.dropped++;
    }
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
    const find = filter.find?.trim();
    const needle = find?.toLowerCase();
    // a pattern with * is a glob over the URL, as in mock_request; plain text is looked for everywhere
    const glob = find?.includes("*") ? urlMatcher(find) : null;
    const method = filter.method?.toUpperCase();
    const type = filter.type ? (TYPE_ALIASES[filter.type.toLowerCase()] ?? filter.type.toLowerCase()) : undefined;
    const limit = Math.min(Math.max(1, filter.limit ?? 15), 40);
    // a search or a named type goes through everything; a plain listing is the calls
    const everything = !!find || !!type;
    const pool = everything ? [...this.log, ...this.assets].sort((a, b) => a.n - b.n) : this.log;
    const hits = pool.filter(
      (e) =>
        (!needle || (glob ? glob(e.url) : haystack(e).includes(needle))) &&
        (!method || e.method === method) &&
        (!type || type === "all" || e.type === type) &&
        (!filter.failedOnly || e.failed || (e.status ?? 0) >= 400),
    );
    const total = this.log.length + this.assets.length;
    const lost = this.dropped
      ? ` ${this.dropped} older request(s) are no longer kept (the journal holds the latest ${MAX_LOG} calls and ${MAX_ASSETS} static files).`
      : "";
    if (hits.length === 0) {
      return `No matching requests${find ? ` for "${find}"` : ""}. Looked through all ${everything ? total : this.log.length} recorded request(s)${everything ? " of every kind — XHR/fetch, page loads, beacons (sendBeacon), images, scripts, styles" : " (static files left out: add find or type to include them)"}: the URL, the query string and the request body, in any letter case, %-encoding and base64 undone. Not recorded: WebSocket messages.${lost}`;
    }
    const shown = hits.slice(-limit);
    const lines = shown.map((e) => {
      const outcome = e.failed
        ? `FAILED (${e.failed})`
        : e.status !== undefined
          ? String(e.status)
          : "pending";
      const head = `#${e.n} ${e.method} ${clip(e.url, MAX_URL_CHARS, needle)}${kindOf(e)} → ${outcome}${e.mocked ? " [mocked]" : ""}`;
      const parts = [head, `  sent after: ${e.after}`];
      if (e.reqBody) parts.push(`  request body: ${clip(e.reqBody, MAX_BODY_CHARS, needle)}`);
      // a %-encoded query string or a base64 value is no reading matter: show what it says
      if (needle && !glob) {
        const where = decodedParts(e).find((t) => t.toLowerCase().includes(needle));
        if (where) parts.push(`  decoded: ${clip(where, MAX_BODY_CHARS, needle)}`);
      }
      if (e.resBody) parts.push(`  response body: ${e.resBody}`);
      return parts.join("\n");
    });
    const more = hits.length > shown.length ? `\n(${hits.length - shown.length} earlier matches not shown — narrow the filter)` : "";
    const scope = everything
      ? ""
      : ` Listed: API calls, page loads and beacons; ${this.assets.length} static file(s) (scripts, images, styles) are left out — find searches them too, type="image" lists them.`;
    return `${hits.length} matching request(s), oldest first.${scope}${lost} "sent after" is your action that preceded the request — a request sent after navigate, or before the step's own action, was not caused by that action:\n${lines.join("\n")}${more}`;
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
