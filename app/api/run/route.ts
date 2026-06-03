import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { createRun } from "@/lib/store";
import { runAgent } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
  }

  let body: { testCase?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const testCase = typeof body.testCase === "string" ? body.testCase.trim() : "";
  if (!testCase) {
    return NextResponse.json({ error: "testCase is required" }, { status: 400 });
  }

  const title = firstNonEmptyLine(testCase) || "Untitled test";
  const id = crypto.randomBytes(6).toString("hex");
  createRun(id, title);

  runAgent(id, testCase, apiKey).catch((err) => {
    console.error("agent crashed", err);
  });

  return NextResponse.json({ id });
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t) return t.slice(0, 80);
  }
  return "";
}
