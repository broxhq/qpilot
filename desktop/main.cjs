"use strict";

// qpilot as an app. The window is only a frame: it starts the same built server
// the CLI starts (bin/qa-agent.js) and shows its pages. Nothing here knows about
// runs or models — a tester gets an icon to click instead of Node and a terminal.
//
// The server runs in a child process, as plain Node: Electron's own binary with
// ELECTRON_RUN_AS_NODE. So the app needs no Node on the machine, and the server
// behaves exactly as it does under `npx qpilot`. Chrome is still the user's own.

const { app, BrowserWindow, Menu, dialog, nativeTheme, net, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { join } = require("node:path");

const SERVER_DIR = app.isPackaged
  ? join(process.resourcesPath, "server")
  : join(__dirname, "..", ".next", "standalone");
const FIRST_PORT = 3847;
// The server leaves with the app, however the app goes: its stdin is a pipe from
// here, and the pipe closing — a quit, a crash, a kill — is its signal to exit.
// (Exiting, it closes the browsers it started.)
const GUARD = 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); require(process.argv[1]);';
const RELEASES = "https://api.github.com/repos/broxhq/qpilot/releases/latest";

// The few sentences the frame itself says. The pages have their own dictionaries.
const russian = () => app.getLocale().toLowerCase().startsWith("ru");
const TEXT = {
  en: {
    notBuilt: "The app is incomplete: its server is missing.",
    noStart: "qpilot could not start its server.",
    seeLog: "Details are in the log:",
    busyTitle: "A run is in progress",
    busy: "Closing qpilot stops it. Verdicts given so far are lost.",
    quit: "Quit",
    stay: "Keep running",
    updateTitle: "A new version of qpilot is out",
    update: (next, now) => `Version ${next} is available. You have ${now}.`,
    download: "Download",
    later: "Later",
  },
  ru: {
    notBuilt: "Приложение неполное: в нём нет сервера.",
    noStart: "qpilot не смог запустить свой сервер.",
    seeLog: "Подробности в журнале:",
    busyTitle: "Идёт прогон",
    busy: "Если закрыть qpilot, он остановится. Уже вынесенные вердикты пропадут.",
    quit: "Закрыть",
    stay: "Не закрывать",
    updateTitle: "Вышла новая версия qpilot",
    update: (next, now) => `Доступна версия ${next}. У вас ${now}.`,
    download: "Скачать",
    later: "Позже",
  },
};
const t = () => (russian() ? TEXT.ru : TEXT.en);

let server = null;
let base = "";
let win = null;
let quitting = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findFreePort(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", () => resolve(findFreePort(port + 1)));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(port)));
  });
}

function logFile() {
  const dir = app.getPath("logs");
  mkdirSync(dir, { recursive: true });
  return join(dir, "server.log");
}

/** Starts the server on `port`; resolves once it answers, rejects if it dies first. */
function startServer(port, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", GUARD, join(SERVER_DIR, "server.js")], {
      cwd: SERVER_DIR,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PORT: String(port), HOSTNAME: "127.0.0.1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    child.on("error", fail);
    child.on("exit", (code) => fail(new Error(`the server exited with code ${code}`)));
    (async () => {
      const url = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 120 && !settled; i++) {
        try {
          if ((await fetch(`${url}/api/runs`)).ok) {
            settled = true;
            return resolve({ child, url });
          }
        } catch {}
        await sleep(250);
      }
      child.kill();
      fail(new Error("the server did not answer in 30 seconds"));
    })();
  });
}

/** The server and every browser it started. On Windows a plain kill leaves the browsers behind. */
function stopServer() {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
  else child.kill("SIGTERM");
}

async function runInProgress() {
  try {
    const runs = await (await fetch(`${base}/api/runs`)).json();
    return runs.some((r) => ["running", "waiting", "paused"].includes(r.status));
  } catch {
    return false;
  }
}

const ours = (url) => url.startsWith(base + "/") || url === base;
// what shows for a moment before the page does
const backdrop = () => (nativeTheme.shouldUseDarkColors ? "#0e0f12" : "#fafafa");

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 760,
    minHeight: 560,
    title: "qpilot",
    backgroundColor: backdrop(),
    autoHideMenuBar: true,
    show: false,
  });
  win.once("ready-to-show", () => win.show());
  // qpilot's own pages stay in the app; everything else is the browser's business
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (ours(url)) return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: backdrop() } };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (ours(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    void (async () => {
      if (await runInProgress()) {
        const { response } = await dialog.showMessageBox(win, {
          type: "warning",
          message: t().busyTitle,
          detail: t().busy,
          buttons: [t().stay, t().quit],
          defaultId: 0,
          cancelId: 0,
        });
        if (response === 0) return;
      }
      quitting = true;
      app.quit();
    })();
  });
  void win.loadURL(base);
}

function menu() {
  const mac = process.platform === "darwin";
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
  ]);
}

const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.replace(/^v/, "").split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

/**
 * Says once per version that a newer one is out, and where to get it. The app
 * does not replace itself: that needs a signed build, and this one is not.
 */
async function checkForUpdate() {
  if (!app.isPackaged || process.env.QPILOT_NO_UPDATE_CHECK) return;
  try {
    const res = await net.fetch(RELEASES, { headers: { accept: "application/vnd.github+json" } });
    if (!res.ok) return;
    const release = await res.json();
    const next = String(release.tag_name || "");
    // a release without installers is the npm package alone
    if (!newer(next, app.getVersion()) || !(release.assets || []).some((a) => /\.(dmg|exe)$/.test(a.name))) return;
    const seenFile = join(app.getPath("userData"), "update-seen.json");
    const seen = existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, "utf8")).version : "";
    if (seen === next) return;
    writeFileSync(seenFile, JSON.stringify({ version: next }));
    const { response } = await dialog.showMessageBox(win, {
      type: "info",
      message: t().updateTitle,
      detail: t().update(next.replace(/^v/, ""), app.getVersion()),
      buttons: [t().download, t().later],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) void shell.openExternal(release.html_url);
  } catch {
    // no network, a corporate proxy, a rate limit: the app works without the check
  }
}

async function main() {
  if (!existsSync(join(SERVER_DIR, "server.js"))) {
    dialog.showErrorBox("qpilot", app.isPackaged ? t().notBuilt : "Build the app first: npm run build");
    return app.exit(1);
  }
  const path = logFile();
  const log = createWriteStream(path, { flags: "w" });
  let port = await findFreePort(FIRST_PORT);
  for (let attempt = 0; ; attempt++) {
    try {
      const started = await startServer(port, log);
      server = started.child;
      base = started.url;
      break;
    } catch (err) {
      log.write(`[qpilot] ${err.message}\n`);
      // a server that dies at once most likely lost the race for the port
      if (attempt >= 3) {
        dialog.showErrorBox("qpilot", `${t().noStart}\n${t().seeLog}\n${path}`);
        return app.exit(1);
      }
      port = await findFreePort(port + 1);
    }
  }
  server.on("exit", () => {
    // the server is the app: without it the window has nothing to show
    if (!quitting) app.quit();
  });
  Menu.setApplicationMenu(menu());
  createWindow();
  void checkForUpdate();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", stopServer);
  void app.whenReady().then(main);
}
