# P6 — Deploy & Wrap-up: Design

**Status:** approved (user, 2026-07-02).
**Scope source:** `docs/P6-scope.md` (deferred from P5). P5 merged as PR #8 (`40384bc`); this phase
adds no new product capability — it deploys, validates, and closes the project-done gate.

## Goal / success criteria

A public Vercel URL where an interviewer gets a real grounded review in under a minute; memo export
stays confirm-gated; rate limits + security headers verified live against the public URL; a clean
50/50 agent-gate result recorded; README carries the real demo link.

## Decisions (all confirmed with user)

| # | Decision | Choice |
|---|---|---|
| 1 | Hosting | Vercel (user has account), dashboard-connected repo, Root Directory = `app` |
| 2 | Database | **Neon via Vercel Marketplace** (Storage → Create Database → Neon); `DATABASE_URL` auto-injected; free tier; pgvector |
| 3 | Inference | Anthropic (user has key): `claude-sonnet-4-6` via OpenAI-compat, `LLM_MAX_TOKENS=1024` |
| 4 | Retrieve mode | `RETRIEVE_MODE=hybrid` for the deployed demo; README gets a one-line qualifier (agentic loop = documented local mode) |
| 5 | Rate-limit store | No Upstash: in-memory per-instance limiter (already documented as acceptable); creds can be added later without code changes |
| 6 | P5.0 gate re-run | **On Claude** (kills NIM transport noise; ~50 items of spend); report to `docs/eval-reports/`, DECISIONS.md updated |
| 7 | Demo GIF | Claude scripts the walkthrough; user records; Claude embeds |

## 1. Production topology

Vercel hosts the Next.js app (monorepo: install from repo root, `@sift/core` transpiled via
`transpilePackages`). Server-side API routes (`/api/review`, `/api/memo`) call Anthropic and Neon
Postgres. Secrets exist only in the Vercel project env and the user's local `.env` (gitignored);
values never pass through chat or commits.

## 2. Seeding flow (one-time, from the user's machine)

Point `DATABASE_URL` at Neon locally → `npm run migrate` (0001–0007) → load + embed the corpus,
**preferring a curated-only subset** (`contractnli_1`, `contractnli_4`, `contractnli_6`) if the
loader supports filtering — otherwise load the full corpus (fits the free tier; the API allowlist
restricts what's served either way) → `make clf-precompute` → verify 42 `clause_labels` rows and
embedding counts.

## 3. Deploy config

- New `app/vercel.json`: `maxDuration: 60` for `/api/review` and `/api/memo`.
- Vercel project env (user sets in dashboard): `LLM_BASE_URL=https://api.anthropic.com/v1/`,
  `LLM_MODEL=claude-sonnet-4-6`, `LLM_API_KEY`, `LLM_MAX_TOKENS=1024`, `RETRIEVE_MODE=hybrid`,
  plus Neon-injected `DATABASE_URL`.
- Deploy = dashboard-connected repo, main branch (P6 merges before the production deploy is final;
  preview deploys from the phase branch are fine for smoking).

## 4. Validation ladder (each rung gates the next)

1. **Local Anthropic smoke** — user pastes key into local `.env` (Anthropic profile per
   `.env.demo.example`); run the deferred P5-Task-1 check
   (`cd core && npx tsx src/mcp/sampleClient.ts contractnli_4`) + one live review through the UI.
   This also settles the `clause_labels` span-alignment open item cheaply (the classify contract
   throws loudly on mismatch), before any cloud setup.
2. **Public-URL smoke** — streamed grounded review, refusal path, memo confirm-gate, 429 flip,
   security-header block, and the playbook cwd-probe check (known lambda-cwd unknown;
   `PLAYBOOK_PATH` env is the escape hatch if both probes miss).
3. **P5.0 gate re-run on Claude** — 50/50 agent gate, 0 transport errors expected; hard invariants
   (groundedness 1.0, unconfirmed_writes 0) must hold; report + DECISIONS.md entry; "project done"
   claimable after this.

## 5. Docs & assets

- README: replace the two `TODO(deploy)` placeholders with the live URL; add the retrieve-mode
  qualifier; fix the known diagram nit ("(6 tools)" vs 5 stems) while touching it.
- Demo GIF: walkthrough script written in-repo (`docs/demo-script.md`), user records, GIF embedded.
  Only non-blocking item — everything else is sequential.

## 6. Risks & handling

- **60s function window** vs 15–40s reviews: acceptable but tight. If the public smoke shows
  timeouts: first lever = lower `LLM_TIMEOUT_MS`; second = steer the demo to the smallest doc
  (`contractnli_4`) first. (Live status narration via `onStep` remains a post-P6 follow-up.)
- **Memo caps are profile-relative** (sized for 1024 tokens, ~2× safety): re-check if
  `LLM_MAX_TOKENS` is ever raised past ~2000.
- **Neon free-tier cold starts** (suspends when idle): first request after idle is slow —
  acceptable for a demo; noted in README.
- **First real CI runs** of gitleaks on the phase branch push: expected clean (already passed on
  the P5 push/PR).

## Non-goals

No new ML capability. No Upstash/multi-instance rate limiting. No `resolveMaxTokens` semantics
change, no `onStep` streaming narration, no vitest 2.x migration (all remain post-P6 follow-ups per
`docs/P6-scope.md`).
