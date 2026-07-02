# Phase 6 Scope — Deploy & Wrap-up

**Status:** scoping. Deferred from P5 (user decision, 2026-07-02): P5 merges as the code-complete,
security-hardened demo app; everything requiring external accounts/credentials or human recording
moves here.

## Carried over from P5

### 1. Deploy (was P5 Task 11)
- Managed pgvector (Neon recommended, or Supabase): create instance, then from local run
  `npm run migrate` (incl. `0007_clause_labels`), load + embed the curated docs, `make clf-precompute`.
  Verify counts (42 rows in `clause_labels` across contractnli_1/4/6).
- `app/vercel.json` (`maxDuration` for `/api/review` + `/api/memo`), Vercel Root Directory = `app`.
- Vercel env (dashboard, human-run): `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` (Anthropic),
  `LLM_MAX_TOKENS`, `DATABASE_URL`, `RETRIEVE_MODE`, optional `UPSTASH_REDIS_REST_URL`/`TOKEN`.
- Deploy; smoke the public URL: agent page at `/` streams a grounded, cited review; memo stays
  confirm-gated; 429 + security headers active.

**Deploy-time checks recorded by the P5 final review:**
- Decide `RETRIEVE_MODE=agentic` vs `hybrid` for the demo and reconcile the README L1
  prose (agentic sufficiency loop) with whichever mode ships.
- Confirm the playbook cwd probe resolves inside the real Vercel lambda
  (`resolvePlaybookPath`; escape hatch: `PLAYBOOK_PATH` env).
- Confirm `clause_labels` spans align with live retriever spans for the 3 curated docs
  (classify contract throws loudly on mismatch by design).
- Memo caps are profile-relative (sized for `LLM_MAX_TOKENS=1024`, ~2× safety): re-check if the
  deploy raises the token budget past ~2,000.
- First real run of the gitleaks CI workflow (fires on push).

### 2. Demo assets (was P5 Task 12 deferred bits)
- Replace the README `TODO(deploy)` placeholders: live demo URL.
- Record the walkthrough GIF (human) and embed it.

### 3. Validation still owed
- P5 Task 1 step 10: manual Anthropic smoke (`cd core && npx tsx src/mcp/sampleClient.ts <doc_id>`
  with the Anthropic profile in `.env`).
- **P5.0 / project-done gate:** clean 50/50 agent-gate re-run with 0 transport errors — either
  off-peak NIM on `llama-3.3-70b` (runner prepared) or on Claude for reliability. Blocks the
  "project done" claim; decision pending.

## Post-merge follow-ups (recommendations from the P5 final review)
- `resolveMaxTokens`: change env-override semantics to a floor/default so `LLM_MAX_TOKENS` stops
  overriding deliberate per-callsite budgets (judge 512 / redline 2048).
- Live status narration: thread an `onStep` callback through `reviewContract` so SSE `status`
  events stream when steps actually run (also shrinks the Vercel 60s exposure).
- Single shared curated-allowlist constant (route + DocPicker currently each hardcode the 3 docs).
- vitest 2.x + jsdom ≥25 migration once Node ≥ 20.19 (clears the Vite CJS warning and the
  dev-only npm-audit residual chain).
- Accepted-minor backlog: see `.superpowers/sdd/final-review-minors.md` triage table in the P5
  final review (all ACCEPTed items remain valid small cleanups).

## Non-goals (unchanged)
Not legal advice. Not multi-contract enterprise. No new ML capability in P6 — deploy + prove.
