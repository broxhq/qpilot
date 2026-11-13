# Security

## Reporting a problem

Please report it privately:
[open a security advisory](https://github.com/broxhq/qpilot/security/advisories/new).
Do not open a public issue. You will get an answer within a few days.

Fixes go into the latest release only.

## What qpilot does with your data

- It runs on your machine. The only thing that leaves it is the calls to the model
  you configured: the test case text, the page content the agent reads, and — with a
  model that sees images — screenshots of the page.
- The API key is stored in `~/.qpilot/config.json` (mode `600`) and never sent to the
  browser.
- The local API answers only qpilot's own pages on `localhost` / `127.0.0.1`.
- Values typed into password fields, and answers you mark as secret, are masked in
  the run log and the report. Request and response bodies shown to the model have
  tokens, passwords and cookies masked.
- Attached files live in a temporary folder for the duration of the run and are
  deleted when it ends.
