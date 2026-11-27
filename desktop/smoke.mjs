// Does the app work? Starts it, runs a short test case through its window against
// the scripted model and the local test page (the ones e2e uses), and checks the
// verdicts. The whole chain is in it: the frame starts the server with its own
// Node, the server finds Chrome and drives it.
//
//   node desktop/smoke.mjs            the app from the sources (needs npm run build)
//   node desktop/smoke.mjs --packed   the packed app in desktop/dist (needs npm run dist)
//
// On a machine nobody has tried the app on — CI's Windows — this is the first user.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { ref, startModel } from "../e2e/model.mjs";
import { startSite } from "../e2e/site.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packed = process.argv.includes("--packed");

/** The executable of the packed app, wherever this system's build put it. */
function packedApp() {
  const dist = join(here, "dist");
  const dirs = existsSync(dist) ? readdirSync(dist) : [];
  if (process.platform === "darwin") {
    const dir = dirs.find((d) => d.startsWith("mac"));
    if (dir) return join(dist, dir, "qpilot.app", "Contents", "MacOS", "qpilot");
  } else if (process.platform === "win32") {
    if (dirs.includes("win-unpacked")) return join(dist, "win-unpacked", "qpilot.exe");
  }
  throw new Error("No packed app in desktop/dist: npm --prefix desktop run dist");
}

const site = await startSite();
const model = await startModel([
  (_t, call) => [call("set_plan", { groups: [{ title: "Switches", steps: ["Open the form — the switches are visible", "Save — Saved is shown"] }] })],
  (_t, call) => [call("navigate", { url: site.url })],
  (tree, call) => [
    call("report_step", { num: 1, expected: "the switches are visible", evidence: 'switch "Ad labelling" is on the page', status: "pass" }),
    call("click", { ref: ref(tree, /button "Save"/), name: "Save" }),
  ],
  (_t, call) => [
    call("report_step", { num: 2, expected: "Saved is shown", evidence: "status: Saved", status: "pass" }),
    call("finish", { status: "passed", summary: "Both steps passed." }),
  ],
]);
const home = mkdtempSync(join(tmpdir(), "qpilot-app-"));
writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "custom", baseURL: model.url, apiKey: "smoke-key-0000000000", model: "scripted" }));

// an editor's terminal may carry this; with it Electron would start as plain Node
const { ELECTRON_RUN_AS_NODE: _drop, ...env } = process.env;
const app = await _electron.launch({
  // from the sources: the Electron installed next to this file (the package's main is the path to its binary)
  // its own profile folder: a qpilot the person has open must not take this launch for a second window of itself
  ...(packed
    ? { executablePath: packedApp(), args: [`--user-data-dir=${join(home, "profile")}`] }
    : { executablePath: createRequire(import.meta.url)("electron"), args: [here, `--user-data-dir=${join(home, "profile")}`] }),
  env: { ...env, QPILOT_HOME: home, QPILOT_SESSIONS: "0", QPILOT_VISION: "0", QPILOT_NO_UPDATE_CHECK: "1" },
  timeout: 60_000,
});
let failed = "";
try {
  const page = await app.firstWindow({ timeout: 60_000 });
  const editor = page.locator("form textarea");
  await editor.waitFor({ timeout: 60_000 });
  await editor.fill(`Switches\nURL: ${site.url}\n\n1. Open the form.\n   Expected: the switches are visible.\n2. Save.\n   Expected: Saved is shown.`);
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForURL(/\/run\//, { timeout: 30_000 });
  const id = page.url().split("/run/")[1];
  const origin = new URL(page.url()).origin;
  let run;
  for (let i = 0; i < 240; i++) {
    run = (await (await fetch(`${origin}/api/runs`)).json()).find((r) => r.id === id);
    if (run && !["running", "waiting", "paused"].includes(run.status)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const steps = await page.evaluate(async (runId) => {
    const res = await fetch(`/api/run/${runId}/stream`);
    const { value } = await res.body.getReader().read();
    const frame = new TextDecoder().decode(value).split("\n\n").find((f) => f.startsWith("data:"));
    return frame ? JSON.parse(frame.slice(5)).run.steps.map((s) => s.status) : [];
  }, id);
  console.log(`${packed ? "packed app" : "app from sources"}: run ${run?.status}, steps ${steps.join(", ") || "none"}`);
  if (run?.status !== "passed" || steps.join() !== "pass,pass") failed = `expected a passed run with two passed steps`;
  if (process.argv.includes("--shot")) await page.screenshot({ path: join(here, "dist", "smoke.png") });

  // macOS: the server must not show up as an app of its own (a second icon in the Dock)
  if (process.platform === "darwin") {
    // (this app's server, by the port it listens on: another qpilot may be open on the machine)
    const pid = execFileSync("lsof", ["-ti", `tcp:${new URL(origin).port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0];
    const apps = execFileSync("lsappinfo", ["list"], { encoding: "utf8" }).split(/\n(?=\s*\d+\) )/);
    const stray = apps.find((a) => new RegExp(`pid = ${pid}\\b`).test(a) && /type="Foreground"/.test(a));
    if (stray && !failed) failed = "the server has an icon of its own in the Dock";
  }

  // "Download report" must leave a file in the Downloads folder (here: a folder of the test's own, and no Finder window)
  const downloads = join(home, "downloads");
  mkdirSync(downloads);
  await app.evaluate(({ app: electron, shell }, dir) => {
    electron.setPath("downloads", dir);
    shell.showItemInFolder = () => {};
  }, downloads);
  await page.getByRole("button", { name: "Download report" }).click();
  const report = join(downloads, `qpilot-${id}.html`);
  for (let i = 0; i < 30 && !existsSync(report); i++) await new Promise((r) => setTimeout(r, 500));
  if (!existsSync(report) && !failed) failed = "the report was not saved to the Downloads folder";

  // "Copy report" puts the report on the clipboard (what was there before is put back)
  const before = await app.evaluate(({ clipboard }) => clipboard.readText());
  await page.getByRole("button", { name: "Copy report" }).click();
  let copied = "";
  for (let i = 0; i < 10 && !copied.includes("Switches"); i++) {
    await new Promise((r) => setTimeout(r, 300));
    copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  }
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), before);
  if (!copied.includes("Switches") && !failed) failed = "the report was not copied to the clipboard";

  // closing the window is how a person quits: the app and its server must both go
  const gone = app.waitForEvent("close", { timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await gone;
  let answers = true;
  for (let i = 0; i < 20 && answers; i++) {
    answers = await fetch(`${origin}/api/runs`).then(() => true, () => false);
    if (answers) await new Promise((r) => setTimeout(r, 500));
  }
  if (answers && !failed) failed = "the window is closed, but the server still answers";
} catch (err) {
  failed = err.message;
} finally {
  await app.close().catch(() => {});
  site.close();
  model.close();
  rmSync(home, { recursive: true, force: true });
}
if (failed) {
  console.error(`✗ ${failed}`);
  process.exit(1);
}
console.log("✓ the app starts its server, opens its window, runs a test case in Chrome, saves and copies the report, and stops the server when closed");
process.exit(0);
