import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Web hardening: security headers on every response — pages and API routes alike (the
 * matcher below excludes only Next's own static asset paths). Runs before any route handler, so
 * headers land on error responses too.
 *
 * CSP is pragmatic, not maximal — the operative constraint is "must not break Next.js
 * hydration/inline runtime or the EventSource flow":
 * - `script-src 'self' 'unsafe-inline'`: Next 15's App Router streams React 19 hydration data via
 *   inline `<script>` tags injected during SSR (`self.__next_f.push(...)`), and next/font emits an
 *   inline `<style>` block for @font-face rules (see `style-src` below). Locking these down
 *   properly needs a per-request nonce threaded from this middleware through the root layout
 *   (reading a header via `next/headers`) into every such tag Next generates itself — real, but
 *   out of scope here (middleware.ts + routes only; no layout.tsx involvement).
 *   `'unsafe-inline'` is the documented, common trade-off Next.js's own CSP
 *   guide falls back to without nonce wiring. `'unsafe-eval'` is deliberately NOT included in
 *   production; it's added only in development, where Next's HMR/fast-refresh client depends on
 *   `eval()`-based source maps (dev-only, matches `next dev`, which is what live verification
 *   runs against).
 * - `style-src 'self' 'unsafe-inline'`: the next/font inline @font-face `<style>` tag above.
 * - `connect-src 'self'`: same-origin only — this is what the review page's `EventSource` (SSE
 *   over `/api/review`) needs; it is same-origin so `'self'` is sufficient without an explicit
 *   allowance (EventSource honors `connect-src`, not `default-src` alone, in all evergreen
 *   browsers, so this is called out even though `'self'` is also the `default-src`).
 * - `frame-ancestors 'none'` (+ `X-Frame-Options: DENY` as legacy-browser backup): this app is
 *   never meant to be framed.
 * - No `Access-Control-Allow-Origin` header is set anywhere in this app (middleware or routes):
 *   the API is same-origin only, browsers already refuse cross-origin reads of these responses by
 *   default, and no `OPTIONS` preflight handler exists on any route. That absence (verified live
 *   via `curl -I` against the running app) is the "lock CORS to the app origin" requirement —
 *   there is nothing permissive to lock down.
 */
function buildCsp(): string {
  const isDev = process.env.NODE_ENV === "development";
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ];
  return directives.join("; ");
}

const CSP = buildCsp();

export function middleware(_request: NextRequest): NextResponse {
  const response = NextResponse.next();
  const headers = response.headers;

  headers.set("content-security-policy", CSP);
  // HSTS is harmless to send over plain HTTP (browsers only honor it on HTTPS responses per spec)
  // and is required once the demo is on Vercel's HTTPS-only domain.
  headers.set("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");

  return response;
}

export const config = {
  // Everything except Next's own static asset paths (already immutable/hashed, and framing them
  // in a security-headers matcher buys nothing).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
