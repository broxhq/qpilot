import { NextRequest, NextResponse } from "next/server";
import { repoFiles } from "@/lib/repos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** .md files from the local clone — no network, so switching repos is instant. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    return NextResponse.json(await repoFiles(id));
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
