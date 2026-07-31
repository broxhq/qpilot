import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { createRun } from "@/lib/store";
import { runAgent } from "@/lib/agent";
import { MAX_FILE_BYTES, MAX_FILES, saveUploads } from "@/lib/attachments";
import { providerConfigError, resolveProvider } from "@/lib/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// formData() buffers the whole request in memory, so reject obvious floods
// before parsing rather than after.
const MAX_TOTAL_BYTES = MAX_FILES * MAX_FILE_BYTES;

interface RunInput {
  testCase: string;
  headless: boolean;
  files: File[];
}

/** Accepts multipart/form-data (test case + attachments) and plain JSON. */
async function readInput(req: NextRequest): Promise<RunInput> {
  if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const size = Number(req.headers.get("content-length") ?? 0);
    if (size > MAX_TOTAL_BYTES) {
      throw new Error(
        `Attachments are too large (limit ${MAX_TOTAL_BYTES / 1024 / 1024} MB in total)`,
      );
    }
    const form = await req.formData();
    return {
      testCase: String(form.get("testCase") ?? "").trim(),
      headless: form.get("headless") !== "false",
      files: form.getAll("files").filter((f): f is File => f instanceof File),
    };
  }

  const body = (await req.json()) as { testCase?: unknown; headless?: unknown };
  return {
    testCase: typeof body.testCase === "string" ? body.testCase.trim() : "",
    headless: body.headless !== false,
    files: [],
  };
}

export async function POST(req: NextRequest) {
  const cfgError = providerConfigError(resolveProvider());
  if (cfgError) {
    return NextResponse.json({ error: cfgError }, { status: 500 });
  }

  let input: RunInput;
  try {
    input = await readInput(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid request body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (!input.testCase) {
    return NextResponse.json({ error: "testCase is required" }, { status: 400 });
  }

  const id = crypto.randomBytes(6).toString("hex");

  let files;
  try {
    files = await saveUploads(id, input.files);
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not save attachments";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const title = firstNonEmptyLine(input.testCase) || "Untitled test";
  createRun(id, title, input.testCase, files);

  runAgent(id, input.testCase, input.headless).catch((err) => {
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
