import { NextRequest, NextResponse } from "next/server";
import { syncRepo } from "@/lib/repos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pull the latest commit of the repo's branch; returns the fresh file list. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    return NextResponse.json(await syncRepo(id));
  } catch (err) {
    const status = (err as { status?: number }).status ?? 502;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
