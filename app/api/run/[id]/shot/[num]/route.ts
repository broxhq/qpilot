import { NextRequest } from "next/server";
import { getScreenshot } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Скриншоты шагов (fail/warn) лежат в store как JPEG-буферы и отдаются
// здесь по URL из StepResult.screenshot — в SSE-события они не инлайнятся.
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
