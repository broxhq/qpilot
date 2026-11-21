import { NextRequest, NextResponse } from "next/server";
import { getRun, stopRun } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** End the run now, whatever it is doing. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getRun(id)) return NextResponse.json({ error: "run not found" }, { status: 404 });
  if (!stopRun(id)) return NextResponse.json({ error: "run is not in progress" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
