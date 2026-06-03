import { NextRequest } from "next/server";
import { getRun, subscribe } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // отправить уже накопленные события сразу
      send({ kind: "snapshot", run });

      const unsub = subscribe(id, (event) => {
        send(event);
        if (event.kind === "done" || event.kind === "error") {
          setTimeout(() => {
            unsub();
            controller.close();
          }, 200);
        }
      });

      // если уже завершён — закрыть
      if (run.status !== "running") {
        setTimeout(() => {
          unsub();
          controller.close();
        }, 200);
      }
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
