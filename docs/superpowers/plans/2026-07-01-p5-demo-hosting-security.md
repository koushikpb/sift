# P5 — Demo, Hosting & Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the completed 3-layer "sift" system into a public, hosted, secured demo suitable for a resume — a clean web UI over the grounded contract-review agent, powered by Claude for the demo, with security (rate limits, secret scan) validated.

**Architecture:** A Next.js app (per SPEC, the P1 app that consumes `core/`) added to the monorepo, **deployed on Vercel**. Server-side API route handlers (Node runtime) wrap the existing `reviewContract` agent + tools. Demo inference runs on Claude via the Anthropic OpenAI-compatible endpoint (the existing OpenAI-compat clients honor `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY`, so the swap is env + one small code change for the required `max_tokens`). Postgres/pgvector is **managed (Neon or Supabase)** with the Vercel integration. **Vercel serverless cannot spawn the Python LoRA subprocess**, so `classify_clause` is handled out-of-band (see Global Constraints); all *other* tool calls (retrieve/flag/redline/memo) run live on Claude and are **streamed** to respect Vercel function limits.

**Tech Stack:** Next.js 15+ (App Router) + React + Tailwind v4 + a few Radix primitives; TypeScript/Node 20; existing `core/` agent; Postgres 16 + pgvector (managed: Neon/Supabase); Claude (`claude-sonnet-4-6`) via Anthropic OpenAI-compat; **Vercel** hosting. Landing/UI inspired by the "Agent AI" template (Next.js + Tailwind v4) with our own liberties. Build assisted by the **UI/UX Pro Max** skill.

## Global Constraints
- **Demo inference = Anthropic.** `LLM_BASE_URL=https://api.anthropic.com/v1/`, `LLM_MODEL=claude-sonnet-4-6`, `LLM_API_KEY=<anthropic key>`, `LLM_MAX_TOKENS` set. The Anthropic OpenAI-compat layer **requires `max_tokens`** (errors if omitted) and does **not** support prompt caching / structured outputs / extended thinking — we rely on none of those (JSON is parsed from text by `parseRawGen`).
- **classify_clause runs out-of-band (Vercel can't spawn Python).** DECISION PENDING (default = **precompute**): classify labels for the curated demo docs are generated offline by the existing Python LoRA and stored in the DB (a new column/table), then served by the API without a live subprocess. Alternative = a small hosted Python inference service called over HTTP. Either way the L2 LoRA output is *shown* in the UI; only the runtime location changes.
- **Vercel function limits.** A full `reviewContract` makes several Claude calls (~15–40s total). API routes use the Node runtime, `export const maxDuration` raised (Pro), and **stream** partial results so the request never blocks past the limit. Curated docs may also be pre-reviewed and cached for instant load, with an optional bounded "run live" path.
- **Secrets server-side only.** The Anthropic key never reaches the client bundle; it lives in gitignored `.env` locally and the Vercel project env in prod. Never printed.
- **Citation invariant holds in the UI.** Every rendered claim shows its `{doc_id,char_start,char_end,quote}` span; the UI highlights `raw_text.slice(char_start,char_end)`. Refusals render explicitly.
- **HITL gate stays honest.** `export_memo` only writes when `confirm===true`; the UI must make the confirm step explicit and never auto-confirm.
- **Typed payloads only.** Zod-validate every API input/output (existing repo pattern). No unvalidated data crosses the API boundary.
- **Public data only.** Curated sample contracts only; no client data, no PII.
- **Commits** end with the two required trailers (Co-Authored-By + Claude-Session). Commit/push only when the human asks.

---

## File Structure (planned)
- `app/` (or `web/`) — Next.js app package in the monorepo. Consumes `core/` (workspace dep).
  - `app/src/app/` — routes: landing (hero), review view.
  - `app/src/app/api/review/route.ts` — server-side endpoint wrapping `reviewContract` (streaming).
  - `app/src/lib/rateLimit.ts` — per-IP rate limiter + concurrency cap.
  - `app/src/components/` — clause cards, citation highlighter, redline, memo/HITL.
- `core/src/llm/throttle.ts` — add `resolveMaxTokens`.
- `core/src/generate/openaiCompat.ts`, `core/src/agent/tools/flagRisks.ts`, `core/src/agent/tools/draftRedline.ts` — pass `max_tokens`.
- `.env.demo.example` — documented Anthropic demo profile (no secrets).
- `.gitleaks.toml` + `.github/workflows/security.yml` (or pre-commit) — secret scanning.
- `pipeline/pipeline/classify/precompute_demo.py` — offline: classify curated-doc clauses → JSON/DB.
- `core/src/db/` migration — a `clause_label` column/table for precomputed classify results.
- `app/vercel.json` + Vercel project settings — deploy config (managed pgvector integration).
- `README.md` — architecture diagram, 3-layer story, eval numbers, demo link.

---

## Task 1: Anthropic inference profile (`max_tokens` + demo config)

**Files:**
- Modify: `core/src/llm/throttle.ts` (add `resolveMaxTokens`)
- Modify: `core/src/generate/openaiCompat.ts` (extend `ChatClient`, pass `max_tokens`)
- Modify: `core/src/agent/tools/flagRisks.ts:70-80` (pass `max_tokens`)
- Modify: `core/src/agent/tools/draftRedline.ts:50-60` (pass `max_tokens`)
- Create: `.env.demo.example`
- Test: `core/src/llm/throttle.test.ts` (or existing), `core/src/generate/openaiCompat.test.ts`

**Interfaces:**
- Produces: `resolveMaxTokens(fallback?: number, env?): number` — reads `LLM_MAX_TOKENS`, else `fallback` (default 1024).
- Consumes: existing `ChatClient` in `openaiCompat.ts`; the inline OpenAI clients in `flagRisks`/`draftRedline`.

- [ ] **Step 1: Write the failing test for `resolveMaxTokens`**

```ts
// core/src/llm/throttle.test.ts  (add)
import { resolveMaxTokens } from "./throttle.js";

test("resolveMaxTokens reads LLM_MAX_TOKENS, else fallback, else 1024", () => {
  expect(resolveMaxTokens(2048, {})).toBe(2048);
  expect(resolveMaxTokens(undefined, {})).toBe(1024);
  expect(resolveMaxTokens(2048, { LLM_MAX_TOKENS: "512" })).toBe(512);
});
```

- [ ] **Step 2: Run it — expect FAIL** (`resolveMaxTokens is not a function`).
  Run: `cd core && npx vitest run src/llm/throttle.test.ts`

- [ ] **Step 3: Implement `resolveMaxTokens`**

```ts
// core/src/llm/throttle.ts  (add)
export function resolveMaxTokens(
  fallback = 1024,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.LLM_MAX_TOKENS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Write the failing test that the generator forwards `max_tokens`**

```ts
// core/src/generate/openaiCompat.test.ts  (add)
test("generator passes max_tokens to the chat client", async () => {
  const seen: any = {};
  const fake = { chat: { completions: { create: async (args: any) => {
    Object.assign(seen, args);
    return { choices: [{ message: { content: '{"answer":"x","citations":[]}' } }] };
  } } } };
  const gen = makeOpenAICompatGenerator({ client: fake as any, model: "claude-sonnet-4-6" });
  await gen.generate({ /* minimal valid GenInput per existing tests */ } as any);
  expect(seen.max_tokens).toBeGreaterThan(0);
});
```

- [ ] **Step 6: Run it — expect FAIL** (`max_tokens` undefined).

- [ ] **Step 7: Extend `ChatClient` + pass `max_tokens` in all three clients**

```ts
// openaiCompat.ts — ChatClient.create args: add `max_tokens?: number;`
// and in generate():
const resp = await client.chat.completions.create({
  model, temperature: 0, max_tokens: resolveMaxTokens(),
  messages: [ { role: "system", content: system }, { role: "user", content: user } ],
});
```
```ts
// flagRisks.ts judge create(...) — add: max_tokens: resolveMaxTokens(512)
// draftRedline.ts writer create(...) — add: max_tokens: resolveMaxTokens(2048)
// import resolveMaxTokens from ../../llm/throttle.js in both
```

- [ ] **Step 8: Run generator test + full core unit tests — expect PASS.**
  Run: `cd core && npx vitest run src/generate src/llm`

- [ ] **Step 9: Create `.env.demo.example`** (documented, no secrets)

```bash
# .env.demo.example — copy to .env for the Anthropic-powered demo. .env is gitignored.
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.anthropic.com/v1/
LLM_MODEL=claude-sonnet-4-6
LLM_API_KEY=            # Anthropic API key — server-side only, never commit
LLM_MAX_TOKENS=1024
DATABASE_URL=
```

- [ ] **Step 10: Manual smoke (human-run, needs a real key)** — with `.env` pointed at Anthropic,
  run one `retrieve_clause` via the sample client and confirm a grounded, cited answer returns.
  Run: `cd core && npx tsx src/mcp/sampleClient.ts <doc_id>`

- [ ] **Step 11: Commit.**
```bash
git add core/src/llm/throttle.ts core/src/generate/openaiCompat.ts core/src/agent/tools/flagRisks.ts core/src/agent/tools/draftRedline.ts core/src/llm/throttle.test.ts core/src/generate/openaiCompat.test.ts .env.demo.example
git commit -m "feat(llm): max_tokens support + Anthropic demo profile"
```

---

> **Repo reality (verified) that these tasks build on:** the `app/` Next.js package already exists
> (Next 15.3, React 19, `@sift/core` transpiled, root `.env` bridged into the server in
> `next.config.mjs`, Node-only deps externalized). There is a working SSE pattern at
> `app/app/api/answer/route.ts` using `@sift/core/serve` (`streamAnswer` + `sseEncode`) consumed by
> an `EventSource` client in `app/app/page.tsx`. **Tailwind is NOT yet installed.** Tests run on
> **vitest**; migrations are numbered SQL in `core/migrations/` applied by `npm run migrate`; `core`
> exposes a subpath `exports` map (agent not yet exported). The review path mirrors the answer path.
>
> **UI fidelity note:** for visual tasks (3, 6, 7) the plan fixes the component *contract*, the data
> rendered, the interactions, and unit-testable invariants — the exact JSX/visual design is derived
> at build time from the Agent-AI template (with liberties) + the **UI/UX Pro Max** skill. That is by
> design, not a placeholder: the grounding/HITL behavior is fully specified and tested; the styling is
> sourced, not invented here.

---

## Task 2: Tailwind + design system on the existing app

**Files:**
- Modify: `app/package.json` (add Tailwind v4 + test + Radix deps)
- Create: `app/postcss.config.mjs`, `app/app/globals.css`, `app/src/lib/cn.ts`, `app/vitest.config.ts`
- Modify: `app/app/layout.tsx` (import `globals.css`, base bg/fg, font)
- Test: `app/src/lib/cn.test.ts`

**Interfaces:**
- Produces: `cn(...classes)` className merger; Tailwind utilities + CSS design tokens for Tasks 3/6/7.

- [ ] **Step 1: Install deps.**
```bash
npm i -w @sift/app -D tailwindcss@^4 @tailwindcss/postcss postcss vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom
npm i -w @sift/app clsx tailwind-merge @radix-ui/react-slot @radix-ui/react-dialog
```
- [ ] **Step 2: Write the failing `cn` test.**
```ts
// app/src/lib/cn.test.ts
import { cn } from "./cn";
test("cn merges + de-dupes tailwind classes", () => {
  expect(cn("px-2", "px-4")).toBe("px-4");
  expect(cn("text-sm", false && "hidden", "font-medium")).toBe("text-sm font-medium");
});
```
- [ ] **Step 3: Add `app/vitest.config.ts` (jsdom + react).**
```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()], test: { environment: "jsdom", globals: true } });
```
Add `"test": "vitest run"` to `app/package.json` scripts.
- [ ] **Step 4: Run — expect FAIL.** `npm -w @sift/app test`
- [ ] **Step 5: Implement `cn` + Tailwind wiring.**
```ts
// app/src/lib/cn.ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export const cn = (...i: ClassValue[]) => twMerge(clsx(i));
```
```js
// app/postcss.config.mjs
export default { plugins: { "@tailwindcss/postcss": {} } };
```
```css
/* app/app/globals.css */
@import "tailwindcss";
:root { --background: #0b0d12; --foreground: #e6e8ee; --accent: #6d6afc; --muted: #9aa3b2; }
@theme inline { --color-background: var(--background); --color-foreground: var(--foreground); --color-accent: var(--accent); --color-muted: var(--muted); }
```
(Palette is a placeholder tuned by the UI/UX Pro Max skill in Task 3.)
- [ ] **Step 6: Import `globals.css` + base classes in `layout.tsx`.**
```tsx
import "./globals.css";
// <body className="bg-background text-foreground antialiased min-h-screen">
```
- [ ] **Step 7: Run — expect PASS; then typecheck + build.**
`npm -w @sift/app test && npm -w @sift/app run typecheck && npm -w @sift/app run build`
- [ ] **Step 8: Commit.** `feat(app): tailwind v4 + design tokens + test harness`

---

## Task 3: Landing / hero page (recreate the Agent-AI template, our liberties)

> **REMOVED (user decision, 2026-07-01):** the demo is the agent page only — no landing page.
> Implemented as `6961f30`, reverted in `69543b8` (kept: `Button.tsx`, Inter layout wiring,
> vitest jest-dom setup). Task 6's review UI now lives at `/` (`app/app/page.tsx`).

**Design source:** Agent-AI template (Next + Tailwind v4) + UI/UX Pro Max skill. Not a pixel copy.

**Files:**
- Modify: `app/app/page.tsx` → landing (the existing form UI moves to `/review` in Task 6)
- Create: `app/src/components/marketing/{Nav,Hero,Features,HowItWorks,Footer}.tsx`
- Create: `app/src/components/ui/Button.tsx` (Radix `Slot`-based, `cn`-styled)
- Test: `app/src/components/marketing/Hero.test.tsx`

**Contract:**
- **Nav:** brand "sift"; links (GitHub, "How it works"); primary CTA "Try the demo" → `/review`.
- **Hero:** headline (grounded, cited NDA review), subhead, primary CTA → `/review`, secondary → `#how`.
- **Features:** 3 cards mapping the real layers — Grounded RAG w/ citations · Fine-tuned clause classifier · Action agent w/ human-in-the-loop. Copy must be honest (no invented capabilities).
- **HowItWorks (`#how`):** the grounding invariant, refusal, and HITL confirm — three short beats.
- Responsive; a11y: landmarks, focus-visible states, alt text; no critical axe violations.

- [ ] **Step 1: Failing Hero test.**
```tsx
// app/src/components/marketing/Hero.test.tsx
import { render, screen } from "@testing-library/react";
import { Hero } from "./Hero";
test("hero shows the value prop and a CTA into the demo", () => {
  render(<Hero />);
  expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /try the demo/i })).toHaveAttribute("href", "/review");
});
```
- [ ] **Step 2: Run — FAIL.** `npm -w @sift/app test src/components/marketing/Hero.test.tsx`
- [ ] **Step 3: Implement `Button`, `Hero`, then `Nav/Features/HowItWorks/Footer`** using Tailwind + `cn`, styled per the template + UI/UX Pro Max skill output. `Hero` must render an `<h1>` and a `<Link href="/review">Try the demo</Link>`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Assemble `page.tsx`** composing the sections; wrap in semantic landmarks.
- [ ] **Step 6: Visual + a11y check** vs the template; run an axe pass in dev; `npm -w @sift/app run build`.
- [ ] **Step 7: Commit.** `feat(app): landing page (hero + features + how-it-works)`

---

## Task 4: Curated demo corpus + classify precompute into DB

**Files:**
- Create: `core/migrations/0007_clause_labels.sql`
- Create: `pipeline/pipeline/classify/precompute_demo.py`
- Create: `core/src/db/clauseLabels.ts`
- Create: Makefile target `clf-precompute`
- Test: `pipeline/tests/test_precompute_demo.py`, `core/src/db/clauseLabels.test.ts`

**Interfaces:**
- Produces: `getClauseLabel(client, docId, start, end): Promise<{label,score}|null>` — used by the API's classify dep in Task 5.
- Consumes: `pipeline.classify.predict.default_classify` (existing LoRA inference).

**Curated docs:** choose 2–3 clean public NDAs already in the corpus; record their `doc_id`s in the plan/README (public data only).

- [ ] **Step 1: Migration.**
```sql
-- core/migrations/0007_clause_labels.sql
CREATE TABLE IF NOT EXISTS clause_labels (
  doc_id     TEXT    NOT NULL,
  char_start INTEGER NOT NULL,
  char_end   INTEGER NOT NULL,
  label      TEXT    NOT NULL,
  score      REAL    NOT NULL,
  PRIMARY KEY (doc_id, char_start, char_end)
);
```
Run: `npm run migrate` (from `core/`).
- [ ] **Step 2: Failing Python test for the precompute framing helper** (pure; stub classify), asserting each output row is `{doc_id,char_start,char_end,label,score}` for given clause spans.
- [ ] **Step 3: Implement `precompute_demo.py`** — read the curated docs' clause spans (from `data/processed/**/docs.jsonl`), call `default_classify` on the clause texts, emit JSONL rows. Run to fail→pass.
- [ ] **Step 4: Failing `clauseLabels.test.ts`** — `getClauseLabel` returns the stored row for a known span and `null` for an absent one (against a test DB / mocked `pg`).
- [ ] **Step 5: Implement `clauseLabels.ts`** (`getClauseLabel` + `upsertClauseLabel`) using the existing `core/src/db/client.ts`.
- [ ] **Step 6: `make clf-precompute`** pipes `precompute_demo.py` output into `upsertClauseLabel` for the curated docs.
- [ ] **Step 7: Run** the precompute; verify the curated docs have labels: `psql "$DATABASE_URL" -c "select doc_id,count(*) from clause_labels group by 1;"`
- [ ] **Step 8: Commit.** `feat(clf): precompute curated-doc LoRA labels into DB (Vercel-safe classify)`

---

## Task 5: `/api/review` streaming endpoint (wraps `reviewContract`)

**Files:**
- Create: `core/src/serve/reviewStream.ts` (async generator, mirrors `answerStream`)
- Modify: `core/package.json` `exports` — add `"./serve/review": "./src/serve/reviewStream.ts"` and `"./agent": "./src/agent/index.ts"`; create `core/src/agent/index.ts` re-exporting `reviewContract`, `ReviewDeps`.
- Create: `app/app/api/review/route.ts` (mirror `app/app/api/answer/route.ts`)
- Test: `core/src/serve/reviewStream.test.ts`

**Interfaces:**
- Produces SSE events `{type:"status"|"clause"|"done"|"error"}`; each `clause` carries the clause card (flag, severity, LoRA label, citation, redline?) with the citation invariant intact.
- Consumes: `ReviewDeps` (retriever + Anthropic generator + judge + **precomputed** classify dep from Task 4 + playbook).

- [ ] **Step 1: Failing `reviewStream.test.ts`** with fake deps:
  - yields ≥1 `clause` event whose `citation.quote === rawText.slice(char_start,char_end)`;
  - yields a refusal-style clause when retrieval is ungrounded;
  - **never triggers a write** — the `exportMemo` dep is called only in preview (`confirm:false`), so `written` is never true (the HITL invariant, mirrored from the agent eval).
- [ ] **Step 2: Run — FAIL.** `npm -w @sift/core test src/serve/reviewStream.test.ts`
- [ ] **Step 3: Implement `reviewStream`** — run `reviewContract`, translate its trajectory/cards into SSE events; classify dep = `getClauseLabel` (no Python spawn); `export_memo` invoked with `confirm:false` (preview) so the API never writes.
- [ ] **Step 4: Add the `core` exports + `agent/index.ts`; run test — PASS.**
- [ ] **Step 5: Implement `app/app/api/review/route.ts`** mirroring the answer route:
```ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Pro; streaming keeps the connection alive
// Zod-validate docId (must be in the curated allowlist) + objective; build ReviewDeps with the
// env-driven Anthropic generator + precomputed classify dep + playbook; stream via ReadableStream
// + sseEncode, closing on "done" — identical control flow to /api/answer.
```
- [ ] **Step 6: Manual smoke** (needs Anthropic `.env` + curated docs loaded):
  `curl -N 'http://localhost:3000/api/review?docId=<curated>&objective=<obj>'` streams clause events.
- [ ] **Step 7: Commit.** `feat(app): /api/review streaming endpoint over reviewContract`

---

## Task 6: Review UI (clause cards + citation highlighting + refusals)

**Design source:** template + UI/UX Pro Max, consistent with the landing.

**Files:**
- Modify: `app/app/page.tsx` → the review UI at `/` (client; consumes `/api/review` via `EventSource`, replacing the interim form UI — the app's only page, per the Task-3 removal decision)
- Create: `app/src/components/review/{ClauseCard,CitationHighlight,SeverityBadge,RefusalNotice,DocPicker}.tsx`
- Test: `app/src/components/review/CitationHighlight.test.tsx`

**Key deterministic invariant (the money shot):** `CitationHighlight({rawText, span})` renders `rawText`
with `[char_start,char_end)` wrapped in `<mark>`, and the marked text equals `span.quote` equals
`rawText.slice(char_start,char_end)`.

- [ ] **Step 1: Failing `CitationHighlight.test.tsx`.**
```tsx
import { render, screen } from "@testing-library/react";
import { CitationHighlight } from "./CitationHighlight";
test("highlights exactly the cited span", () => {
  const rawText = "The Receiving Party shall keep it confidential for five years.";
  const span = { doc_id: "d1", char_start: 4, char_end: 18, quote: rawText.slice(4, 18) };
  render(<CitationHighlight rawText={rawText} span={span} />);
  const mark = screen.getByText(span.quote, { selector: "mark" });
  expect(mark.textContent).toBe(rawText.slice(4, 18));
});
```
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement `CitationHighlight`** (slice-and-wrap; no fuzzy matching). Run — PASS.
- [ ] **Step 4: Implement `ClauseCard`** (objective, LoRA label via `SeverityBadge`, flag + severity, redline if present, `CitationHighlight`; refusal → `RefusalNotice`) + `DocPicker` (curated docs).
- [ ] **Step 5: Implement the review UI in `page.tsx` (at `/`)** — `DocPicker` + objective input, open `EventSource('/api/review?...')`, append `clause` cards as they stream, handle `status`/`error`/`done` exactly like the current page.
- [ ] **Step 6: End-to-end check** in the browser against a curated NDA; verify highlights + refusals; `npm -w @sift/app run build`.
- [ ] **Step 7: Commit.** `feat(app): review view — clause cards, citation highlighting, refusals`

---

## Task 7: Redline + export-memo (HITL) UI

**Files:**
- Create: `app/app/api/memo/route.ts` (POST; `export_memo` semantics; **confirm-gated**)
- Create: `app/src/components/review/{RedlineDraft,ExportMemoDialog}.tsx` (Radix Dialog)
- Test: `app/app/api/memo/route.test.ts`

**HITL mapping (honest gate, no server FS write on Vercel):** without `confirm:true` the route returns
a **preview** (`{written:false, preview}`); with `confirm:true` it returns the rendered memo markdown
for the client to download. The memo never materializes until the user explicitly confirms — the same
guarantee the agent eval proves via `unconfirmed_writes===0`.

- [ ] **Step 1: Failing `memo/route.test.ts`** — POST without `confirm` → `written:false` + preview only; POST with `confirm:true` → memo markdown returned (`renderMemoMarkdown`), still no server-side file write.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement `memo/route.ts`** reusing `renderMemoMarkdown` + the `export_memo` confirm check from `core`. Run — PASS.
- [ ] **Step 4: Implement `RedlineDraft`** (per-flag redline) and `ExportMemoDialog`** — a Radix Dialog whose confirm button is the only trigger of `confirm:true`; never auto-confirm; downloaded on confirm.
- [ ] **Step 5: Wire into the review view;** manual check that no memo appears before confirm.
- [ ] **Step 6: Commit.** `feat(app): redline drafts + HITL-gated memo export`

---

## Task 8: Secret scanning (gitleaks over full history)

**Files:**
- Create: `.gitleaks.toml`, `.github/workflows/security.yml`
- Optional: `lefthook.yml` / `.githooks/pre-commit`

- [ ] **Step 1: Install + scan history.** `brew install gitleaks` then `gitleaks detect --redact -v`
  (scans full git log by default). Expected: **no leaks** (`.env` is gitignored).
- [ ] **Step 2: `.gitleaks.toml`** — extend defaults; allowlist `*.example` placeholder files.
- [ ] **Step 3: CI job.**
```yaml
# .github/workflows/security.yml
name: security
on: [push, pull_request]
jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
```
- [ ] **Step 4: Prove it catches a real leak** — on a throwaway branch, commit a fake key, run
  `gitleaks detect` → detects; delete the branch. Document the check in `docs/eval-reports/`.
- [ ] **Step 5: Commit.** `chore(sec): gitleaks config + CI secret scanning`

---

## Task 9: Rate limiting + web hardening

**Files:**
- Create: `app/src/lib/rateLimit.ts`, `app/middleware.ts`
- Modify: `app/app/api/review/route.ts` + `app/app/api/memo/route.ts` (enforce limit + input caps)
- Test: `app/src/lib/rateLimit.test.ts`

- [ ] **Step 1: Failing `rateLimit.test.ts`** — a limiter (injectable store) allows N/window then returns
  blocked on N+1.
- [ ] **Step 2: Implement `rateLimit.ts`** — `@upstash/ratelimit` + Upstash Redis / Vercel KV in prod;
  the store is injectable so the test uses an in-memory fake. Run — PASS.
- [ ] **Step 3: Enforce in the API routes** — per-IP check (429 past threshold) + a global concurrency
  cap for the review route (bounds Anthropic spend) + input caps (objective length; `docId` must be in
  the curated allowlist; reject otherwise).
- [ ] **Step 4: `middleware.ts`** — security headers (CSP, HSTS, X-Content-Type-Options, Referrer-Policy)
  and lock CORS to the app origin; ensure API errors are generic (no stack/secret leakage).
- [ ] **Step 5: Verify** — hammer `/api/review` past the limit → 429; `curl -I` shows headers.
- [ ] **Step 6: Commit.** `feat(sec): per-IP rate limit + concurrency cap + security headers`

---

## Task 10: Dependency audit

- [ ] **Step 1:** `npm audit --workspaces` → `npm audit fix` where safe; manually pin/patch remaining high/critical.
- [ ] **Step 2:** `pipeline/.venv/bin/pip install pip-audit && pipeline/.venv/bin/pip-audit` → patch high/critical.
- [ ] **Step 3:** Document any accepted residuals with justification in `docs/eval-reports/`.
- [ ] **Step 4: Commit.** `chore(sec): dependency audit (npm + pip) + fixes`
Deliverable: no unpatched high/critical, or a documented justification.

---

## Task 11: Vercel deploy

> **DEFERRED TO P6 (user decision, 2026-07-02):** P5 merges code-complete without the deploy;
> this task and its deploy-time checks moved to `docs/P6-scope.md`.

**Files:**
- Create: `app/vercel.json`
- Modify: `README.md` (deploy + seed steps)

- [ ] **Step 1: Managed pgvector** — create a Neon (or Supabase) Postgres with `pgvector`; from local,
  point `DATABASE_URL` at it and run `npm run migrate` (incl. `0007`), then `npm run load` + `npm run embed`
  for the curated docs, then `make clf-precompute`. Verify counts.
- [ ] **Step 2: `app/vercel.json`** — `{ "functions": { "app/api/review/route.ts": { "maxDuration": 60 } } }`
  (+memo). Set Vercel **Root Directory = `app`** (monorepo; core installs from the workspace root).
- [ ] **Step 3: Vercel env vars** (Production + Preview): `LLM_BASE_URL`, `LLM_MODEL=claude-sonnet-4-6`,
  `LLM_API_KEY` (Anthropic), `LLM_MAX_TOKENS`, `DATABASE_URL` (Neon), `RETRIEVE_MODE=hybrid`, Upstash creds.
  (Human-run in the Vercel dashboard; keys never printed.)
- [ ] **Step 4: Deploy** (connect repo or `vercel --prod`); confirm the build transpiles `@sift/core`.
- [ ] **Step 5: Smoke the public URL** — the agent page at `/` loads and streams a grounded, cited
  review of a curated NDA; memo stays gated; rate limit + headers active.
- [ ] **Step 6: Commit.** `chore(app): vercel deploy config`

---

## Task 12: Polish & narrative

- [ ] **Step 1: README** — architecture diagram (3 layers + MCP + demo), the before/after eval numbers
  (P3 + P4 gate), the live demo link, and local-run instructions.
- [ ] **Step 2: "How it works" narrative lives in the README** (grounding invariant, refusal, HITL) —
  no separate in-app page (single-page demo per the Task-3 removal decision); at most a one-line
  explainer on the agent page.
- [ ] **Step 3: Demo GIF / short walkthrough** (human-recorded) embedded in the README.
- [ ] **Step 4: Commit.** `docs: README + demo narrative for P5`
Deliverable: resume-ready repo + public link.

---

## Prerequisite (parallel, not blocking P5 dev)
- **P5.0 — clean off-peak gate re-run** (NIM, canonical model) before declaring the project "done".
  Note: with an Anthropic key available, the gate could alternatively be re-run on Claude for
  reliability — decide separately.

## Self-Review checklist (run before execution)
- Spec coverage: inference (Task 1), UI (2/3/6/7), API (5), classify-on-Vercel (4), security (8/9/10),
  hosting (11), polish (12) — all mapped. ✅
- No blocked tasks remain: all inputs (Vercel, Anthropic, precompute-classify, template, skill) are in.
- Pattern reuse verified against the repo: review path mirrors the existing `@sift/core/serve`
  `streamAnswer`/`sseEncode` + `EventSource` answer path; migrations follow `core/migrations/000N`;
  tests run on vitest.
- UI tasks fix contracts + testable invariants (esp. the `CitationHighlight` grounding invariant and
  the memo HITL gate); visual design is sourced from template + UI/UX Pro Max, deliberately not frozen.
- Type consistency: `resolveMaxTokens` signature identical across all three call sites;
  `getClauseLabel` (Task 4) is the exact classify dep consumed by `reviewStream` (Task 5).
- Dependency order: 1 → 2 → {3, 4} → 5 → 6 → 7 → {8, 9, 10} → 11 → 12 (3 and 4 are parallel; so are 8/9/10).
