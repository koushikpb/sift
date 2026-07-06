# P6 Deploy Smoke — Vercel + Neon (2026-07-04)

**Deployment under test:** `https://sift-e7vswfst5-koushikpb1.vercel.app` (preview, branch
`phase-6-deploy-wrapup` @ `bd1d046`; Root Directory `app/`, Node 20, Neon Postgres via
`DATABASE_URL`, Anthropic `claude-sonnet-4-6` via OpenAI-compat, `RETRIEVE_MODE=lexical`).

**Verdict: PASS** — all checks green. Production URL pending merge to `main`.

## Deploy iterations (what it took to get here)

| # | Commit | Result | Root cause / fix |
|---|--------|--------|------------------|
| 1 | `40384bc` (main) | build FAIL | webpack resolves `new URL("…/.env", import.meta.url)` in `core/src/db/client.ts` as a build asset; `.env` is gitignored → Module-not-found. Fixed in `4ba36d8` (node:path, runtime-only). |
| 2 | `4ba36d8` | build OK, `/api/review` 500 | `DATABASE_URL` never injected (Storage-tab Neon connect didn't cover the function). Fixed by adding `DATABASE_URL` manually as a Vercel env var (Production + Preview). |
| 3 | `3e4c077` | 500 gone, review stream errors in ~3.9s | `@huggingface/transformers` can't fetch/cache bge-large in a Vercel function: read-only FS (`ENOENT: mkdir node_modules/@huggingface/transformers/.cache`). Planned fallback: `RETRIEVE_MODE=lexical`. |
| 4 | `bd1d046` | **PASS** | `makeRetriever` had no `lexical` branch — unknown modes silently fell through to embedder-dependent dense. Wired `lexicalRetrieve` as a first-class mode (TDD: `core/test/retrieve.lexical-routing.test.ts`). |

## Checks

### 1. Security headers (GET `/`)
All present: `content-security-policy` (default-src 'self', frame-ancestors 'none',
object-src 'none'), `strict-transport-security` (2y, includeSubDomains, preload),
`x-content-type-options: nosniff`, `x-frame-options: DENY`,
`referrer-policy: strict-origin-when-cross-origin`, `permissions-policy` (camera/mic/geo off). ✅

### 2. Live streamed review (the paid check)
`GET /api/review?docId=contractnli_4&objective=confidential%20information` → HTTP 200,
`text/event-stream`, 9.2s wall (Neon + Anthropic, warm-ish lambda). Events:
6×`status`, 1×`clause`, 1×`done`. The clause event carried:
- **citation** `{doc_id: contractnli_4, char_start: 1407, char_end: 1615, quote: "6. The Recipient will, on request…"}`
  — **invariant verified**: `quote === raw_text.slice(1407, 1615)` exactly, against
  `data/processed/contractnli/raw.jsonl`. ✅
- **classification** from precomputed `clause_labels` (Post-Termination Services, 0.632) —
  no Python spawn in the lambda. ✅
- **flag** for playbook position `definition_scope` (severity medium, `deviation: false`,
  grounded rationale + citation). ✅

### 3. Grounded refusal (bonus, exercised live)
`objective=confidentiality%20term` → clean stream ending in
`refused: true, refusal_reason: "No candidate clauses were provided…"`. No hallucinated
answer. Cause: `websearch_to_tsquery` ANDs words and "term" appears nowhere in
contractnli_4 (verified by direct FTS counts against Neon: `confidentiality`→6 clauses,
`term`→0). Demo objectives should use document vocabulary (e.g. "confidential information"
→ 6 clauses). ✅ (refusal is a correct answer, per project contract)

### 4. Input validation → rate limit flip
13 sequential `docId=notadoc` requests: `400 ×8` (helpful message naming valid docIds,
no internals leaked) then `429 ×5` — flip exactly at the 10-requests/min fixed window
(2 real review calls earlier in the window + 8 = 10). No LLM spend on any of them. ✅

### 5. Memo HITL confirm-gate
- valid body, **no** `confirm` → 200 `{written: false, preview: "# Contract Review Memo…"}`
- same body + `confirm: true` → 200 `{written: true, markdown: …}`
- invalid body (`{"doc_id":123}`) → 400 `{"error":"invalid memo request"}` ✅

### 6. Browser pass
Deferred to the demo-GIF recording session post-merge (`docs/demo-script.md` is the beat-by-beat
script for it); the API-level checks above covered the full server surface.

## Notes / follow-ups
- **Retrieve-mode qualifier:** hosted demo runs lexical FTS, not the eval-winning
  hybrid — the bge-large query embedder cannot run in a Vercel function (read-only FS +
  cold-start download > 60s budget). Local runs keep `RETRIEVE_MODE=hybrid`. README must
  say so.
- Env vars set manually in Vercel: `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`,
  `LLM_MAX_TOKENS=1024`, `RETRIEVE_MODE=lexical`, `DATABASE_URL` (Neon), on
  Production + Preview.
- pg logs a benign SSL-mode deprecation warning (Neon's `sslmode=require` treated as the
  stricter `verify-full`). No action.
- Vercel skips builds when no file under the Root Directory (or its workspace deps)
  changes — empty commits do NOT trigger deploys.
- Smoke spend: 2 full review streams + 1 refusal stream ≈ well under the $0.30 cap;
  ~$0.20 of the validation budget remains untouched.
