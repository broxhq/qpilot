import { NextRequest } from "next/server";
import { getScreenshot } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step screenshots (fail/warn) live in the store as JPEG buffers and are served
// here via the URL in StepResult.screenshot — never inlined into SSE events.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; num: string }> },
) {
  const { id, num } = await params;
  const buf = getScreenshot(id, Number(num));
  if (!buf) return new Response("not found", { status: 404 });

  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
