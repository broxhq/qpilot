# qpilot

**AI agent that runs your manual test cases in a real browser**

[![npm](https://img.shields.io/npm/v/qpilot)](https://www.npmjs.com/package/qpilot)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

---

## How it works

1. You paste a plain-text test case
2. The agent opens Chrome and executes each step
3. You watch results appear live — `pass`, `fail`, or `warn` per step
4. If it hits a captcha or OTP, it pauses and asks you directly

No code. No Selenium. No config files.

---

## Quick start

**Requirements:** Node.js 18+, Google Chrome, an [Anthropic API key](https://console.anthropic.com)

```bash
npx qpilot
```

That's it. If no API key is found, qpilot will ask for it on first run.

Browser opens automatically at `http://localhost:3847`.

---

## API key

qpilot looks for the key in this order:

1. `ANTHROPIC_API_KEY` environment variable
2. `.env.local` file in the current directory
3. Prompts you to enter it if neither is found

To avoid entering it every time:

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local
```

---

## Options

| Flag | Description |
|------|-------------|
| `--visible` | Show the Chrome window while the agent runs |

```bash
npx qpilot --visible
```

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

## Notes

- API key is never stored — lives only in the running process
- Runs are in-memory; restarting clears them
- Powered by [Claude](https://anthropic.com) + [Playwright](https://playwright.dev)
