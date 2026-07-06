/**
 * Per-IP rate limiting + a global concurrency gate, shared by every LLM/API route.
 *
 * Two independent primitives:
 * - `RateLimiter` (`InMemoryRateLimiter` / `getRateLimiter`): a sliding-window-ish fixed-window
 *   counter, keyed by `${routeName}:${clientKey}`. The counting algorithm's backing store is
 *   injectable (`RateLimitStore`) so tests can swap in a fake store or drive a fake clock without
 *   real sleeps. `getRateLimiter()` is the runtime factory: it prefers a durable Upstash Redis
 *   backend when creds are present (shared across serverless instances), and otherwise falls back
 *   to the injectable in-memory limiter (per-instance only — see the doc comment on
 *   `getRateLimiter` below).
 * - `createConcurrencyGate`: a plain in-process counter bounding simultaneous in-flight LLM
 *   streams (real Anthropic spend per request). Always per-instance by design — see its doc
 *   comment.
 */

// ---------------------------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------------------------

export interface RateLimitDecision {
  success: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the client should retry. Always >= 1 so a literal `Retry-After: 0` never ships. */
  retryAfterSec: number;
}

export interface RateLimiter {
  limit(key: string): Promise<RateLimitDecision>;
}

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

/** Injectable backing store for `InMemoryRateLimiter` — a fixed-window hit counter per key. */
export interface RateLimitStore {
  increment(key: string, windowMs: number, now: number): { count: number; resetAt: number };
}

/**
 * Default store: an in-process `Map`, one bucket per key. A key that keeps requesting
 * self-overwrites its bucket when the window elapses, but a key that goes quiet (IP churn) would
 * otherwise leave a permanent entry for the instance's life — so once the map reaches
 * `sweepThreshold` entries, each `increment` first sweeps out every fully-expired bucket
 * (`now >= resetAt`). The sweep is O(size) but rare: it only runs while at/above the threshold,
 * and one pass removes everything sweepable. (Degenerate worst case — `sweepThreshold`+ distinct
 * IPs all inside one live window — re-scans per call until windows expire; at the 5,000 default
 * that is an acceptable demo-scale cost, and the Upstash backend sidesteps it entirely.)
 */
export class MapRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly sweepThreshold = 5_000) {}

  /** Current bucket count — exposed for the eviction test only. */
  get size(): number {
    return this.buckets.size;
  }

  increment(key: string, windowMs: number, now: number): { count: number; resetAt: number } {
    if (this.buckets.size >= this.sweepThreshold) {
      for (const [k, v] of this.buckets) {
        if (now >= v.resetAt) this.buckets.delete(k);
      }
    }
    const existing = this.buckets.get(key);
    if (!existing || now >= existing.resetAt) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, fresh);
      return fresh;
    }
    existing.count += 1;
    return existing;
  }
}

/**
 * Fixed-window rate limiter. The store and clock are both injected (constructor params 2 and 3)
 * so unit tests can use a fake store/clock instead of real `Date.now()` + a hidden module-global
 * `Map` — see `rateLimit.test.ts`.
 */
export class InMemoryRateLimiter implements RateLimiter {
  constructor(
    private readonly opts: RateLimitOptions,
    private readonly store: RateLimitStore = new MapRateLimitStore(),
    private readonly now: () => number = Date.now,
  ) {}

  async limit(key: string): Promise<RateLimitDecision> {
    const t = this.now();
    const { count, resetAt } = this.store.increment(key, this.opts.windowMs, t);
    return {
      success: count <= this.opts.limit,
      limit: this.opts.limit,
      remaining: Math.max(0, this.opts.limit - count),
      retryAfterSec: Math.max(1, Math.ceil((resetAt - t) / 1000)),
    };
  }
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_RPM = 10;

/** `RATE_LIMIT_RPM` env var, or the sane default documented in `.env.demo.example`. */
export function getRpmLimit(): number {
  const raw = process.env.RATE_LIMIT_RPM;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RATE_LIMIT_RPM;
}

// One in-memory store + one Upstash-backed limiter per route name, memoized so we don't rebuild a
// Redis client (or lose in-memory counters) on every request. `resetRateLimitersForTests` below
// clears this cache; production code never needs to.
const limiterCache = new Map<string, RateLimiter>();
const inMemoryStores = new Map<string, MapRateLimitStore>();

/**
 * Runtime factory: prefers `@upstash/ratelimit` + `@upstash/redis` when
 * `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are set (a durable, cross-instance store —
 * correct on Vercel, where each request can land on a different function instance). Otherwise
 * falls back to `InMemoryRateLimiter`, which is **per-instance only**: on Vercel this means each
 * warm serverless instance enforces its own independent budget (an instance that has served 10
 * requests this minute and a freshly-spun-up sibling instance both allow their own 10), so the
 * *effective* ceiling scales with concurrent instance count rather than being a hard global cap.
 * That's an accepted limitation for this demo (documented here + in `.env.demo.example`) — real
 * Upstash creds close the gap and are wired up at deploy time. Locally (`next dev`,
 * single process) the in-memory limiter is exact.
 */
export async function getRateLimiter(routeName: string, opts: RateLimitOptions): Promise<RateLimiter> {
  const cacheKey = `${routeName}:${opts.limit}:${opts.windowMs}`;
  const cached = limiterCache.get(cacheKey);
  if (cached) return cached;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  let limiter: RateLimiter;
  if (url && token) {
    const [{ Redis }, { Ratelimit }] = await Promise.all([
      import("@upstash/redis"),
      import("@upstash/ratelimit"),
    ]);
    const redis = new Redis({ url, token });
    const ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(opts.limit, `${Math.ceil(opts.windowMs / 1000)} s`),
      prefix: `sift:ratelimit:${routeName}`,
    });
    limiter = {
      async limit(key: string): Promise<RateLimitDecision> {
        const res = await ratelimit.limit(key);
        return {
          success: res.success,
          limit: res.limit,
          remaining: res.remaining,
          retryAfterSec: Math.max(1, Math.ceil((res.reset - Date.now()) / 1000)),
        };
      },
    };
  } else {
    let store = inMemoryStores.get(routeName);
    if (!store) {
      store = new MapRateLimitStore();
      inMemoryStores.set(routeName, store);
    }
    limiter = new InMemoryRateLimiter(opts, store);
  }

  limiterCache.set(cacheKey, limiter);
  return limiter;
}

/** Test-only: clear memoized limiters/stores so route tests in one file don't share rate-limit
 * budget with each other across `it()` blocks. Production code never calls this. */
export function resetRateLimitersForTests(): void {
  limiterCache.clear();
  inMemoryStores.clear();
}

// ---------------------------------------------------------------------------------------------
// Client key extraction
// ---------------------------------------------------------------------------------------------

const LOCAL_DEV_KEY = "local-dev";

/**
 * Per-IP key for rate limiting. On Vercel, `x-forwarded-for` carries the real client IP as its
 * first (leftmost) hop — Vercel's edge network appends/overwrites this header itself, so it is
 * not attacker-spoofable there (a client-supplied `x-forwarded-for` is replaced, not merged, by
 * Vercel's proxy). `x-real-ip` is a fallback some proxies set instead. Neither header is trusted
 * blindly for anything beyond bucketing rate-limit counters — worst case of a spoofed key is a
 * client sharing (or evading) someone else's budget, not a security bypass elsewhere. When
 * neither header is present (local `next dev`, direct `fetch`/test calls with no proxy in front),
 * fall back to one constant key: local dev has no multi-tenant IP to distinguish, and this keeps
 * the limiter well-defined instead of silently keying on `undefined`.
 */
export function getClientKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return LOCAL_DEV_KEY;
}

// ---------------------------------------------------------------------------------------------
// Concurrency gate (review route only — bounds simultaneous in-flight Anthropic calls)
// ---------------------------------------------------------------------------------------------

export interface ConcurrencyGate {
  tryAcquire(): boolean;
  release(): void;
  readonly active: number;
}

/**
 * A plain in-process counter, deliberately **not** backed by Upstash/Redis: it bounds concurrent
 * in-flight LLM streams *on this instance*, which is exactly the spend this instance can commit
 * to right now. Making it cross-instance would need a distributed semaphore (extra latency + a
 * new failure mode) to protect a demo; per-instance is accepted here, same as the brief calls out.
 * `release()` is safe to call more than once (idempotent floor at 0) so callers can wire it into
 * multiple exit paths (stream done / error / client-cancel) without tracking which one fired
 * first — see the `release()`-guard pattern in the review route.
 */
export function createConcurrencyGate(max: number): ConcurrencyGate {
  let active = 0;
  return {
    tryAcquire(): boolean {
      if (active >= max) return false;
      active += 1;
      return true;
    },
    release(): void {
      if (active > 0) active -= 1;
    },
    get active() {
      return active;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Shared response helpers — generic bodies only, no internals leaked (matches the existing
// 400/500 error-shape convention in the review/memo/answer routes).
// ---------------------------------------------------------------------------------------------

export function rateLimitedResponse(decision: RateLimitDecision): Response {
  return new Response(JSON.stringify({ error: "rate limit exceeded, try again shortly" }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(decision.retryAfterSec),
      "x-ratelimit-limit": String(decision.limit),
      "x-ratelimit-remaining": String(decision.remaining),
    },
  });
}

/** Concurrency-cap saturation: 503 (server temporarily can't take more work) rather than 429
 * (client exceeded its own budget) — this isn't the caller's per-IP quota, it's shared instance
 * capacity being momentarily full. Documented per the brief's "your call" on 429 vs 503. */
export function concurrencySaturatedResponse(retryAfterSec = 5): Response {
  return new Response(JSON.stringify({ error: "server busy, try again shortly" }), {
    status: 503,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfterSec),
    },
  });
}
