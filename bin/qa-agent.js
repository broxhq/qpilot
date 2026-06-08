#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const { createServer } = require("net");
const { createInterface } = require("readline");
const { join } = require("path");
const { existsSync, readFileSync } = require("fs");

const PKG_DIR = join(__dirname, "..");

const args = process.argv.slice(2);
const VISIBLE = args.includes("--visible") || args.includes("-v");

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
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

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

function promptApiKey() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const onData = () => {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
      process.stdout.write("  API key: " + "·".repeat(rl.line.length));
    };
    process.stdin.on("data", onData);

    rl.question("  API key: ", (answer) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

function startServer(serverPath, port, apiKey, fileEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [serverPath], {
      env: {
        ...process.env,
        ...fileEnv,
        ANTHROPIC_API_KEY: apiKey,
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        HEADLESS: VISIBLE ? "false" : "true",
      },
      stdio: "inherit",
    });

    // if server crashes within 1s — port conflict, reject to retry
    const earlyExit = setTimeout(() => resolve(child), 1000);

    child.on("exit", (code) => {
      clearTimeout(earlyExit);
      if (code !== 0) reject(new Error("EADDRINUSE"));
    });

    child.on("error", (err) => {
      clearTimeout(earlyExit);
      reject(err);
    });
  });
}

async function main() {
  const serverPath = join(PKG_DIR, ".next", "standalone", "server.js");
  if (!existsSync(serverPath)) {
    console.error("App is not built. Run: npm run build");
    process.exit(1);
  }

  const fileEnv = loadEnvFile(join(process.cwd(), ".env.local"));
  let apiKey = process.env.ANTHROPIC_API_KEY || fileEnv.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.log("\n  No ANTHROPIC_API_KEY found.");
    console.log("  Get one at https://console.anthropic.com\n");
    apiKey = await promptApiKey();
    if (!apiKey) {
      console.error("\n  API key is required. Exiting.");
      process.exit(1);
    }
  }

  if (VISIBLE) console.log("\n  --visible: browser window will be shown");

  // try ports until one works
  let port = await findFreePort(3847);
  let child;
  while (true) {
    try {
      child = await startServer(serverPath, port, apiKey, fileEnv);
      break;
    } catch {
      port = await findFreePort(port + 1);
    }
  }

  const url = `http://localhost:${port}`;
  console.log(`\n  qpilot → ${url}\n`);
  openBrowser(url);

  const shutdown = () => {
    child.kill("SIGTERM");
    console.log(
      "\n  Thanks for using qpilot!" +
        "\n  If it saved you time, a ⭐ means a lot:" +
        "\n  https://github.com/broxhq/qpilot\n",
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
