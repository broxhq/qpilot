#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const { createServer } = require("net");
const { join } = require("path");
const { homedir } = require("os");
const {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} = require("fs");
const pc = require("picocolors");

const PKG_DIR = join(__dirname, "..");
const CONFIG_DIR = join(homedir(), ".qpilot");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

const args = process.argv.slice(2);
let VISIBLE = args.includes("--visible") || args.includes("-v");
const WANTS_SETUP =
  args[0] === "config" || args[0] === "setup" || args.includes("--config");
// menu/prompts only in a real terminal; in scripts start silently
const INTERACTIVE = Boolean(process.stdout.isTTY && process.stdin.isTTY);

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
  const a = process.platform === "win32" ? ["/c", "start", url] : [url];
  spawn(cmd, a, { detached: true, stdio: "ignore" }).unref();
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

// ── config (~/.qpilot/config.json) ─────────────────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function saveConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** Fallback: Anthropic key from env / .env.local (backwards compatibility). */
function envConfig(fileEnv) {
  const apiKey = process.env.ANTHROPIC_API_KEY || fileEnv.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return {
    provider: "anthropic",
    apiKey,
    model: process.env.QPILOT_MODEL || fileEnv.QPILOT_MODEL || "",
  };
}

/** config → env vars the server understands (lib/provider.ts). */
function configToEnv(cfg) {
  if (cfg.provider === "custom") {
    return {
      QPILOT_PROVIDER: "custom",
      QPILOT_BASE_URL: cfg.baseURL,
      QPILOT_API_KEY: cfg.apiKey,
      QPILOT_MODEL: cfg.model,
    };
  }
  return {
    QPILOT_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: cfg.apiKey,
    ...(cfg.model ? { QPILOT_MODEL: cfg.model } : {}),
    ...(cfg.baseURL ? { QPILOT_BASE_URL: cfg.baseURL } : {}),
  };
}

function describeProvider(cfg) {
  return cfg.provider === "custom"
    ? `${cfg.model} @ custom`
    : cfg.model || DEFAULT_ANTHROPIC_MODEL;
}

function maskKey(key) {
  if (!key) return pc.red("(not set)");
  return key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : "••••";
}

function configSummary(cfg, source) {
  const row = (label, value) => `${pc.dim(label.padEnd(10))}${value}`;
  const lines = [
    row(
      "Provider",
      cfg.provider === "custom"
        ? pc.magenta("Custom (OpenAI-compatible)")
        : pc.magenta("Anthropic (Claude)"),
    ),
    row("Model", pc.cyan(cfg.model || DEFAULT_ANTHROPIC_MODEL)),
  ];
  if (cfg.baseURL) lines.push(row("Base URL", pc.cyan(cfg.baseURL)));
  lines.push(row("API key", maskKey(cfg.apiKey)));
  lines.push(row("Source", pc.dim(source)));
  return lines.join("\n");
}

// ── interactive (@clack/prompts, ESM → dynamic import) ──────────────────────

const required = (v) => (v && v.trim() ? undefined : "Required");

function bailIfCancel(p, v) {
  if (p.isCancel(v)) {
    p.cancel("Cancelled.");
    process.exit(1);
  }
  return v;
}

async function runSetup(p) {
  const bail = (v) => bailIfCancel(p, v);

  const provider = bail(
    await p.select({
      message: "Choose your model provider",
      initialValue: "anthropic",
      options: [
        { value: "anthropic", label: "Anthropic (Claude)", hint: "default" },
        {
          value: "custom",
          label: "Custom — OpenAI-compatible",
          hint: "Qwen, vLLM, Ollama, corp gateway, OpenRouter",
        },
      ],
    }),
  );

  let cfg;
  if (provider === "custom") {
    const baseURL = bail(
      await p.text({
        message: "Base URL",
        placeholder: "https://.../v1",
        validate: (v) =>
          !v || !v.trim()
            ? "Required"
            : /^https?:\/\//.test(v.trim())
              ? undefined
              : "Must start with http:// or https://",
      }),
    );
    const apiKey = bail(
      await p.password({ message: "API token", validate: required }),
    );
    const model = bail(
      await p.text({
        message: "Model id",
        placeholder: "qwen2.5-72b-instruct",
        validate: required,
      }),
    );
    cfg = {
      provider: "custom",
      baseURL: baseURL.trim(),
      apiKey: apiKey.trim(),
      model: model.trim(),
    };
  } else {
    const apiKey = bail(
      await p.password({
        message: "Anthropic API key (sk-ant-…)",
        validate: required,
      }),
    );
    const model = bail(
      await p.text({
        message: "Model id",
        placeholder: DEFAULT_ANTHROPIC_MODEL,
        defaultValue: DEFAULT_ANTHROPIC_MODEL,
      }),
    );
    const baseURL = bail(
      await p.text({
        message: "Base URL (Enter to use api.anthropic.com)",
        placeholder: "https://api.anthropic.com",
        defaultValue: "",
        validate: (v) =>
          !v || !v.trim() || /^https?:\/\//.test(v.trim())
            ? undefined
            : "Must start with http:// or https://",
      }),
    );
    cfg = {
      provider: "anthropic",
      apiKey: apiKey.trim(),
      model: (model || DEFAULT_ANTHROPIC_MODEL).trim(),
      ...(baseURL && baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
    };
  }

  saveConfig(cfg);
  p.log.success(`Saved to ${pc.cyan(CONFIG_PATH)}`);
  return cfg;
}

/** Config card + menu: Start / Start visible / Change / Exit. */
async function startMenu(p, cfg, source) {
  for (;;) {
    p.note(configSummary(cfg, source), "Provider");
    const action = bailIfCancel(
      p,
      await p.select({
        message: "Ready to go?",
        initialValue: VISIBLE ? "start-visible" : "start",
        options: [
          { value: "start", label: "Start", hint: "headless — agent works in background" },
          {
            value: "start-visible",
            label: "Start with visible browser",
            hint: "watch the agent click through pages",
          },
          { value: "config", label: "Change provider / model" },
          { value: "exit", label: "Exit" },
        ],
      }),
    );
    if (action === "start" || action === "start-visible") {
      VISIBLE = action === "start-visible";
      return cfg;
    }
    if (action === "exit") {
      p.cancel("Bye!");
      process.exit(0);
    }
    cfg = await runSetup(p);
    source = CONFIG_PATH;
  }
}

// ── server ───────────────────────────────────────────────────────────────────

function startServer(serverPath, port, envExtra) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [serverPath], {
      env: {
        ...process.env,
        ...envExtra,
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
    console.error(pc.red("App is not built. Run: npm run build"));
    process.exit(1);
  }

  const fileEnv = loadEnvFile(join(process.cwd(), ".env.local"));

  let cfg;
  if (!INTERACTIVE) {
    // scripts/CI: no menu — use saved config or env, else error
    cfg = loadConfig() || envConfig(fileEnv);
    if (WANTS_SETUP || !cfg) {
      console.error(
        "No interactive terminal. Run `qpilot config` in a terminal first, or set ANTHROPIC_API_KEY.",
      );
      process.exit(1);
    }
  } else {
    const p = await import("@clack/prompts");
    p.intro(`${pc.bgCyan(pc.black(" qpilot "))} ${pc.dim("AI agent for manual test cases")}`);

    if (WANTS_SETUP) {
      cfg = await runSetup(p);
    } else {
      cfg = loadConfig() || envConfig(fileEnv);
      if (!cfg) {
        p.log.warn("No provider configured yet — let's set one up.");
        cfg = await runSetup(p);
      }
    }
    const source = loadConfig() ? CONFIG_PATH : "env / .env.local";
    cfg = await startMenu(p, cfg, source);

    if (VISIBLE) p.log.info("--visible: browser window will be shown");
    p.outro(pc.dim("Launching…"));
  }

  const envExtra = { ...fileEnv, ...configToEnv(cfg) };

  // try ports until one works
  let port = await findFreePort(3847);
  let child;
  while (true) {
    try {
      child = await startServer(serverPath, port, envExtra);
      break;
    } catch {
      port = await findFreePort(port + 1);
    }
  }

  const url = `http://localhost:${port}`;
  console.log(
    `\n  ${pc.bold(pc.cyan("qpilot"))} ${pc.dim("→")} ${pc.underline(pc.cyan(url))}  ${pc.dim("·")}  ${pc.magenta(describeProvider(cfg))}\n`,
  );
  openBrowser(url);

  const shutdown = () => {
    child.kill("SIGTERM");
    console.log(
      `\n  ${pc.bold("Thanks for using qpilot!")}` +
        `\n  If it saved you time, a ${pc.yellow("⭐")} means a lot:` +
        `\n  ${pc.underline(pc.cyan("https://github.com/broxhq/qpilot"))}\n`,
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
