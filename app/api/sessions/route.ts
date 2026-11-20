import { NextResponse } from "next/server";
import { SESSION_PATH, forgetSession, sessionSites, sessionsEnabled } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the Settings page shows: the sites a sign-in is saved for. The cookies themselves never leave the server. */
function summary() {
  return { enabled: sessionsEnabled(), path: SESSION_PATH, sites: sessionSites() };
}

export async function GET() {
  return NextResponse.json(summary());
}

/** Forget every saved sign-in. */
export async function DELETE() {
  forgetSession();
  return NextResponse.json(summary());
}
