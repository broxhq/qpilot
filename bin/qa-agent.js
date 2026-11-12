#!/usr/bin/env node
"use strict";

// Starts the bundled server on a free local port and opens it in the browser.
// The model is chosen in the app itself, on the Settings page: the first launch
// lands there, and `qpilot config` opens it again.

const { spawn } = require("child_process");
const { createServer } = require("net");
const { join } = require("path");
const { existsSync, readFileSync } = require("fs");

const PKG_DIR = join(__dirname, "..");
const FIRST_PORT = 3847;

const args = process.argv.slice(2);
const WANTS_SETTINGS = args[0] === "config" || args[0] === "setup" || args.includes("--config");

const tty = Boolean(process.stdout.isTTY);
const paint = (code) => (text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint(1);
const dim = paint(2);
const cyan = paint(36);
const yellow = paint(33);
const red = paint(31);

function findFreePort(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", () => resolve(findFreePort(port + 1)));
    srv.listen(port, () => srv.close(() => resolve(port)));
  });
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const cmdArgs = process.platform === "win32" ? ["/c", "start", url] : [url];
  spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" }).unref();
}

/** KEY=value lines of a .env file. Lets ANTHROPIC_API_KEY or QPILOT_* come from .env.local. */
function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const env = {};
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    env[t.slice(0, eq).trim()] = t
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

function startServer(serverPath, port, envExtra) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [serverPath], {
      env: { ...process.env, ...envExtra, PORT: String(port), HOSTNAME: "127.0.0.1" },
      stdio: "inherit",
    });
    // a server that dies within a second lost the race for the port — try the next one
    const alive = setTimeout(() => resolve(child), 1000);
    child.on("exit", (code) => {
      clearTimeout(alive);
      if (code !== 0) reject(new Error("EADDRINUSE"));
    });
    child.on("error", (err) => {
      clearTimeout(alive);
      reject(err);
    });
  });
}

async function main() {
  const serverPath = join(PKG_DIR, ".next", "standalone", "server.js");
  if (!existsSync(serverPath)) {
    console.error(red("App is not built. Run: npm run build"));
    process.exit(1);
  }

  const fileEnv = loadEnvFile(join(process.cwd(), ".env.local"));

  let port = await findFreePort(FIRST_PORT);
  let child;
  for (;;) {
    try {
      child = await startServer(serverPath, port, fileEnv);
      break;
    } catch {
      port = await findFreePort(port + 1);
    }
  }

  const url = `http://localhost:${port}`;
  console.log(`\n  ${bold(cyan("qpilot"))} ${dim("→")} ${cyan(url)}\n`);
  if (tty) openBrowser(WANTS_SETTINGS ? `${url}/settings` : url);

  const shutdown = () => {
    child.kill("SIGTERM");
    console.log(
      `\n  ${bold("Thanks for using qpilot!")}` +
        `\n  If it saved you time, a ${yellow("⭐")} means a lot:` +
        `\n  ${cyan("https://github.com/broxhq/qpilot")}\n`,
    );
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
