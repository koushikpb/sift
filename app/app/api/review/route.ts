import { z } from "zod";
import { streamReview, sseEncode } from "@sift/core/serve/review";
import {
  getRateLimiter,
  getRpmLimit,
  getClientKey,
  rateLimitedResponse,
  concurrencySaturatedResponse,
  createConcurrencyGate,
} from "../../../src/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Pro; streaming keeps the connection alive

// Curated demo corpus: the only doc_ids with precomputed classify labels in
// `clause_labels`. reviewContract's classify dep looks these up with no Python subprocess.
const CURATED_DOC_IDS = ["contractnli_1", "contractnli_4", "contractnli_6"] as const;

const MAX_OBJECTIVE_LEN = 500;

const QuerySchema = z.object({
  docId: z.enum(CURATED_DOC_IDS),
  objective: z.string().min(1).max(MAX_OBJECTIVE_LEN),
});

// Bounds simultaneous in-flight Anthropic streams (each allowed request costs real LLM money).
// Module-level singleton: one gate per server instance, matching the concurrency it can actually
// commit to. See createConcurrencyGate's doc comment in rateLimit.ts for why this stays
// per-instance rather than distributed.
const REVIEW_MAX_CONCURRENCY = Number.parseInt(process.env.REVIEW_MAX_CONCURRENCY ?? "", 10) || 2;
const reviewConcurrency = createConcurrencyGate(REVIEW_MAX_CONCURRENCY);

export async function GET(request: Request): Promise<Response> {
  // Rate limit runs BEFORE input validation: it protects the (cheap but non-zero) validation work
  // too, and it means a request with a bad docId still gets a real 429 once the caller is over
  // budget — hammering with an invalid docId is exactly how this was smoke-verified live,
  // without spending on the LLM.
  const clientKey = getClientKey(request);
  const limiter = await getRateLimiter("review", { limit: getRpmLimit(), windowMs: 60_000 });
  const decision = await limiter.limit(clientKey);
  if (!decision.success) {
    return rateLimitedResponse(decision);
  }

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    docId: url.searchParams.get("docId"),
    objective: url.searchParams.get("objective"),
  });

  if (!parsed.success) {
    return new Response(
      JSON.stringify({
        error: `Invalid query params: objective (non-empty string, max ${MAX_OBJECTIVE_LEN} chars) and docId (one of ${CURATED_DOC_IDS.join(", ")}) are required`,
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  const { docId, objective } = parsed.data;

  // Concurrency cap: only past this point do we do any real work (dep construction touches the
  // playbook file + generator; the stream below makes the actual LLM calls), so acquire the slot
  // here and release it on every exit path from here on (dep-construction failure, or the stream's
  // start() reaching done/error — see the ReadableStream below). Client disconnect (cancel()) does
  // NOT release the slot early: the underlying LLM run keeps going regardless of whether anyone is
  // still reading the stream, so the slot stays held until that run actually finishes.
  if (!reviewConcurrency.tryAcquire()) {
    return concurrencySaturatedResponse();
  }
  let slotReleased = false;
  const releaseSlot = () => {
    if (!slotReleased) {
      slotReleased = true;
      reviewConcurrency.release();
    }
  };

  // Dep construction (dynamic imports, makeGenerator, buildReviewDeps's synchronous playbook file
  // read) happens before any stream exists, so it can't be guarded by the ReadableStream's own
  // try/catch below. A missing/bad env (e.g. DATABASE_URL, LLM_PROVIDER) or an unreadable playbook
  // file must not surface as an unhandled rejection or a stack trace to the client — report a
  // generic 500 instead. This block is scoped to this route only; the success-path streaming
  // control flow below is unchanged.
  let deps;
  try {
    const [{ makeRetriever }, { makeGenerator }, { buildReviewDeps }] = await Promise.all([
      import("@sift/core/retrieve"),
      import("@sift/core/generate"),
      import("@sift/core/agent"),
    ]);

    const gen = makeGenerator();
    deps = buildReviewDeps(docId, {
      retrieve: makeRetriever(process.env.RETRIEVE_MODE),
      generate: gen.generate.bind(gen),
    });
  } catch (err) {
    releaseSlot();
    console.error("review route: dependency construction failed:", err);
    return new Response(
      JSON.stringify({ error: "insufficient server configuration" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

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
      } catch {
        // Enqueueing after the client has cancelled the stream throws here; the concurrency slot
        // and controller are still cleaned up below regardless.
      } finally {
        releaseSlot();
        try { controller.close(); } catch { /* already closed/cancelled */ }
      }
    },
    // Client disconnect (tab closed, fetch aborted) invokes cancel() — deliberately NOT wired to
    // releaseSlot(). Cancelling the reader doesn't abort the in-flight reviewContract call; the
    // for-await loop in start() keeps running the real LLM pipeline regardless. Releasing the slot
    // here would let a connect-and-cancel loop hold unbounded concurrent LLM pipelines despite the
    // cap. The slot is freed exactly once, in start()'s finally below, once the generator actually
    // finishes — bounded by the existing 45s per-call LLM timeout + retry, not by client behavior.
    cancel() {},
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
