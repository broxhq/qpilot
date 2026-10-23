import { NextRequest, NextResponse } from "next/server";
import { addRepo, listRepos } from "@/lib/repos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await listRepos());
}

/** Connect a repository: clones it and returns it with its .md files. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  if (!str(body.url)?.trim()) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }
  try {
    const result = await addRepo({
      url: str(body.url)!,
      branch: str(body.branch),
      path: str(body.path),
      username: str(body.username),
      token: str(body.token),
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
