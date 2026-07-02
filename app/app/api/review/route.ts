import { z } from "zod";
import { streamReview, sseEncode } from "@sift/core/serve/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Pro; streaming keeps the connection alive

// Curated demo corpus (Task 4): the only doc_ids with precomputed classify labels in
// `clause_labels`. reviewContract's classify dep looks these up with no Python subprocess.
const CURATED_DOC_IDS = ["contractnli_1", "contractnli_4", "contractnli_6"] as const;

const QuerySchema = z.object({
  docId: z.enum(CURATED_DOC_IDS),
  objective: z.string().min(1),
});

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    docId: url.searchParams.get("docId"),
    objective: url.searchParams.get("objective"),
  });

  if (!parsed.success) {
    return new Response(
      JSON.stringify({
        error: `Invalid query params: objective (non-empty string) and docId (one of ${CURATED_DOC_IDS.join(", ")}) are required`,
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  const { docId, objective } = parsed.data;

  const [{ makeRetriever }, { makeGenerator }, { buildReviewDeps }] = await Promise.all([
    import("@sift/core/retrieve"),
    import("@sift/core/generate"),
    import("@sift/core/agent"),
  ]);

  const gen = makeGenerator();
  const deps = buildReviewDeps(docId, {
    retrieve: makeRetriever(process.env.RETRIEVE_MODE),
    generate: gen.generate.bind(gen),
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of streamReview(objective, docId, deps)) {
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
