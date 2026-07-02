import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Dep-construction path (see route.ts): keep it trivially successful so these tests exercise the
// rate-limit / concurrency-cap / validation ordering, not the real retriever/generator/DB.
vi.mock("@sift/core/retrieve", () => ({
  makeRetriever: () => () => Promise.resolve([]),
}));
vi.mock("@sift/core/generate", () => ({
  makeGenerator: () => ({ generate: async () => ({}) }),
}));
vi.mock("@sift/core/agent", () => ({
  buildReviewDeps: () => ({}),
}));

// A controllable async generator standing in for reviewContract's real stream: yields one
// "status" event, then parks on a promise this file controls (`hold`) so tests can grab the
// stream mid-flight (concurrency slot still held) before letting it finish.
let hold: (() => void) | null = null;
vi.mock("@sift/core/serve/review", () => ({
  sseEncode: (event: unknown) => `data: ${JSON.stringify(event)}\n\n`,
  streamReview: async function* () {
    yield { type: "status", phase: "retrieve_clause", message: "Retrieving the clause…" };
    await new Promise<void>((resolve) => {
      hold = resolve;
    });
    yield { type: "done" };
  },
}));

function req(params: Record<string, string>): Request {
  const url = new URL("http://localhost/api/review");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url);
}

describe("GET /api/review — rate limit ordering + concurrency cap", () => {
  beforeEach(() => {
    // Fresh module graph per test: route.ts (and the rateLimit.ts singleton it imports) get
    // re-evaluated, so each test starts with an empty rate-limit bucket and picks up the
    // REVIEW_MAX_CONCURRENCY set below without needing to touch route.ts's internals directly.
    vi.resetModules();
    hold = null;
  });

  afterEach(() => {
    delete process.env.REVIEW_MAX_CONCURRENCY;
    delete process.env.RATE_LIMIT_RPM;
    hold?.(); // let any parked generator resolve so nothing dangles across tests
  });

  it("rate limit runs BEFORE validation: N invalid-docId requests get 400, the N+1th gets 429 with Retry-After", async () => {
    process.env.RATE_LIMIT_RPM = "5";
    const { GET } = await import("./route");

    for (let i = 0; i < 5; i++) {
      const res = await GET(req({ docId: "not-a-curated-doc", objective: "x" }));
      expect(res.status).toBe(400);
    }
    const blocked = await GET(req({ docId: "not-a-curated-doc", objective: "x" }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    const body = await blocked.json();
    expect(typeof body.error).toBe("string");
    expect(body.error.toLowerCase()).not.toContain("zod");
  });

  it("objective over the length cap is rejected with 400, not silently truncated", async () => {
    process.env.RATE_LIMIT_RPM = "10";
    const { GET } = await import("./route");
    const res = await GET(req({ docId: "contractnli_1", objective: "x".repeat(501) }));
    expect(res.status).toBe(400);
  });

  it("saturates the concurrency cap (503) while a stream is in flight, and releases the slot on client cancel — not just on done", async () => {
    process.env.REVIEW_MAX_CONCURRENCY = "1";
    process.env.RATE_LIMIT_RPM = "10";
    const { GET } = await import("./route");

    const first = await GET(req({ docId: "contractnli_1", objective: "first" }));
    expect(first.status).toBe(200);
    const reader = first.body!.getReader();
    await reader.read(); // consume the "status" event; the mocked generator is now parked on `hold`

    // Cap is 1 and the first stream is still open (generator parked) — second request must be
    // rejected as capacity-saturated, not silently queued or allowed through.
    const second = await GET(req({ docId: "contractnli_1", objective: "second" }));
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBeTruthy();

    // Simulate a client disconnect (tab closed / fetch aborted) instead of letting the stream
    // reach "done" — this must free the slot via the ReadableStream's cancel() callback.
    await reader.cancel();

    const third = await GET(req({ docId: "contractnli_1", objective: "third" }));
    expect(third.status).toBe(200);
  });
});
