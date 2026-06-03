import { NextRequest, NextResponse } from "next/server";
import { getRun, pauseRun, resumeRun } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const { action } = await req.json().catch(() => ({}));

  if (action === "pause") {
    const ok = pauseRun(id);
    if (!ok) return NextResponse.json({ error: "run is not in running state" }, { status: 409 });
  } else if (action === "resume") {
    const ok = resumeRun(id);
    if (!ok) return NextResponse.json({ error: "run is not paused" }, { status: 409 });
  } else {
    return NextResponse.json({ error: "action must be pause or resume" }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
