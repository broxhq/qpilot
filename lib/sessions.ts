// Sign-ins kept between runs.
//
// Every run starts a fresh browser, so every run began with a login: a phone
// number, a code from an app, a person waiting at the keyboard. A tester's own
// browser remembers them. This does the same: when a run ends, the cookies and
// site storage of its browser are written to ~/.qpilot/session.json, and the
// next run starts with them.
//
// The file holds session tokens — the same thing a browser profile holds. It is
// readable by its owner only, never sent to the model and never shown in the UI
// (only the site names are). QPILOT_SESSIONS=0 turns the feature off; the
// Settings page forgets what is saved.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { QPILOT_HOME } from "./config";

export const SESSION_PATH = join(QPILOT_HOME, "session.json");

export type SessionState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export const sessionsEnabled = () => !["0", "false"].includes(process.env.QPILOT_SESSIONS ?? "");

const bare = (domain: string) => domain.replace(/^\./, "").toLowerCase();

/** Is `domain` (of a cookie or an origin) one of the sites in `hosts`, or a parent of one? */
function among(domain: string, hosts: Set<string>): boolean {
  const d = bare(domain);
  for (const h of hosts) if (h === d || h.endsWith(`.${d}`)) return true;
  return false;
}

const hostOf = (origin: string) => {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return origin.toLowerCase();
  }
};

/** What is saved, or null when nothing is (or the feature is off). */
export function loadSession(): SessionState | null {
  if (!sessionsEnabled()) return null;
  try {
    const raw = JSON.parse(readFileSync(SESSION_PATH, "utf-8")) as Partial<SessionState>;
    if (!Array.isArray(raw?.cookies) || !Array.isArray(raw?.origins)) return null;
    return { cookies: raw.cookies, origins: raw.origins };
  } catch {
    return null;
  }
}

function write(state: SessionState): void {
  mkdirSync(QPILOT_HOME, { recursive: true, mode: 0o700 });
  const tmp = `${SESSION_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, SESSION_PATH);
}

/**
 * Keeps the browser state a run ended with. For the sites the run talked to
 * (`touched`) its state is the truth — including a sign-out; everything else is
 * left as the file has it, so that two runs on different sites at the same time
 * do not wipe each other's sign-ins.
 */
export function saveSession(state: SessionState, touched: Set<string>): void {
  if (!sessionsEnabled()) return;
  const before = loadSession() ?? { cookies: [], origins: [] };
  write({
    cookies: [
      ...before.cookies.filter((c) => !among(c.domain, touched)),
      ...state.cookies.filter((c) => among(c.domain, touched)),
    ],
    origins: [
      ...before.origins.filter((o) => !among(hostOf(o.origin), touched)),
      ...state.origins.filter((o) => among(hostOf(o.origin), touched)),
    ],
  });
}

/** The sites something is saved for — names only, for the Settings page. */
export function sessionSites(): string[] {
  const state = loadSession();
  if (!state) return [];
  const sites = new Set<string>();
  for (const o of state.origins) sites.add(hostOf(o.origin));
  for (const c of state.cookies) sites.add(bare(c.domain));
  return [...sites].sort();
}

/** Forgets everything saved. Returns whether there was anything. */
export function forgetSession(): boolean {
  const had = existsSync(SESSION_PATH);
  rmSync(SESSION_PATH, { force: true });
  return had;
}
