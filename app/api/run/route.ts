import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { createRun } from "@/lib/store";
import { runAgent } from "@/lib/agent";
import { providerConfigError, resolveProvider } from "@/lib/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const cfgError = providerConfigError(resolveProvider());
  if (cfgError) {
    return NextResponse.json({ error: cfgError }, { status: 500 });
  }

  let body: { testCase?: unknown; headless?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const testCase = typeof body.testCase === "string" ? body.testCase.trim() : "";
  if (!testCase) {
    return NextResponse.json({ error: "testCase is required" }, { status: 400 });
  }

  const headless = body.headless !== false;
  const title = firstNonEmptyLine(testCase) || "Untitled test";
  const id = crypto.randomBytes(6).toString("hex");
  createRun(id, title, testCase);

  runAgent(id, testCase, headless).catch((err) => {
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
