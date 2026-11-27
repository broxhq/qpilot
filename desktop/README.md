# qpilot as an app

The same qpilot, with nothing to install first: an icon to click instead of Node
and a terminal. The app is a window around the built server — the one `npx qpilot`
starts — which it runs with its own Node. Chrome is still the user's own.

```bash
npm run build                    # in the repository root: the server the app carries
npm --prefix desktop ci
npm --prefix desktop start       # the app from the sources
npm --prefix desktop run dist    # a .dmg (macOS) or an installer (Windows) in desktop/dist
node desktop/smoke.mjs --packed  # the packed app runs a test case against a scripted model
```

- `main.cjs` — the frame: starts the server on a free port, opens the window,
  sends links to other sites to the browser, stops the server when the app quits
  (or dies), says when a newer version is out.
- `build.mjs` — packing, and what signing needs.
- `smoke.mjs` — the check CI runs on every system the app is built for.

Settings and saved sign-ins live where the CLI keeps them (`~/.qpilot`), so the
two share them. The server's log is `server.log` in the system's log folder for
qpilot — the file to ask for when the app does not start.

The apps are not signed yet. On the first launch macOS asks to allow the app in
System Settings → Privacy & Security → Open Anyway; Windows shows “Windows
protected your PC” → More info → Run anyway.
