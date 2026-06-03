import { NextRequest, NextResponse } from "next/server";
import { answerQuestion, getRun } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  let body: { questionId?: unknown; answer?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const questionId = typeof body.questionId === "string" ? body.questionId : "";
  const answer = typeof body.answer === "string" ? body.answer : "";
  if (!questionId) {
    return NextResponse.json({ error: "questionId required" }, { status: 400 });
  }

  const ok = answerQuestion(id, questionId, answer);
  if (!ok) {
    return NextResponse.json(
      { error: "question not pending (already answered or expired)" },
      { status: 410 },
    );
  }
  return NextResponse.json({ ok: true });
}
