import { NextRequest, NextResponse } from "next/server";
import { removeRepo, switchBranch } from "@/lib/repos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Switch the repo to another branch: { branch }. Returns the repo and its files. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { branch?: unknown };
  if (typeof body.branch !== "string" || !body.branch.trim()) {
    return NextResponse.json({ error: "branch is required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await switchBranch(id, body.branch));
  } catch (err) {
    const status = (err as { status?: number }).status ?? 502;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}

/** Forget the repository and delete its local clone (the remote is untouched). */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await removeRepo(id);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
  return NextResponse.json({ ok: true });
}
