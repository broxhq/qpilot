# qpilot

**AI agent that runs your manual test cases in a real browser**

[![npm](https://img.shields.io/npm/v/qpilot)](https://www.npmjs.com/package/qpilot)
[![GitHub stars](https://img.shields.io/github/stars/broxhq/qpilot?style=social)](https://github.com/broxhq/qpilot)
![node](https://img.shields.io/badge/node-%3E%3D20.12-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

> If qpilot saved you time → **[⭐ Star it on GitHub](https://github.com/broxhq/qpilot)**. It helps more than you'd think.

---

## How it works

1. You paste a plain-text test case
2. The agent opens Chrome and executes each step
3. You watch results appear live — `pass`, `fail`, or `warn` per step
4. If it hits a captcha or OTP, it pauses and asks you directly

No code. No Selenium. No config files.

---

## Quick start

**Requirements:** Node.js 20.12+, Google Chrome, an [Anthropic API key](https://console.anthropic.com) — or any OpenAI-compatible model endpoint (Qwen, vLLM, Ollama, corporate gateway)

```bash
npx qpilot
```

That's it. On first run qpilot walks you through a quick provider setup (arrow-key menu), then every launch shows your config and a Start menu.

Browser opens automatically at `http://localhost:3847`.

---

## Models & providers

On first run qpilot asks which model to use. You can re-run setup anytime:

```bash
npx qpilot config
```

Two options:

- **Anthropic (Claude)** — enter your `sk-ant-…` key. Default model is `claude-haiku-4-5`.
  Base URL is optional — set it if you reach Claude through a corporate proxy/gateway.
- **Custom** — any **OpenAI-compatible** endpoint: Qwen, vLLM, Ollama, a corporate
  gateway, OpenRouter, or OpenAI itself. You provide a **base URL**, **API token**
  and **model id**, e.g.:

  ```
  Base URL: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
  Model id: qwen2.5-72b-instruct
  ```

Your choice is saved to `~/.qpilot/config.json` (mode `600`) and reused on every run.

> The custom path speaks the OpenAI `/chat/completions` protocol with tool calling —
> so the model must support function/tool calling for the agent to drive the browser.

### API key (Anthropic shortcut)

For the Anthropic provider you can skip setup by supplying the key via env:

1. `ANTHROPIC_API_KEY` environment variable
2. `.env.local` file in the current directory

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local
```

The key is never stored except in `~/.qpilot/config.json` when you run setup.

---

## Options

| Command | Description |
|------|-------------|
| `qpilot config` | Re-run provider setup (Anthropic or custom model) |

```bash
npx qpilot config
```

Browser visibility is a per-run choice in the UI, not a CLI flag: hit **Run** to
stay headless, or **Run with preview** to watch Chrome click through the page.

---

## Writing a test case

```
TC-001 — Login and add item to cart
URL: https://www.saucedemo.com/
Credentials: standard_user / secret_sauce

Steps:
1. Open the home page.
   Expected: login form with Username and Password fields is visible.

2. Enter credentials and click Login.
   Expected: Products page opens with 6 items.

3. Click "Add to cart" on "Sauce Labs Backpack".
   Expected: cart counter shows 1.

4. Click the cart icon.
   Expected: cart contains Sauce Labs Backpack at $29.99.
```

You can paste multiple test cases at once — the agent runs them in order.

---

## Running a folder of test cases

Click **Choose folder** to point qpilot at a directory of `.md` files (or **Upload
.md** for a single file). Check the ones you want, then **Run** the batch — each
file runs one after another with live status and timing, and you can **Stop**
mid-batch. Finished runs (including past batches) show up under **Recent runs**
on the home page.

---

## Notes

- API key is stored only in `~/.qpilot/config.json` (file mode `600`) — never sent anywhere except your chosen model provider
- Runs are in-memory and capped at the last 50 — restarting the server clears all of them
- Powered by [Claude](https://anthropic.com) + [Playwright](https://playwright.dev)
