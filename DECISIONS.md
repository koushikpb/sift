# DECISIONS.md

Architectural decisions, kept current as they are made. Newest first.

## 2026-06-24 — Phase 0 foundations
- **Hybrid language split.** Python (`pipeline/`) owns ingestion + the structure-aware
  parser; TypeScript (`core/`) owns the pgvector schema, loader, and eval tooling. They meet
  only at on-disk JSON artifacts validated against `schemas/`. Rationale: keep data-heavy
  parsing in Python's ecosystem while keeping the DB/retrieval layer in the app's TS
  ecosystem (Layer 1 is TS/Next.js); reserve Python for data + fine-tuning per the spec.
- **pgvector via local Docker Compose** for development (image `pgvector/pgvector:pg16`).
  Defer hosted Postgres to P1 when a live URL is needed. Rationale: self-contained,
  reproducible, no external account or secrets in Phase 0.
- **Eval set v1 derived-then-curated.** A converter derives candidate items from CUAD +
  ContractNLI gold labels; humans curate down to 50 (clean/deviated/missing mix).
  Rationale: ground the set in expert labels and reach a defensible v1 faster than
  hand-authoring from scratch.
- **Embeddings deferred to P1.** Phase 0 sets up pgvector (extension, schema, smoke test)
  and loads structured chunks without vectors; the embedder is a measured P1/P2 experiment,
  so committing to a model/dimension now would be premature. Embedding column dimension is
  a single documented constant (`embeddings.embedding vector(1024)`) that P1 confirms.
- **`GoldLabel` spans omit `doc_id`; `EvalItem` gold_spans carry it.** A `GoldLabel` belongs
  to exactly one document, so its `spans` inherit the label's top-level `doc_id` rather than
  repeating it (DRY; the shared Python `Span` model stays minimal). `EvalItem.gold_spans`
  *do* carry `doc_id` because the eval harness treats each citation as self-describing and an
  item may, in principle, reference more than one document. The two span shapes are used in
  different layers (Python ingestion vs TS eval) and are intentionally not a single shared
  type. The canonical citation format `{ doc_id, char_start, char_end, quote }` is the
  self-describing form; `GoldLabel` spans are the inherited-context form.
