# P2b — Embedder comparison (design)

- **Date:** 2026-06-28
- **Status:** Approved (brainstorming) → ready for implementation plan
- **Phase:** P2 "Retrieval upgrade", second slice (P2b). The agentic retrieve→evaluate
  loop is the next slice (**P2c**) and is out of scope here.
- **Branch:** `phase-2b-embedder-comparison` (stacked on `phase-2a-hybrid-retrieval-rerank`).

## Context

P2a (hybrid retrieval + cross-encoder rerank) shipped and its eval gate showed retrieval
is still the ceiling: recall@8 0.748 → 0.784, NDCG@8 0.559 → 0.632, groundedness held at
1.0. The reranker maxed out *ranking* quality (NDCG +7.3 pts); recall moved less (+3.6)
because a gold span must first be **retrieved** to be reranked. The most direct lever on
recall is the **embedding model** — a better embedder pulls more gold spans into the
candidate pool, lifting both the fused set and what the reranker can reorder.

Spec Layer 1 step 5 calls for benchmarking ≥2 embedders (a strong general model vs a
legal-domain model such as `voyage-law-2` or Legal-BERT).

### Availability finding (drives the embedder choice)
- **No good free/local legal *retrieval* embedder exists in ONNX.** `nlpaueb/legal-bert-base`
  and `Stern5497/sbert-legal-xlm-roberta-base` have zero ONNX exports, and Legal-BERT is a
  masked-LM (not retrieval-tuned) regardless. The spec's legal-domain test therefore requires
  **`voyage-law-2` (paid API)**.
- Strong free/local **general** embedders are ONNX-ready and all 1024-dim (same as
  `bge-large`): `mxbai-embed-large-v1`, `bge-m3`, `gte-large`, `snowflake-arctic-embed-l`.

Given the project's consistent free/local posture, P2b benchmarks `bge-large` against one
strong free general embedder — **`mxbai-embed-large-v1`** (top-MTEB English retrieval). A flat
or negative result is itself the deliverable: it tells us a stronger *general* embedder isn't
the lever, which is the signal that justifies (or rules out) spending on the paid legal
embedder in a later slice.

### Current state
- Embedding is hardwired to `bge-large-en-v1.5` (`Xenova/bge-large-en-v1.5`, mean pooling,
  query prefix) in `core/src/embed/model.ts`.
- `embeddings(node_id PK, model text, embedding vector(1024))` — PK is `node_id` only, so it
  holds exactly one model's vector per node. HNSW cosine index on `embedding`.
- `denseRetrieve` (from P2a) embeds the query and cosine-ranks doc-scoped over `embeddings`.

## Goal & non-goals

**Goal:** make the embedder a configured choice so two models' vectors coexist, then
benchmark `bge-large` vs `mxbai-embed-large-v1` on the retrieval eval (naive/dense-only, to
isolate the embedder) and report the delta vs the bge-large baseline.

**Non-goals (later slices / out of scope):** the paid `voyage-law-2` path; the agentic
retrieve→evaluate loop (P2c); re-tuning the hybrid pipeline beyond inheriting the winning
embedder; embedders with a non-1024 dimension (would need a separate column/migration).

## Decisions (with rationale)

1. **Free general embedder, `mxbai-embed-large-v1`.** No free local legal retrieval embedder
   exists; mxbai is a strong, free, 1024-dim, ONNX general embedder. Honors "benchmark ≥2
   embedders" at zero new cost. (Swappable via the registry; `bge-m3` is the fallback.)
2. **Compare in NAIVE (dense-only) mode.** Isolates the embedder's effect on recall; the
   hybrid lexical+rerank layer would confound it. If mxbai wins, a follow-on hybrid
   re-measure (cheap, optional) shows production impact.
3. **`(node_id, model)` composite key.** Lets both models' vectors live side by side and
   fixes the phase-1 footgun where the embed skip keyed on `node_id` alone (changing the
   model silently no-op'd).

## Data flow

`EMBED_MODEL` (env, default `bge-large-en-v1.5`) selects the active embedder everywhere, so
stored vectors and query vectors always match:

```
embed:    indexClauses embeds clauses with the active model → embeddings(model = active)
retrieve: denseRetrieve embeds the query with the SAME active model
          + filters `AND e.model = $active` in the cosine query
compare:  re-embed corpus as mxbai → eval in naive mode (EMBED_MODEL=mxbai, RETRIEVE_MODE=naive)
          → compare vs the bge-large naive baseline (baseline.json)
```

## Components

- **`core/src/embed/registry.ts`** (new) — `EMBED_REGISTRY: Record<string, EmbedConfig>` where
  `EmbedConfig = { repo: string; pooling: "mean" | "cls"; queryPrefix: string; dim: number }`.
  Entries: `bge-large-en-v1.5` (repo `Xenova/bge-large-en-v1.5`, `mean`, current prefix, 1024)
  and `mxbai-embed-large-v1` (repo + pooling + prefix pinned in the plan against the model
  card, 1024). `resolveEmbedConfig(name): EmbedConfig` throws listing known names on miss.
- **`core/src/embed/model.ts`** (modify) — `embedTexts(texts, { kind, model? })` resolves the
  config from the registry (repo/pooling/prefix), with a lazy singleton pipeline **per model
  name** (a `Map<string, Promise<pipeline>>`). `EMBED_MODEL` is the active default. With the
  default model and `mean` pooling, bge-large output is byte-for-byte unchanged.
- **`core/src/retrieve/dense.ts`** (modify) — embed the query with the active model and add
  `AND e.model = $model` to the cosine query (doc-scoped pools are tiny, so the filter is
  cheap and correct regardless of the HNSW index).
- **`core/src/embed/indexClauses.ts`** (modify) — embed with the active model, store its name
  in `model`, and change the skip-already-embedded predicate to key on `(node_id, model)`.
- **`core/src/embed/model.ts` exports** — keep `EMBED_MODEL` (active default name) and
  `EMBED_DIM`; add the registry lookup. Unknown `EMBED_MODEL` fails loudly.
- **`core/src/eval/cli.ts`** (modify) — stamp `embed_model` into the report provenance; add an
  `EVAL_OUT` env override for the report filename (so naive+mxbai writes `p2b-mxbai.json`
  instead of clobbering `baseline.json`).

## Schema (one migration)

`core/migrations/0006_embeddings_model_pk.sql` — composite key so both models coexist:

```sql
ALTER TABLE embeddings DROP CONSTRAINT embeddings_pkey;
ALTER TABLE embeddings ADD PRIMARY KEY (node_id, model);
```

Existing rows already carry `model = 'bge-large-en-v1.5'`, so this is non-destructive. The
`vector(1024)` column and the HNSW index are unchanged (both candidates are 1024-dim). The
`node_id` FK to `clauses` is preserved (it's a column-level reference, unaffected by the PK
change).

## Eval method & success criteria (the gate)

1. **Re-embed** as mxbai: `EMBED_MODEL=mxbai-embed-large-v1 npm run embed` — one ~30–60 min
   run; the `(node_id, model)` skip embeds only the missing mxbai rows and leaves bge-large
   untouched; a re-run resumes.
2. **Eval (naive)**: `EMBED_MODEL=mxbai-embed-large-v1 RETRIEVE_MODE=naive EVAL_OUT=p2b-mxbai.json
   npm run eval -- run`.
3. **Compare**: `npm run eval -- compare baseline.json p2b-mxbai.json` → delta table
   (recall@8, NDCG@8, groundedness, refusal_rate, false_negative_rate).

**Gate:** a reported, explained `bge-large` vs `mxbai` delta table with groundedness holding
~1.0. **Decision rule:** if mxbai lifts recall@8 / NDCG → adopt it as the default dense
embedder (set `EMBED_MODEL`; the hybrid pipeline inherits the gain) and record the decision.
If flat/worse → bge-large stays; the measured null is the deliverable and informs whether the
paid legal embedder is worth a future slice.

## Error handling

- Unknown `EMBED_MODEL` / `model` arg → throw an error naming the known registry entries.
- Registry `dim` must equal the `vector(1024)` column width; a mismatched model fails loudly
  rather than silently writing wrong-width vectors.
- Re-embed is resumable via the `(node_id, model)` skip — an interrupted run picks up where it
  left off (and the onnxruntime teardown crash on a no-op re-run is the known cosmetic exit
  artifact).

## Testing

- **`registry.test.ts`** (pure, no infra) — known-model lookup returns the config; unknown
  model throws an error naming the registry entries; both entries are 1024-dim.
- **`embed.model` model-aware** (infra; downloads mxbai weights) — mxbai returns one
  normalized 1024-d vector per text; the bge-large path is unchanged; per-model singleton
  caches (two different models return different vectors for the same text).
- **dense model-filter** (DB-backed) — seed one node with vectors under two model names;
  `denseRetrieve` with the active model returns only that model's row/score, never the other's.
- **Eval delta table** is the merge gate.

## Risks / open questions

- **mxbai pooling/prompt correctness.** mxbai uses a different pooling than bge (its model card
  specifies the exact pooling + retrieval prompt); the plan pins the exact values against the
  card. A wrong pooling would unfairly handicap mxbai — the model test (normalized 1024-d +
  sane similarity ordering) is the guard.
- **Re-embed cost.** ~30–60 min, CPU-heavy (loud fans). One-time per embedder; resumable.
- **Multilingual vs English.** mxbai is English-tuned (good for these English contracts); if it
  underperforms, `bge-m3` (multilingual) is the registry fallback, but English-tuned is the
  right first bet.
- **HNSW + model filter.** Doc-scoped retrieval already scans a tiny per-doc candidate set, so
  the added `e.model` filter is correct and cheap even though the single HNSW index spans both
  models; no per-model partial index is needed at this corpus size.

## Results (P2b) — 2026-06-29

`bge-large-en-v1.5` vs `mxbai-embed-large-v1`, both NAIVE (dense-only, to isolate the
embedder), same `eval-set-v1` (50 items), `meta/llama-3.3-70b-instruct`, k=8. Reports:
`evals/reports/baseline.json` (bge) vs `evals/reports/p2b-mxbai.json` (mxbai).

| metric | bge-large | mxbai | delta |
|---|---|---|---|
| recall@8 | 0.7477 | 0.7452 | −0.0026 |
| NDCG@8 | 0.5592 | 0.5717 | +0.0125 |
| groundedness | 1.0000 | 1.0000 | +0.0000 |
| refusal_rate | 0.3200 | 0.3800 | +0.0600 |
| false_negative_rate | 0.3243 | 0.3514 | +0.0270 |

(0 errored in both runs.)

**Decision: KEEP `bge-large-en-v1.5` as the default embedder.** mxbai does not beat it —
recall@8 is flat-to-slightly-worse, NDCG is marginally up, but the two metrics that capture
"did we surface the required clause" (refusal_rate, false_negative_rate) both regressed
(+6.0 pts and +2.7 pts). Groundedness held at 1.0. The decision rule (adopt only on a
recall/NDCG lift) is not met.

**Reading it — a useful measured null.** Two top-tier *general* English embedders are
comparable on these legal clauses, and bge edges it. So a stronger **general** embedder is
**not** the recall lever. The pooling/prompt were pinned to mxbai's model card (CLS + the
retrieval prompt) and the T2 model test confirmed valid normalized 1024-d vectors distinct
from bge, so this is a genuine quality result, not a misconfiguration: a modest under-perform
(not a collapse) is what "valid but not better" looks like.

**For P2c and beyond.** The remaining recall levers are (a) a **legal-domain** embedder
(`voyage-law-2`, paid) — the domain-gap hypothesis this null *doesn't* rule out, and (b) the
**agentic retrieve→evaluate loop** (query reformulation + retry) to rescue the one-shot
misses. Since bge already matches a top general model, the free lever is (b); the paid legal
embedder (a) is now an evidence-driven "maybe later," not a default next step.

**Durable deliverable.** Regardless of the null, P2b leaves embedding **model-aware**
(registry + `(node_id, model)` key + model-filtered retrieval), so re-testing any future
embedder — including `voyage-law-2` — is a config change plus a re-embed, not a code change.
(mxbai's vectors remain in `embeddings` under `model='mxbai-embed-large-v1'`; harmless —
default retrieval filters to bge — and kept in case of a future re-test.)
