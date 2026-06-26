import { streamAnswer, sseEncode } from "@sift/core/serve";
import type { AnswerDeps } from "@sift/core/serve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const [{ retrieve }, { makeGenerator }] = await Promise.all([
    import("@sift/core/retrieve"),
    import("@sift/core/generate"),
  ]);

  const kParsed = kParam != null ? parseInt(kParam, 10) : undefined;
  const k = kParsed !== undefined && (isNaN(kParsed) || kParsed < 1) ? undefined : kParsed;

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
        try { controller.close(); } catch { /* already closed/cancelled */ }
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
