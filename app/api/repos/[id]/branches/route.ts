import { NextRequest, NextResponse } from "next/server";
import { listBranches } from "@/lib/repos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Branches on the remote: { branches, defaultBranch, current }. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    return NextResponse.json(await listBranches(id));
  } catch (err) {
    const status = (err as { status?: number }).status ?? 502;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
