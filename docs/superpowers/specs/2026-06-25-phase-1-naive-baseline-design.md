# Phase 1 — Naive Baseline: Design

**Status:** Approved (2026-06-25)
**Phase gate (PLAN.md P1):** Baseline recall@k / NDCG@10 + groundedness recorded; live URL deployed.
**This iteration:** record the baseline metrics from a local run; build deploy-ready but defer hosting.

## Goal
Stand up the **naive RAG baseline** end-to-end: single embedding model, fixed top-k, one-shot
generation. Produce clause cards with source-span citations (or an explicit "insufficient
context" refusal), and record the baseline retrieval + groundedness + refusal numbers that every
later phase is measured against. This is the reference point, not an optimization target.

## Architecture
Single-embedding, document-scoped top-k retrieval over the Phase 0 `clauses` corpus in pgvector,
feeding a provider-abstracted one-shot generator that emits a typed, citation-grounded
`ClauseCard`. A thin Next.js (App Router) UI streams cards over SSE. The eval harness computes
retrieval (recall@k, NDCG@10), groundedness (faithfulness), and refusal-correctness against the
already-loaded `eval-set-v1` (50 items). All logic lives in `core/` (the library); `app/` is a
thin UI+SSE layer that imports `core`.

## Tech stack
- **Embedding:** `Xenova/bge-large-en-v1.5` via `@huggingface/transformers` (ONNX, in-process,
  1024-dim → matches the existing `embeddings.embedding vector(1024)` column; **no migration**).
- **Generation:** provider-abstracted. Default adapter = OpenAI-compatible (`openai` SDK) pointed
  at NVIDIA NIM (free tier). Second adapter = Anthropic (`@anthropic-ai/sdk`). Switchable by env.
- **DB:** existing Postgres 16 + pgvector via Docker Compose; all access through `core/src/db/`.
- **App:** Next.js App Router, SSE route on the Node runtime.
- **Eval:** TypeScript, reuses `core/src/eval/` + the loaded corpus.

## Global constraints (inherited from CLAUDE.md / PLAN.md)
- **Citation invariant:** every span is `{doc_id,char_start,char_end,quote}` with
  `quote === raw_text.slice(char_start,char_end)` exactly. Enforced server-side before any
  card crosses SSE.
- **Typed payloads only:** the `ClauseCard` crossing core→UI is Zod-validated and conforms to
  `schemas/clause-card.schema.json` (JSON Schema is the cross-language source of truth).
- **Refuse when ungrounded:** "insufficient context" is a correct answer.
- **Public data only**, no PII, no secrets committed (`.env` is gitignored; `.env.example` documents keys).
- **Vector backend swappable:** all DB access goes through `core/src/db/`.
- **Evals are the merge gate:** `make verify-p1` is the single command that proves the phase.

---

## 1. Monorepo structure (root npm workspaces)
- Add root `package.json` with `"workspaces": ["core", "app"]`.
- `core` (`@sift/core`) gains an `"exports"` map exposing `embed`, `retrieve`, `generate`,
  `review`, and `schemas` entrypoints (subpath exports of the `.ts` sources; `app` transpiles them).
- `app` (`@sift/app`) lists `@sift/core` as a workspace dependency and sets
  `transpilePackages: ["@sift/core"]` in `next.config`.
- Phase 0's `core` scripts (`test`, `typecheck`, `migrate`, `load`, `eval`) keep working unchanged
  when run from `core/`. Root-level convenience scripts are optional.

## 2. Embedding — `core/src/embed/`
- `model.ts`: `embedTexts(texts: string[], opts?: { kind: "query" | "passage" }): Promise<number[][]>`.
  Loads `Xenova/bge-large-en-v1.5` once (module singleton), mean-pools the token embeddings,
  L2-normalizes. For `kind: "query"` only, prepend bge's documented instruction
  (`"Represent this sentence for searching relevant passages: "`); passages are embedded raw.
  Returns 1024-length vectors.
- `indexClauses.ts`: `indexAllClauses(): Promise<{ embedded: number }>` — stream `clauses` rows,
  embed `text` in batches (e.g. 32), upsert into `embeddings(node_id, model, embedding)` with
  `model = "bge-large-en-v1.5"`. Idempotent (`ON CONFLICT (node_id) DO UPDATE`). pgvector literals
  formatted as `'[v1,v2,...]'`.
- `cli.ts`: wired to `npm run embed`. Prints `embedded N clauses`.
- **Migration `0004_embeddings_index.sql`:** `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)`
  on `embeddings`, added now that vectors exist (as the 0003 comment anticipated). Idempotent
  (`IF NOT EXISTS`).

## 3. Retrieval — `core/src/retrieve/`
- `retrieve.ts`: `retrieve(query: string, docId: string, k = 8): Promise<Candidate[]>` where
  `Candidate = { node_id, doc_id, type, number, heading, text, char_start, char_end, score }`.
- **Naive baseline:** embed the query (`kind:"query"`), then
  `SELECT ... FROM clauses c JOIN embeddings e USING (node_id) WHERE c.doc_id = $doc
   ORDER BY e.embedding <=> $q LIMIT $k`. Cosine distance (`<=>`); `score = 1 - distance`.
- **Document-scoped** because contract review targets one contract and every eval item carries a
  `doc_id` — this makes recall well-defined and matches the product.

## 4. Generation — `core/src/generate/`
- `types.ts`: a `Generator` interface — `generate(prompt: GenInput): Promise<RawGen>` where
  `RawGen = { answer: string; supporting: number[]; refused: boolean; refusal_reason?: string }`.
  The model **cites by candidate index** (`supporting` = indices into the supplied candidate list),
  never by raw offsets.
- `openaiCompat.ts`: default adapter using the `openai` SDK with `baseURL = LLM_BASE_URL`
  (default `https://integrate.api.nvidia.com/v1`), `apiKey = LLM_API_KEY`, `model = LLM_MODEL`
  (default `moonshotai/kimi-k2-instruct` — an instruct model, not a `<think>` reasoning model).
  Requests JSON output; robustly extracts the JSON object (tolerate code fences / preamble).
- `anthropic.ts`: adapter using `@anthropic-ai/sdk` Messages API; default model `claude-sonnet-4-6`.
  **The implementer of this adapter must consult the `claude-api` skill** for exact SDK usage,
  model id, and JSON-output handling.
- `generate.ts`:
  - `makeGenerator()` picks the adapter from `LLM_PROVIDER` (`"openai"` default | `"anthropic"`).
  - `buildPrompt(objective, candidates)` renders each candidate as
    `[i] (doc_id, chars S-E) <text>` and instructs: answer **only** from the candidates, cite the
    supporting candidate indices, and **refuse** (`refused: true`) when the candidates do not
    support an answer.
  - `toClauseCard(objective, raw, candidates)`: maps `raw.supporting` indices → candidate spans →
    `ClauseCard.citations` as exact `{doc_id,char_start,char_end,quote}` (quote = the candidate's
    node text). **Citations therefore resolve by construction.** Drops out-of-range indices; if
    `refused` or no valid citations remain for a non-refusal answer, force a refusal card.

## 5. Typed payload — `ClauseCard`
- `schemas/clause-card.schema.json` (JSON Schema, cross-language SOT) and
  `core/src/schemas/clauseCard.ts` (Zod, `.strict()`), kept in lockstep (a contract test parses one
  fixture through both).
- Shape:
  ```
  ClauseCard = {
    objective: string,
    answer: string,                 // "" when refused
    citations: Span[],              // [] when refused
    refused: boolean,
    refusal_reason?: string | null,
  }
  Span = { doc_id: string, char_start: int>=0, char_end: int>=0, quote: string }
  ```
- `assertCardCitations(card, rawTextByDoc)`: throws unless every citation's
  `quote === raw_text.slice(char_start,char_end)`. Called before SSE emit and in tests.

## 6. Review orchestration — `core/src/review/review.ts`
- `reviewQuery(objective: string, docId: string, opts?): Promise<ClauseCard>` =
  `retrieve` → `buildPrompt` → `generate` → `toClauseCard` → `assertCardCitations`. The **single**
  end-to-end function reused by both the SSE route and the eval baseline (no duplicate pipelines).

## 7. Eval harness — `core/src/eval/`, `npm run eval -- baseline`
Definitions (precise, so the plan can encode them as tests):
- **Relevant node:** clause `n` is relevant to item `E` iff `n.doc_id == E.doc_id` and
  `[n.char_start,n.char_end)` overlaps some gold span of `E` (overlap ⇔ `max(starts) < min(ends)`).
- **Query text:** `E.objective`. **Retrieval set:** `retrieve(E.objective, E.doc_id, k)`.
- **recall@k** (`core/src/eval/retrieval.ts`): fraction of `E`'s gold spans *covered* by the top-k
  retrieved nodes (a gold span is covered if some top-k node overlaps it); macro-averaged over
  items with ≥1 gold span. Reported at k ∈ {1,5,10}.
- **NDCG@10:** binary relevance per retrieved rank (`rel_i = 1` if node at rank i overlaps any gold
  span). `DCG@10 = Σ rel_i / log2(i+1)`; `IDCG@10 = Σ_{i=1..min(R,10)} 1/log2(i+1)` where `R` =
  count of relevant nodes in `E.doc_id`. Macro-averaged over items with ≥1 relevant node.
  Retrieval metrics need **no LLM** — they can be produced before any generation key is set.
- **Groundedness** (`core/src/eval/groundedness.ts`):
  - *Citation-resolves rate* — every citation resolves (`quote === slice`). ~1.0 by construction;
    reported as a guardrail (any miss is a bug).
  - *Faithfulness* — LLM-as-judge over non-refusal cards: is each claim in `answer` supported by a
    cited span? Uses the same provider; reported as `faithfulness_rate`.
- **Refusal correctness:** on the refusal items (`grader == "refusal"`), did the system refuse? On
  a sample of answerable items, did it not refuse? Report refusal accuracy, false-refusal rate,
  missed-refusal rate.
- `baseline.ts` orchestrates the run over `evals/data/eval-set-v1.json`, prints a metrics block,
  and the controller records numbers in `docs/eval-reports/P1.md`.

## 8. UI + SSE shell — `app/`
- Next.js App Router. `app/api/review/route.ts` — **Node runtime** SSE endpoint: accepts
  `{ doc_id, objective }`, calls `reviewQuery`, and streams events: `status` (retrieving/generating),
  `card` (a Zod-validated `ClauseCard` JSON), `done`. Refusals stream as a `card` with `refused:true`.
- `app/page.tsx` — one page: a contract picker (dropdown of loaded `doc_id`s via a small
  `GET /api/docs` route) + an objective input + "Review". Renders streamed cards with the cited
  **quote highlighted** and its `doc_id` + char range shown; refusals render an explicit
  "insufficient context" card. Minimal styling — it's a shell.

## 9. Config, deploy-readiness, gate
- `.env.example`: `DATABASE_URL`, `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`.
- README: run steps (`make db-up migrate load embed`, run the app, run the eval).
- **`make` targets:** `embed` (index embeddings), `eval-baseline` (compute + print metrics),
  `dev` (run the Next app), `verify-p1`.
- **`make verify-p1`** (the gate): `db-up` → `migrate` (incl. 0004) → `embed` → assert every clause
  has an embedding → retrieval smoke (a known query returns its gold node in top-k) → compute
  baseline retrieval metrics and write/refresh `docs/eval-reports/P1.md` → `app` build succeeds.
  A baseline is **recorded, not threshold-gated** (its purpose is to be the reference number); the
  gate fails only on missing embeddings, unresolved citations, a broken pipeline, or a failing build.

## 10. Explicitly deferred (P2+) — not built now
Hybrid BM25 + dense + RRF, cross-encoder reranking, embedder comparison (`voyage-law-2` /
Legal-BERT), the agentic retrieve-evaluate loop, the **LegalBench-RAG NDA subset** (user deferred),
and actual hosting / live URL. Phase 1 sets the seams (swappable generator, `core/src/db/` boundary,
the `review` function) so these slot in without rework.

## 11. File map (for the implementation plan)
**Create:** root `package.json`; `core/src/embed/{model,indexClauses,cli}.ts`;
`core/migrations/0004_embeddings_index.sql`; `core/src/retrieve/retrieve.ts`;
`core/src/generate/{types,openaiCompat,anthropic,generate}.ts`; `core/src/schemas/clauseCard.ts`;
`schemas/clause-card.schema.json`; `core/src/review/review.ts`;
`core/src/eval/{retrieval,groundedness,baseline}.ts`; `app/*` (Next.js scaffold + page + api routes);
`docs/eval-reports/P1.md`; `.env.example`; tests under `core/test/` for each module.
**Modify:** `core/package.json` (deps, `exports`, `embed` script); `core/src/eval/cli.ts`
(`baseline` subcommand); `Makefile`; `README.md`; `CLAUDE.md` (commands), `DECISIONS.md`
(embedding-model + provider-abstraction + index-reference-citation decisions).

---

## Spec self-review
- **Placeholders:** none — every component has a concrete interface and the metric formulas are exact.
- **Consistency:** the citation invariant is honored two ways — citations are built from known-good
  node spans (resolve by construction) *and* re-checked by `assertCardCitations` before SSE; the
  groundedness metric therefore measures faithfulness, not offset-guessing. Consistent.
- **Scope:** one coherent phase (baseline retrieve→generate→UI→measure). Hybrid/rerank/fine-tune/
  hosting are explicitly deferred. Single implementation plan is appropriate.
- **Ambiguity:** retrieval is document-scoped (stated); recall is span-coverage (stated); groundedness
  is faithfulness + a resolves guardrail (stated); the baseline is recorded, not threshold-gated (stated).
