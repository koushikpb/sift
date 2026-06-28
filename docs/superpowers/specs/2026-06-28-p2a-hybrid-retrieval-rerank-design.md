# P2a — Hybrid retrieval + cross-encoder rerank (design)

- **Date:** 2026-06-28
- **Status:** Approved (brainstorming) → ready for implementation plan
- **Phase:** P2 "Retrieval upgrade", first slice (P2a). Embedder comparison and the
  agentic retrieve-evaluate loop are deferred to **P2b** and explicitly out of scope here.
- **Branch:** `phase-2a-hybrid-retrieval-rerank`

## Context

P1 recorded a naive baseline (single embedder, doc-scoped cosine top-k, one-shot generation):

| metric | baseline |
|---|---|
| recall@8 | 0.748 |
| NDCG@8 | 0.559 |
| groundedness | 1.00 |
| refusal_rate | 0.32 |
| errored | 0 |

The baseline analysis showed **retrieval is the bottleneck**: on the 37 answerable
items (clean + deviated), refused items had mean recall@8 = 0.30 (7/10 with the gold
span never retrieved) while answered items had 0.91. The model refuses correctly when
the gold span isn't retrieved — so lifting retrieval converts "false" refusals into
grounded answers. Groundedness is already 1.0 (the citation-integrity contract holds).

### Corpus shape (drives the design)
- 172 documents, 5,792 clauses, single embedder (`bge-large-en-v1.5`, 1024-dim).
- Retrieval is **doc-scoped** (`WHERE c.doc_id = $2`) — the product reviews one contract.
- Per-doc clause pools are **small**: min 1, median 18, avg 36, p90 75, max 401.

Because pools are small, P2a is mostly a **ranking-quality problem over a small per-doc
candidate set**, not large-scale ANN. For the median doc, "rerank the top 50–100
candidates" means *rerank the whole document* — which is where the recall@8 win comes from.

### Existing schema (unchanged except the one migration below)
- `clauses(node_id PK, doc_id, parent_id, type, number, heading, text, char_start,
  char_end, depth)` — hierarchy + metadata already present.
- `embeddings(node_id PK, model, embedding vector(1024))` — HNSW cosine index.
- No full-text / BM25 infrastructure yet.

## Goal & non-goals

**Goal:** add hybrid retrieval (dense + lexical fused with RRF) and a local cross-encoder
reranker behind the existing `retrieve()` boundary, measured against the P1 baseline on the
same eval set, with the naive baseline still reproducible for an apples-to-apples delta.

**Non-goals (P2b or later):** embedder comparison / legal-domain embedder; agentic query
reformulation and retrieve→evaluate→retrieve loop; corpus-wide (cross-document) retrieval;
metadata filters (YAGNI for P2a); true-BM25 extension (Postgres FTS is the P2a backend).

## Decisions (with rationale)

1. **Sequencing — incremental, eval-gated.** P2a = hybrid + rerank only; measure; then
   plan P2b. Matches the spec's "measure each improvement" mandate and keeps the bigger
   commitments (paid embedder API, LLM-heavy agentic loop) contingent on P2a's evidence.
2. **BM25 half = Postgres native full-text search** (`tsvector` + GIN + `ts_rank_cd`).
   No new infrastructure, stays in the one Postgres, all access through `core/src/db/`.
   It is tf-idf-style ranking, not literally BM25 — acceptable because **RRF fuses on rank
   position, not raw scores**, so the FTS-vs-BM25 difference largely washes out. If the
   eval later shows lexical ranking is the bottleneck, swap in a true-BM25 backend then.
3. **Reranker = local cross-encoder** (`ms-marco-MiniLM-L-6-v2`) on the existing
   `@huggingface/transformers` / onnxruntime stack. Free, no API key, consistent with the
   local-first setup. Behind an interface so an API reranker is a later config swap.

## Data flow

`retrieve(query, docId, k = 8)` becomes a 4-stage, doc-scoped pipeline:

```
1. dense    → pgvector cosine top-N         (N_dense = 50, ranked)
2. lexical  → Postgres FTS ts_rank_cd top-N (N_lex   = 50, ranked)   ← parallel with dense
3. fuse     → RRF(dense, lexical, k_rrf=60) → take top M = min(pool, 100)
4. rerank   → local cross-encoder scores (query, clause) pairs → final top-k
return Candidate[]   // unchanged shape → generator & clause-card layer untouched
```

The returned `Candidate[]` shape is unchanged, so the generator, `toClauseCard`, and the
SSE layer need no changes.

## Components (each isolated, one responsibility, testable alone)

- **`core/src/retrieve/dense.ts`** — `denseRetrieve(query, docId, n): Promise<Candidate[]>`.
  The current vector query extracted as-is (ranked by cosine).
- **`core/src/retrieve/lexical.ts`** — `lexicalRetrieve(query, docId, n): Promise<Candidate[]>`.
  Doc-scoped FTS via `websearch_to_tsquery('english', query)`, ranked by `ts_rank_cd`.
- **`core/src/retrieve/rrf.ts`** — `rrfFuse(rankedLists: Candidate[][], opts: { k: number }): Candidate[]`.
  **Pure function.** Reciprocal Rank Fusion: `score(node) = Σ_list 1/(k + rank_list(node))`,
  deduped by `node_id`, returns the fused ranking. No infra → fully unit-testable.
- **`core/src/rerank/model.ts`** — `rerank(query, candidates, topK): Promise<Candidate[]>`.
  Local cross-encoder (`RERANK_MODEL`, default `ms-marco-MiniLM-L-6-v2`) scoring each
  (query, clause.text) pair; returns the top-K by rerank score. Mirrors `embed/model.ts`.
- **`core/src/retrieve/retrieve.ts`** — orchestrator composing the four stages. Takes the
  sub-functions (dense, lexical, rerank) as **injectable deps** so the compose/cap/top-k
  logic is unit-testable without a DB or model.
- **`core/src/retrieve/index.ts`** — `makeRetriever(mode)` factory (parallel to
  `makeGenerator`) returning a `retrieve(query, docId, k)` function. `RETRIEVE_MODE =
  naive | hybrid`, **default `naive`**:
  - `naive` → `denseRetrieve(query, docId, k)` only — today's behavior, byte-for-byte, so
    the baseline stays reproducible.
  - `hybrid` → the full 4-stage pipeline above.
  Existing call sites (`core/src/eval/cli.ts`, the SSE route's lazy import of
  `@sift/core/retrieve`) switch from importing the bare `retrieve` to
  `makeRetriever(process.env.RETRIEVE_MODE)`. The package's `./retrieve` export continues to
  expose a `retrieve` for back-compat, resolving the mode from env.

## Schema (one migration)

`core/migrations/0005_clauses_fts.sql` — generated **STORED** tsvector column + GIN index:

```sql
ALTER TABLE clauses ADD COLUMN text_search tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(heading, '')), 'A') ||
    setweight(to_tsvector('english', text), 'B')
  ) STORED;
CREATE INDEX IF NOT EXISTS clauses_fts_idx ON clauses USING GIN (text_search);
```

Generated+stored **auto-backfills existing rows** on `ALTER` and self-maintains on future
loads — no app code to keep it in sync. Heading weighted `A` so objectives like "Governing
Law" hit clause titles hard; body text weighted `B`.

## Config & swappability

- `RETRIEVE_MODE = naive | hybrid` (default `naive`). Eval/app flip to `hybrid` for P2a.
- `RERANK_MODEL` (default `ms-marco-MiniLM-L-6-v2`) — A/B `bge-reranker-base` with no code change.
- Stage sizes as named constants with defaults: `N_dense = 50`, `N_lex = 50`, `M = 100`,
  `k_rrf = 60`. Tunable, not magic numbers.
- All DB access remains in `core/src/db/`; the reranker stays behind an interface.

## Eval & success criteria (the merge gate)

- **Same `eval-set-v1` (50 items), same harness** — only `RETRIEVE_MODE` changes, so the
  delta is apples-to-apples.
- Wire `RETRIEVE_MODE` into `core/src/eval/cli.ts`; write `evals/reports/p2a.json` (stamped
  with mode + embed model + rerank model), leaving `baseline.json` intact.
- New `npm run eval -- compare baseline.json p2a.json` prints the **delta table**:
  recall@8, NDCG@10, groundedness, refusal_rate, and **false-negative rate**.
  - **False-negative rate** (spec top-line) is defined here as: of the answerable items
    (category `clean` + `deviated`), the fraction where the gold span never reaches the
    answer — i.e. the item refused, or answered without citing a gold-overlapping span.
- **Gate = a reported, explained delta table** with **groundedness holding at ~1.0** (no new
  hallucination). Target: recall@8 up from 0.75 (aiming ≥ ~0.85) and NDCG@10 up. A lever that
  doesn't move the needle is a valid measured finding — recorded and carried into P2b, not
  papered over.

## Error handling (degrade, never crash)

- Reranker load/score failure → fall back to the **fused (pre-rerank) order**, log to stderr.
  A bad model load cannot take down retrieval.
- Empty lexical *or* dense list → RRF uses whichever returned. No candidates at all → `[]` →
  the generator refuses (existing path).
- `runEval`'s per-item try/catch already isolates any single-item failure.

## Testing

- **`rrf.test.ts`** (pure, no infra) — fusion order, ties, empty list, dedupe by `node_id`,
  `k` parameter.
- **`retrieve.hybrid.test.ts`** (unit, injected dense/lexical/rerank fakes) — orchestrator
  composes the stages, caps the pool at `M`, returns top-k. No DB/model required.
- **`lexical.test.ts`** (DB-backed; needs `make db-up`) — FTS surfaces the keyword clause,
  doc-scoped.
- **`rerank.model.test.ts`** (infra; native binding + model download) — a relevant
  (query, clause) pair scores above an irrelevant one.
- **Eval delta table** is the merge gate.

## Risks / open questions

- **Local cross-encoder CPU latency.** Median 18 pairs/query is trivial; the `M = 100` cap
  bounds the worst case (the 401-clause doc). If latency is still a problem, reduce `M` or
  move the reranker to an API later (interface already allows it).
- **onnxruntime teardown crash** (`mutex lock failed`) on `process.exit` after model load is
  a known, cosmetic exit-code/output artifact — not a failure. Run model-loading tests in
  isolation when verifying (see the infra-boundary notes).
- **FTS English stemming on legal text** — defined terms and section numbers may tokenize
  oddly; `ts_rank_cd` + heading weighting should cover the common cases. Revisit only if the
  eval shows lexical recall is weak.
