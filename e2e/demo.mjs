// Records the demo at the top of the README: a real run, as a person sees it.
//
//   npm run build && node e2e/demo.mjs            → docs/assets/demo.webm + .gif
//   node e2e/demo.mjs --dry                       a rehearsal, see below
//
// It starts the built app with the model from your settings, opens it in Chrome,
// pastes the test case from the README, presses Run and films the page until
// the run is over. Nothing is staged: the verdicts are whatever the model gives
// on that run, and the run takes as long as it takes. Look at the recording
// before you publish it — and put the real numbers in the caption.
//
// --dry films a run against the scripted model and the local test page instead.
// It is for trying the camera work (scrolling, timing, the gif) without spending
// model calls. A dry recording is a mock-up: do not publish it as a run.
//
// Needs ffmpeg on the PATH. Saved sign-ins are off for the recording, so the
// demo site does not end up among yours and the run starts at the login form.

import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ref, startModel } from "./model.mjs";
import { startSite } from "./site.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, ".next", "standalone", "server.js");
if (!existsSync(SERVER)) throw new Error("Build the app first: npm run build");

const dry = process.argv.includes("--dry");
const OUT = join(ROOT, "docs", "assets");
const NAME = dry ? "demo-dry" : "demo";

// the size of the film and of the gif (Playwright films in CSS pixels: a larger
// frame would only add a grey border, not sharpness)
const WIDTH = 840;
const HEIGHT = 512;
// Headless Chrome films the page with a grey band over the bottom rows, about
// as tall as its toolbar would be. So the page is made that much taller than
// the film needs, and the band is cut off when the gif is made.
const BAND = 96;

// the test case of the README, word for word
const CASE = `TC-014 — Add two items to the cart
URL: https://www.saucedemo.com/
Credentials: problem_user / secret_sauce

1. Open the page.
   Expected: login form with Username and Password.
2. Log in.
   Expected: Products page with 6 items.
3. Add "Sauce Labs Backpack" to the cart.
   Expected: cart badge shows 1.
4. Add "Sauce Labs Fleece Jacket" to the cart.
   Expected: cart badge shows 2.
5. Open the cart.
   Expected: both items are listed.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

// ── a rehearsal: the scripted model on the local page ───────────────────────────
let site;
let model;
let home;
let testCase = CASE;
if (dry) {
  site = await startSite();
  const SWITCH = /switch "Ad labelling"/;
  const slow = (turn) => async (tree, call) => {
    await sleep(1800); // a model takes its time
    return turn(tree, call);
  };
  model = await startModel([
    slow((_t, call) => [call("set_plan", { groups: [{ title: "Switches", steps: [
      "Open the form — the switches are visible",
      "Click 400 px to the right of the switch — its state does not change",
      "Save — Saved is shown",
    ] }] })]),
    slow((_t, call) => [call("navigate", { url: site.url })]),
    slow((tree, call) => [
      call("report_step", { num: 1, expected: "the switches are visible", evidence: 'switch "Ad labelling" is on the page', status: "pass" }),
      call("click", { ref: ref(tree, SWITCH), dx: 400, name: "right of Ad labelling" }),
    ]),
    slow((tree, call) => [
      call("report_step", { num: 2, expected: "its state does not change", evidence: "the switch became checked", status: "fail" }),
      call("click", { ref: ref(tree, /button "Save"/), name: "Save" }),
    ]),
    slow((_t, call) => [
      call("report_step", { num: 3, expected: "Saved is shown", evidence: "status: Saved", status: "pass" }),
      call("finish", { status: "failed", summary: "A click next to the switch toggles it." }),
    ]),
  ]);
  home = mkdtempSync(join(tmpdir(), "qpilot-demo-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "custom", baseURL: model.url, apiKey: "demo-key-0000000000", model: "scripted" }));
  testCase = `Switches\nURL: ${site.url}\n\n1. Open the form.\n   Expected: the switches are visible.\n2. Click 400 px to the right of the "Ad labelling" switch.\n   Expected: its state does not change.\n3. Save.\n   Expected: Saved is shown.`;
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const app = spawn("node", [SERVER], {
  env: {
    ...process.env,
    ...(dry ? { QPILOT_HOME: home, QPILOT_VISION: "0" } : {}),
    QPILOT_SESSIONS: "0",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
  },
  stdio: ["ignore", "ignore", "inherit"],
});

const film = mkdtempSync(join(tmpdir(), "qpilot-film-"));
let browser;
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/api/runs`)).ok) break;
    } catch {}
    await sleep(500);
  }
  browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT + BAND },
    colorScheme: "dark",
    locale: "en-US",
    recordVideo: { dir: film, size: { width: WIDTH, height: HEIGHT + BAND } },
  });
  const page = await context.newPage();
  const filmedFrom = Date.now();
  const at = () => ((Date.now() - filmedFrom) / 1000).toFixed(1);

  // the home page, the case pasted, Run
  await page.goto(base);
  await page.getByPlaceholder("Paste your test case here…").waitFor();
  await sleep(1400);
  await page.getByPlaceholder("Paste your test case here…").fill(testCase);
  await sleep(1300);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.waitForURL(/\/run\//);
  const id = page.url().split("/run/")[1];
  console.log(`run ${id} started at ${at()} s of the film`);

  // Follow the run the way an eye does: keep the step being worked on in view.
  const status = async () => (await (await fetch(`${base}/api/runs`)).json()).find((r) => r.id === id)?.status;
  // one smooth scroll to where the badge should sit: a second scroll started
  // while the first is still going would cancel it
  const bringIntoView = (text, fromTop) =>
    page.evaluate(
      ([needle, offset]) => {
        const badge = [...document.querySelectorAll("span, div")].find(
          (el) => el.children.length <= 1 && el.textContent?.trim().toUpperCase() === needle,
        );
        if (!badge) return false;
        const top = badge.getBoundingClientRect().top + scrollY - offset;
        if (Math.abs(top - scrollY) > 12) scrollTo({ top, behavior: "smooth" });
        return true;
      },
      [text, fromTop],
    );
  while (["running", "waiting", "paused"].includes(await status())) {
    await bringIntoView("RUNNING", Math.round(HEIGHT * 0.4));
    await sleep(500);
  }
  const ended = await status();
  console.log(`run ended (${ended}) at ${at()} s of the film`);

  // What the run found: the first failed step with its screenshot, then the next one
  await sleep(900);
  if (await bringIntoView("FAIL", 28)) {
    await sleep(3800);
    await page.evaluate(() => window.scrollBy({ top: Math.round(innerHeight * 0.75), behavior: "smooth" }));
    await sleep(3000);
  } else {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    await sleep(3000);
  }
  console.log(`film is ${at()} s long`);

  const run = await (await fetch(`${base}/api/run/${id}/stream`)).body.getReader().read().then(({ value }) => {
    const frame = new TextDecoder().decode(value).split("\n\n").find((f) => f.startsWith("data:"));
    return frame ? JSON.parse(frame.slice(5)).run : null;
  });
  if (run) {
    console.log(`steps: ${run.steps.map((s) => s.status).join(", ")}`);
    console.log(`model calls: ${run.stats?.calls}, model ${Math.round((run.stats?.modelMs ?? 0) / 1000)} s, browser ${Math.round((run.stats?.browserMs ?? 0) / 1000)} s`);
  }

  const video = page.video();
  await context.close();
  mkdirSync(OUT, { recursive: true });
  const webm = join(OUT, `${NAME}.webm`);
  renameSync(await video.path(), webm);

  // the gif: one palette for the whole film, so the dark background does not band
  const gif = join(OUT, `${NAME}.gif`);
  const filter = `fps=10,crop=${WIDTH}:${HEIGHT}:0:0,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", webm, "-filter_complex", filter, gif]);
  console.log(`${webm}  ${(statSync(webm).size / 1e6).toFixed(1)} MB`);
  console.log(`${gif}  ${(statSync(gif).size / 1e6).toFixed(1)} MB`);
} finally {
  await browser?.close().catch(() => {});
  const gone = once(app, "exit");
  app.kill();
  await gone;
  site?.close();
  model?.close();
  if (home) rmSync(home, { recursive: true, force: true });
  rmSync(film, { recursive: true, force: true });
}
process.exit(0);
