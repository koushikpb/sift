export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { streamAnswer, sseEncode } from "@sift/core/serve";
import type { AnswerDeps } from "@sift/core/serve";
import { retrieve } from "@sift/core/retrieve";
import { makeGenerator } from "@sift/core/generate";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const objective = url.searchParams.get("objective");
  const docId = url.searchParams.get("docId");
  const kParam = url.searchParams.get("k");

  if (!objective || !docId) {
    return new Response(
      JSON.stringify({ error: "Missing required query params: objective, docId" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const k = kParam != null ? parseInt(kParam, 10) : undefined;

  const gen = makeGenerator();
  const deps: AnswerDeps = {
    retrieve,
    generate: gen.generate.bind(gen),
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of streamAnswer(objective, docId, deps, k)) {
          controller.enqueue(encoder.encode(sseEncode(event)));
          if (event.type === "done") {
            break;
          }
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
