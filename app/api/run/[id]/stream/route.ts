import { NextRequest } from "next/server";
import { getRun, subscribe } from "@/lib/store";
import type { Run } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIVE = new Set(["running", "waiting", "paused"]);

// Protocol: every frame carries the CURRENT Run in full (minus the events array,
// which is heavy and only needed for the log). The first frame also carries the
// event backlog; later frames carry one new event. The client just calls setRun().
function frame(run: Run, extra: Record<string, unknown>): string {
  const { events: _events, ...lite } = run;
  return `data: ${JSON.stringify({ run: lite, ...extra })}\n\n`;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) {
    return new Response("not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsub = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const close = () => {
        unsub();
        try {
          controller.close();
        } catch {
          // already closed (client disconnected) — fine
        }
      };

      controller.enqueue(encoder.encode(frame(run, { events: run.events })));
      if (!ACTIVE.has(run.status)) {
        // run already finished — sent the snapshot and closed
        setTimeout(close, 200);
        return;
      }

      unsub = subscribe(id, (event) => {
        controller.enqueue(encoder.encode(frame(run, { event })));
        if (!ACTIVE.has(run.status)) setTimeout(close, 200);
      });
    },
    cancel() {
      unsub();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
