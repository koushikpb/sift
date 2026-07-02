import { streamAnswer, sseEncode } from "@sift/core/serve";
import type { AnswerDeps } from "@sift/core/serve";
import { getRateLimiter, getRpmLimit, getClientKey, rateLimitedResponse } from "../../../src/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  // Legacy route — same per-IP limit as /api/review (also triggers LLM calls). Rate limit runs
  // before any parsing, same ordering as the other two routes.
  const clientKey = getClientKey(request);
  const limiter = await getRateLimiter("answer", { limit: getRpmLimit(), windowMs: 60_000 });
  const decision = await limiter.limit(clientKey);
  if (!decision.success) {
    return rateLimitedResponse(decision);
  }

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

  const [{ makeRetriever }, { makeGenerator }] = await Promise.all([
    import("@sift/core/retrieve"),
    import("@sift/core/generate"),
  ]);

  const kParsed = kParam != null ? parseInt(kParam, 10) : undefined;
  const k = kParsed !== undefined && (isNaN(kParsed) || kParsed < 1) ? undefined : kParsed;

  const gen = makeGenerator();
  const deps: AnswerDeps = {
    retrieve: makeRetriever(process.env.RETRIEVE_MODE),
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
