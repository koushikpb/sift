# P6 — Deploy & Wrap-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the merged P5 demo (Vercel + Neon pgvector + Anthropic inference), validate it live, close the P5.0 "project done" gate on Claude, and finish the README/demo assets.

**Architecture:** No new product code. The phase is an ops ladder — local Anthropic smoke → Neon seed → Vercel deploy → public smoke → docs — plus one eval run. Approved spec: `docs/superpowers/specs/2026-07-02-p6-deploy-wrapup-design.md`. Several steps are **human-run** (dashboard actions, secrets); they are marked `PAUSE (human)` and the task cannot proceed past them without the human's confirmation.

**Tech Stack:** Vercel (dashboard-connected repo, Root Directory = `app`), Neon via Vercel Marketplace (pgvector), Anthropic `claude-sonnet-4-6` (OpenAI-compat), existing `core` CLIs (`migrate`/`load`/`embed`/`agent-eval`), `make clf-precompute`.

## Global Constraints

- **Secrets never printed, pasted in chat, or committed.** Keys live in the local gitignored `.env` and the Vercel dashboard only. When echoing env for evidence, redact values (`sed -E 's/(KEY|URL|TOKEN)=.+/\1=<set>/'`).
- **Demo inference profile** (from `.env.demo.example`): `LLM_BASE_URL=https://api.anthropic.com/v1/`, `LLM_MODEL=claude-sonnet-4-6`, `LLM_MAX_TOKENS=1024`, `RETRIEVE_MODE=hybrid`.
- **Curated allowlist** served by the API: `contractnli_1`, `contractnli_4`, `contractnli_6`; `clause_labels` must hold exactly 42 rows for them (13/9/20).
- **Hard invariants** (any violation = STOP, report): citation `quote === raw_text.slice(char_start,char_end)`; memo never materializes without explicit confirm; refusal is a correct outcome.
- **Embed model:** leave `EMBED_MODEL` unset everywhere (default `bge-large-en-v1.5`) so seed-time and query-time models match.
- **Commits** end with the two required trailers (Co-Authored-By + Claude-Session). Commit/push only where a step says to.
- Postgres for local work = Docker `sift-db-1`; Neon is targeted ONLY via an explicit `DATABASE_URL=$NEON_DATABASE_URL` prefix on the specific command — never edit `.env`'s `DATABASE_URL` to point at Neon (prevents accidental cross-writes).

## File Structure (planned)

- `app/vercel.json` — create (function maxDuration).
- `docs/eval-reports/p6-deploy-smoke.md` — create (public-URL smoke evidence).
- `docs/eval-reports/P6-gate.md` — create (Claude gate re-run report); `evals/reports/p6_agent_claude.json` — create.
- `DECISIONS.md` — append gate outcome.
- `README.md` — modify (demo URL, retrieve-mode qualifier, diagram nit).
- `docs/demo-script.md` — create (GIF walkthrough script).

Dependency order: **1 → 2 → 3 → 4 → 5**; Task 6 (gate) needs only Task 1 and may run any time after it; Task 7 (demo script) is independent; the GIF embed inside Task 7 waits for the human recording.

---

### Task 1: Local Anthropic smoke (gates everything)

**Files:** none changed (evidence goes in the task report).

**Interfaces:**
- Consumes: existing `.env` (currently the NIM profile), `core/src/mcp/sampleClient.ts`, the app dev server.
- Produces: confirmation that the Anthropic profile works end-to-end + that precomputed `clause_labels` spans align with live retriever spans (the classify contract throws loudly on mismatch — a clean run IS the alignment check).

- [ ] **Step 1: PAUSE (human) — Anthropic profile into `.env`.** Human edits `.env`: comment out the NIM lines (`LLM_MODEL=meta/llama-3.3-70b-instruct`, NIM key/base URL) and add, per `.env.demo.example`: `LLM_BASE_URL=https://api.anthropic.com/v1/`, `LLM_MODEL=claude-sonnet-4-6`, `LLM_API_KEY=<their key>`, `LLM_MAX_TOKENS=1024`, `RETRIEVE_MODE=hybrid`. Human confirms done in chat.
- [ ] **Step 2: Verify profile (redacted) + infra.**
  Run: `grep -E '^(LLM_|RETRIEVE_MODE|DATABASE_URL)' .env | sed -E 's/(KEY|URL|TOKEN)=.+/\1=<set>/'` and `docker ps --format '{{.Names}} {{.Status}}' | grep sift-db`
  Expected: `LLM_MODEL=claude-sonnet-4-6`, `RETRIEVE_MODE=hybrid`, key/base `<set>`; `sift-db-1 Up (healthy)`.
- [ ] **Step 3: Deferred P5-Task-1 smoke (MCP sample client).**
  Run: `cd core && npx tsx src/mcp/sampleClient.ts contractnli_4`
  Expected: a grounded, cited answer (citations with `doc_id`/`char_start`/`char_end`/`quote`), no auth/`max_tokens` errors. If Anthropic returns 401/400: STOP, report exact error class (redacted).
- [ ] **Step 4: One live review through the real API path.**
  Run: `npm -w @sift/app run dev` (background), then
  `curl -N 'http://localhost:3000/api/review?docId=contractnli_4&objective=confidentiality%20term' | head -c 4000`
  Expected: SSE `status` events, then ≥1 `clause` event with a citation (or an explicit refusal clause), then `done`. **No `classification` contract error** (its presence = span misalignment → STOP, report).
- [ ] **Step 5: Kill the dev server; write evidence (timings, event types seen, first clause label) into the task report.** No commit (no repo changes).

---

### Task 2: Neon provision + seed

**Files:** none changed (evidence in the task report).

**Interfaces:**
- Consumes: Vercel account (human), `core` scripts `migrate`/`load`/`embed`, `make clf-precompute`, local `data/processed/**/docs.jsonl` artifacts.
- Produces: a seeded Neon `DATABASE_URL` (held by the human + Vercel; exported only ad-hoc in shell as `$NEON_DATABASE_URL`) that Task 3's deploy consumes.

- [ ] **Step 1: PAUSE (human) — create the database.** In the Vercel dashboard: Storage → Create Database → **Neon** (Marketplace, free plan) → region close to them → create. Copy the pooled connection string. Export it in the working shell only: `export NEON_DATABASE_URL='<paste>'` (human runs this themselves in the terminal via `!` or tells Claude it's exported). Confirm done in chat.
- [ ] **Step 2: Migrations against Neon.**
  Run: `cd core && DATABASE_URL="$NEON_DATABASE_URL" npm run migrate`
  Expected: applies `0001`…`0007` (incl. `0007_clause_labels`), no errors. (`CREATE EXTENSION vector` is in the migrations; Neon supports it.)
- [ ] **Step 3: Load the corpus.**
  Run: `cd core && DATABASE_URL="$NEON_DATABASE_URL" npm run load`
  Expected: `loaded cuad: … / loaded contractnli: …, total: ~172 docs, ~5792 clauses` (the loader has no subset filter — full corpus is fine on the free tier; the API allowlist restricts serving).
- [ ] **Step 4: Embed (one model, default).**
  Run: `cd core && DATABASE_URL="$NEON_DATABASE_URL" npm run embed`
  Expected: `embedded 5792 clauses (model=bge-large-en-v1.5)`. This runs locally (transformers.js) and takes tens of minutes — run in background, check completion.
- [ ] **Step 5: Precompute classify labels.**
  Run: `DATABASE_URL="$NEON_DATABASE_URL" make clf-precompute`
  Expected: pipeline emits rows; loader upserts 42.
- [ ] **Step 6: Verify counts.**
  Run: `psql "$NEON_DATABASE_URL" -c "select count(*) from documents;" -c "select count(*) from embeddings;" -c "select doc_id, count(*) from clause_labels group by 1 order by 1;"`
  Expected: ~172 docs; 5792 embeddings; `contractnli_1 13 / contractnli_4 9 / contractnli_6 20`. Record outputs in the task report. No commit.

---

### Task 3: `vercel.json` + Vercel project + preview deploy

**Files:**
- Create: `app/vercel.json`

**Interfaces:**
- Consumes: the pushed `phase-6-deploy-wrapup` branch; Neon DB from Task 2.
- Produces: a working **preview deployment URL** (human supplies it) for Task 4's smoke.

- [ ] **Step 1: Create `app/vercel.json`** (paths relative to Root Directory = `app`):

```json
{
  "functions": {
    "app/api/review/route.ts": { "maxDuration": 60 },
    "app/api/memo/route.ts": { "maxDuration": 60 }
  }
}
```

- [ ] **Step 2: Sanity-check the app still builds.**
  Run: `npm -w @sift/app run build`
  Expected: build succeeds (vercel.json is not consumed by `next build`; this guards against stray JSON/config typos breaking CI).
- [ ] **Step 3: Commit + push.**

```bash
git add app/vercel.json
git commit -m "chore(app): vercel function config (maxDuration for review/memo)"
git push -u origin phase-6-deploy-wrapup
```

- [ ] **Step 4: PAUSE (human) — Vercel project.** In the dashboard: Add New → Project → import the `sift` repo → **Root Directory = `app`** → Framework = Next.js. Connect the Neon database created in Task 2 to this project (Storage tab → Connect; injects `DATABASE_URL`). Add env vars (Production **and** Preview): `LLM_BASE_URL=https://api.anthropic.com/v1/`, `LLM_MODEL=claude-sonnet-4-6`, `LLM_API_KEY=<key>`, `LLM_MAX_TOKENS=1024`, `RETRIEVE_MODE=hybrid`. Deploy (the branch import gives a preview deployment). Paste the preview URL in chat when the build is green.
- [ ] **Step 5: If the Vercel build fails**, pull the build log (human pastes it), diagnose, fix, re-push — known candidate failure: monorepo install (core workspace must install from repo root; Vercel auto-detects workspaces when Root Directory is a workspace member — if not, set Install Command to `npm install --prefix ../..` or move Root Directory to repo root with `next` app dir configured). Do not guess silently; record what happened.

---

### Task 4: Public-URL smoke + evidence doc

**Files:**
- Create: `docs/eval-reports/p6-deploy-smoke.md`

**Interfaces:**
- Consumes: preview URL from Task 3 (call it `$URL`).
- Produces: evidence doc; the go/no-go for README finalization (Task 5).

- [ ] **Step 1: Security headers.**
  Run: `curl -sI "$URL" | grep -iE 'strict-transport|content-security|x-content-type|referrer-policy|x-frame'`
  Expected: all five present. Also `curl -sI "$URL/api/memo"` shows them on API paths.
- [ ] **Step 2: Grounded review streams (the big one — also proves the playbook cwd probe and the in-lambda query-embedder).**
  Run: `time curl -N "$URL/api/review?docId=contractnli_4&objective=confidentiality%20term" | head -c 4000`
  Expected: SSE `status` → `clause` (with citation) → … → `done` within 60s.
  **Known risks this step adjudicates:**
  - `{"error":"insufficient server configuration"}` → playbook probe missed in the lambda → human sets `PLAYBOOK_PATH=/var/task/evals/playbook/nda.yaml` (or `/var/task/app/...` per probe order) in Vercel env, redeploy, retry.
  - Timeout/hang on first call → likely the **bge-large query-embedder cold-fetching inside the lambda** (transformers.js downloads model weights at cold start; never validated on Vercel). Retry once warm; if cold starts structurally exceed 60s or the function exceeds size limits: STOP and present options to the human — (a) smaller `EMBED_MODEL` for the demo + re-embed Neon, (b) lexical-only retrieve mode if `makeRetriever` supports one, (c) accept slow first-hit with a README note. Do not pick unilaterally.
- [ ] **Step 3: Input validation + rate limit.**
  Run: `curl -s -o /dev/null -w "%{http_code}\n" "$URL/api/review?docId=not_allowed&objective=x"` → expect `400`; then hammer: `for i in $(seq 1 12); do curl -s -o /dev/null -w "%{http_code} " "$URL/api/review?docId=not_allowed&objective=x"; done` → expect `400 ×10` then `429`s with `Retry-After` (confirm via `curl -sI` on the 429).
- [ ] **Step 4: Memo gate.**
  Run: POST without confirm → expect `{"written":false,"preview":...}` and NO `markdown` key; POST with `"confirm":true` → `markdown` present:

```bash
curl -s -X POST "$URL/api/memo" -H 'content-type: application/json' -d '{"doc_id":"contractnli_4","objective":"confidentiality term","flags":[],"redlines":[]}' | head -c 300
curl -s -X POST "$URL/api/memo" -H 'content-type: application/json' -d '{"doc_id":"contractnli_4","objective":"confidentiality term","flags":[],"redlines":[],"confirm":true}' | head -c 300
```

- [ ] **Step 5: Browser pass (human or Playwright):** load `$URL`, run one review on `contractnli_4`, confirm citation highlighting + (if present) refusal rendering; screenshot to the task report dir.
- [ ] **Step 6: Write `docs/eval-reports/p6-deploy-smoke.md`** — commands, outputs (redact the URL if it embeds tokens; preview URLs don't), timings (cold vs warm), and the adjudication of the two known risks. Commit:

```bash
git add docs/eval-reports/p6-deploy-smoke.md
git commit -m "docs(eval): P6 public-URL smoke evidence"
```

---

### Task 5: README finalization

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the production URL (human promotes/merges when ready — for the README use the stable production domain from the Vercel project, human supplies it; preview URLs churn per-push).

- [ ] **Step 1: PAUSE (human) — confirm the stable production URL** (e.g. `https://sift-<hash>.vercel.app` or a custom domain). Note: production deploys track `main`; until P6 merges, production serves the P5 merge — that's the same app surface; fine for the link.
- [ ] **Step 2: Edit README:** replace the two `TODO(deploy)` placeholders with the live URL + a "first request after idle may take a few seconds (free-tier DB cold start)" note; add the one-line retrieve-mode qualifier where L1 is described: "The hosted demo runs `RETRIEVE_MODE=hybrid` (dense + lexical + rerank); the agentic sufficiency loop is available as a local mode."; fix the diagram nit: L3 tools node text lists 5 stems labeled "(6 tools)" — add `extract_fields` or change the count.
- [ ] **Step 3: Verify the Mermaid block still parses** (`npx -y @mermaid-js/mermaid-cli -i README.md -o /tmp/readme-check.svg` works on extracted block, or eyeball bracket balance if the tool fights the full README).
- [ ] **Step 4: Commit.**

```bash
git add README.md
git commit -m "docs: live demo link + retrieve-mode qualifier + diagram fix"
```

---

### Task 6: P5.0 gate re-run on Claude (needs Task 1 only; local infra)

**Files:**
- Create: `evals/reports/p6_agent_claude.json`, `docs/eval-reports/P6-gate.md`
- Modify: `DECISIONS.md` (append)

**Interfaces:**
- Consumes: local Docker DB (full corpus + both embed models already loaded), pipeline venv (live classify via `defaultRunPredict`), Anthropic `.env` profile from Task 1.
- Produces: the "project done" evidence.

- [ ] **Step 1: Preserve the P4 report.** `core/src/agent/cli.ts:51` hardcodes the output path `evals/reports/p4_agent.json`. Before running: `cp evals/reports/p4_agent.json evals/reports/p4_agent.json.bak`.
- [ ] **Step 2: Run the 50-item gate on Claude, hybrid mode (comparable to the P4 run).**
  Run: `cd core && RETRIEVE_MODE=hybrid LLM_RPM=30 npm run agent-eval` (background; ~30–60 min with live per-clause Python classify).
  `LLM_RPM=30` keeps the throttle friendly to Anthropic tier limits; raise only if visibly safe.
- [ ] **Step 3: Rename outputs.** `mv evals/reports/p4_agent.json evals/reports/p6_agent_claude.json && mv evals/reports/p4_agent.json.bak evals/reports/p4_agent.json`
- [ ] **Step 4: Evaluate against the gate.**
  Read `evals/reports/p6_agent_claude.json`. HARD GATES: `mean_groundedness == 1.0`, `unconfirmed_writes == 0`, transport errors == 0 (grep the per-item errors). Report `task_success_rate`, `flag_false_negative_rate`, `refusal_correctness`, span-match — expected ≥ the P4 transport-adjusted numbers (task_success ≈0.85) now WITHOUT adjustment. If a hard gate fails: STOP — that's a product bug, not an ops issue; report with the failing items.
- [ ] **Step 5: Write `docs/eval-reports/P6-gate.md`** (numbers, comparison table vs P4 raw + transport-adjusted, model/config used) and append the outcome + date to `DECISIONS.md` ("P5.0 gate closed on claude-sonnet-4-6: …").
- [ ] **Step 6: Commit.**

```bash
git add evals/reports/p6_agent_claude.json docs/eval-reports/P6-gate.md DECISIONS.md
git commit -m "eval(p6): clean agent gate on Claude — project-done evidence"
```

---

### Task 7: Demo script + GIF embed

**Files:**
- Create: `docs/demo-script.md`
- Modify (after human records): `README.md` (embed GIF), `docs/media/demo.gif` (human-provided)

- [ ] **Step 1: Write `docs/demo-script.md`** — a 30–45s walkthrough: open `/` → pick `contractnli_4` → objective "confidentiality term" → clause cards stream in with citation highlight visible → open a redline → Export memo → show the preview → Confirm → the .md downloads. One beat per screen, with the exact clicks and what to hover to show the citation span.
- [ ] **Step 2: Commit the script.** `git add docs/demo-script.md && git commit -m "docs: demo walkthrough script for the GIF"`
- [ ] **Step 3: PAUSE (human) — record the GIF** following the script (any screen recorder → GIF; ~30–45s; 1280px wide is plenty). Save to `docs/media/demo.gif`.
- [ ] **Step 4: Embed + commit** (only after the file exists): add `![demo](docs/media/demo.gif)` in the README's demo section, `git add docs/media/demo.gif README.md && git commit -m "docs: embed demo GIF"`.

---

## Self-Review checklist (run before execution)

- Spec coverage: topology (T3), seeding (T2), deploy config (T3), validation ladder rungs 1–3 (T1, T4, T6), docs/assets (T5, T7), risks each have an adjudicating step (60s window + embedder → T4.2; memo caps → unchanged profile, noted; Neon cold start → T5.2 README note; CI first runs → push in T3.3). ✅
- Human-gated steps are explicit PAUSE steps with confirm-in-chat semantics; no secret ever transits chat. ✅
- Loader has no subset filter — plan loads full corpus per amended spec. ✅ Gate CLI output filename hardcoded — preserved/renamed in T6.1/6.3. ✅ `EMBED_MODEL` consistency pinned by Global Constraints. ✅
- Type/name consistency: `$NEON_DATABASE_URL` used consistently; curated counts 13/9/20 = 42 everywhere. ✅
