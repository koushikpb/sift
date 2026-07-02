import { describe, it, expect } from "vitest";
import {
  InMemoryRateLimiter,
  MapRateLimitStore,
  createConcurrencyGate,
  getClientKey,
  type RateLimitStore,
} from "./rateLimit";

describe("InMemoryRateLimiter", () => {
  it("allows N requests per window then blocks the N+1th", async () => {
    const limiter = new InMemoryRateLimiter({ limit: 3, windowMs: 60_000 });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.limit("ip-1"));
    expect(results.map((r) => r.success)).toEqual([true, true, true, false]);
  });

  it("reports decreasing remaining down to 0, never negative", async () => {
    const limiter = new InMemoryRateLimiter({ limit: 2, windowMs: 60_000 });
    const first = await limiter.limit("ip-2");
    const second = await limiter.limit("ip-2");
    const third = await limiter.limit("ip-2");
    expect(first.remaining).toBe(1);
    expect(second.remaining).toBe(0);
    expect(third.remaining).toBe(0);
  });

  it("tracks separate keys independently", async () => {
    const limiter = new InMemoryRateLimiter({ limit: 1, windowMs: 60_000 });
    expect((await limiter.limit("a")).success).toBe(true);
    expect((await limiter.limit("b")).success).toBe(true);
    expect((await limiter.limit("a")).success).toBe(false);
  });

  it("resets after the window elapses (fake clock, no real sleep)", async () => {
    let now = 0;
    const limiter = new InMemoryRateLimiter(
      { limit: 1, windowMs: 1_000 },
      new MapRateLimitStore(),
      () => now,
    );
    expect((await limiter.limit("k")).success).toBe(true);
    expect((await limiter.limit("k")).success).toBe(false);
    now += 999;
    expect((await limiter.limit("k")).success).toBe(false); // window not yet elapsed
    now += 1;
    expect((await limiter.limit("k")).success).toBe(true); // window elapsed, counter resets
  });

  it("retryAfterSec reflects time left in the current window", async () => {
    let now = 0;
    const limiter = new InMemoryRateLimiter(
      { limit: 1, windowMs: 10_000 },
      new MapRateLimitStore(),
      () => now,
    );
    await limiter.limit("k");
    now += 4_000;
    const blocked = await limiter.limit("k");
    expect(blocked.success).toBe(false);
    expect(blocked.retryAfterSec).toBe(6); // 10s window - 4s elapsed
  });

  it("evicts fully-expired buckets at the sweep threshold — live keys and their counts survive (no leak under IP churn)", async () => {
    let now = 0;
    const store = new MapRateLimitStore(5); // low threshold so the test doesn't need 5,000 keys
    const limiter = new InMemoryRateLimiter({ limit: 3, windowMs: 1_000 }, store, () => now);

    // 4 churn keys at t=0 (windows reset at t=1000)...
    for (let i = 0; i < 4; i++) await limiter.limit(`stale-${i}`);
    // ...then a live key at t=500 (window resets at t=1500), twice — count 2. The second call runs
    // at size === threshold, so a sweep fires but evicts nothing (nothing is expired yet at t=500).
    now = 500;
    await limiter.limit("live");
    await limiter.limit("live");
    expect(store.size).toBe(5);

    // t=1000: the 4 stale windows are fully expired (now >= resetAt); "live" is not. A call for a
    // brand-new key sweeps the stale entries before inserting.
    now = 1_000;
    await limiter.limit("fresh");
    expect(store.size).toBe(2); // live + fresh — the 4 stale buckets were evicted, the map shrank

    // The surviving live bucket kept its count: this third hit reaches limit 3 → remaining 0.
    const third = await limiter.limit("live");
    expect(third.success).toBe(true);
    expect(third.remaining).toBe(0);
  });

  it("uses the injected store (not a hidden internal Map) — proves the store is genuinely injectable", async () => {
    let calls = 0;
    const fakeStore: RateLimitStore = {
      increment(_key, windowMs, now) {
        calls += 1;
        return { count: 1, resetAt: now + windowMs };
      },
    };
    const limiter = new InMemoryRateLimiter({ limit: 5, windowMs: 1_000 }, fakeStore);
    await limiter.limit("x");
    await limiter.limit("x");
    expect(calls).toBe(2);
  });
});

describe("createConcurrencyGate", () => {
  it("allows up to max concurrent acquisitions, blocks beyond, and release frees a slot", () => {
    const gate = createConcurrencyGate(2);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false); // saturated
    gate.release();
    expect(gate.tryAcquire()).toBe(true); // freed slot reusable
    expect(gate.active).toBe(2);
  });

  it("release() is safe to call without a matching acquire (idempotent releaseSlot pattern)", () => {
    const gate = createConcurrencyGate(1);
    gate.release(); // no-op, must not underflow below 0
    gate.release();
    expect(gate.active).toBe(0);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false);
  });
});

describe("getClientKey", () => {
  it("uses the first hop of x-forwarded-for when present", () => {
    const req = new Request("http://localhost/api/review", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    expect(getClientKey(req)).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const req = new Request("http://localhost/api/review", {
      headers: { "x-real-ip": "9.9.9.9" },
    });
    expect(getClientKey(req)).toBe("9.9.9.9");
  });

  it("falls back to a constant for local dev when neither header is present", () => {
    const req = new Request("http://localhost/api/review");
    expect(getClientKey(req)).toBe(getClientKey(new Request("http://localhost/other")));
  });
});
