import { NextRequest, NextResponse } from "next/server";
import { readRepoFile } from "@/lib/repos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Text of one test case: GET /api/repos/<id>/file?path=<path from the file list>. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const rel = req.nextUrl.searchParams.get("path") ?? "";
  try {
    const text = await readRepoFile(id, rel);
    return new Response(text, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
