# Contributing to qpilot

Thanks for helping out. Bug reports, fixes and new agent capabilities are all welcome.

## Reporting a bug

[Open an issue](https://github.com/broxhq/qpilot/issues/new) and include:

- the qpilot version, your OS and your Node version;
- the provider and model you use (Anthropic, or the custom endpoint and model id);
- the test case you ran, trimmed to the smallest one that still fails;
- what happened: the failing step, its evidence, and the error text from the run log.

If the page is public, link it. If it isn't, describe the structure of the part that
breaks (an iframe, a custom dropdown, a hidden file input, and so on) — most agent bugs
depend on page structure, not on the content.

Please don't paste API keys, OTP codes or credentials from your run log.

## Development setup

You need Node.js 20.12+ and Google Chrome. Playwright drives your installed Chrome, so
no separate browser is downloaded.

```bash
git clone https://github.com/broxhq/qpilot.git
cd qpilot
npm install
```

Give the dev server a model. The simplest option is a `.env.local` file in the repo root
(it is gitignored):

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

Or, for any OpenAI-compatible endpoint:

```bash
QPILOT_PROVIDER=custom
QPILOT_BASE_URL=https://your-endpoint/v1
QPILOT_API_KEY=...
QPILOT_MODEL=your-model-id
```

Then:

```bash
npm run dev      # http://localhost:3000
```

Use **Run with preview** to watch Chrome while the agent works.

To test the CLI the way users get it, build and start it from the repo:

```bash
npm run build
node bin/qa-agent.js
```

## Checking your change

There is no test suite or linter yet. Before opening a PR:

1. `npm run build` passes — it runs the TypeScript check.
2. You ran at least one real test case that exercises your change, in the browser.
   For agent changes, also run a case that worked before, to catch regressions.

Mention in the PR which test cases you ran and against which model.

## How the code is organised

```
app/page.tsx              home page: test case input, folders, batch runs, history
app/run/[id]/page.tsx     live run page: steps, log, questions from the agent
app/api/                  run, stream (SSE), answer, pause, screenshot endpoints
lib/agent.ts              the agent loop, system prompt, tool execution
lib/tools.ts              tool schemas and the page snapshot
lib/provider.ts           Anthropic and OpenAI-compatible model calls
lib/store.ts              in-memory run state
lib/types.ts              shared types
lib/i18n.ts               UI strings (en, ru)
bin/qa-agent.js           the `qpilot` CLI
```

A run works like this: `POST /api/run` creates a run and starts `runAgent` in the
background. The agent takes an ARIA snapshot of the page, asks the model what to do,
executes the returned tool calls in Chrome, and repeats until the model calls `finish`.
The run page follows along over Server-Sent Events.

## Things that are easy to get wrong

- **The agent is text-only.** The model sees an ARIA snapshot with `[ref=…]` on each
  element, never a screenshot. Elements are located strictly by that ref
  (`aria-ref=e12`, or `aria-ref=f1e2` inside an iframe). If you touch ref handling,
  keep both forms working.
- **Two providers, one history format.** Conversation history is always in Anthropic's
  message format. The OpenAI-compatible path converts it in `lib/provider.ts`, so the
  agent loop never needs to know which provider it talks to. Test both if you change
  messages or tool schemas.
- **Step statuses live in three places.** The `report_step` enum in `lib/tools.ts`, the
  system prompt in `lib/agent.ts`, and `StepStatus` in `lib/types.ts` (plus the colours
  on the run page). Change one, change all.
- **UI strings go into both dictionaries.** Add a key to `Dict` and to both `en` and `ru`
  in `lib/i18n.ts`; the build fails otherwise, on purpose.
- **Prompt changes are behaviour changes.** Small edits to `SYSTEM` in `lib/agent.ts`
  can shift how the agent acts on many sites. Say in the PR what you changed and why,
  and what you ran to check it.
- **State is in memory.** Runs disappear on restart and on hot reload during
  `npm run dev`. That is expected.

## Adding a tool for the agent

1. Add its schema to `TOOLS` in `lib/tools.ts` (`name`, `description`, `input_schema`).
2. Handle it in `executeTool` in `lib/agent.ts`. Actions that change the page should
   return a fresh snapshot, as the existing ones do.
3. Tell the model when to use it in `SYSTEM`, if the description alone isn't enough.
4. If it should appear readably in the run log, render it on the run page.

## Code style

- Code, comments, UI strings and prompts are in English.
- TypeScript, matching the style of the file you are in. The import alias `@/` points
  to the repo root.
- UI uses Tailwind and shadcn/ui components from `components/ui/`.
- API routes set `runtime = "nodejs"` and `dynamic = "force-dynamic"`.

## Pull requests

- Fork the repo and branch from `main`.
- Keep a PR to one change. Link the issue it fixes (`Fixes #7`).
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org):
  `feat: …`, `fix: …`, `docs: …`.
- For UI changes, add a screenshot or a short recording.
- Don't bump the version in `package.json` — maintainers do that when releasing.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
