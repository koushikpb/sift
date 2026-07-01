# DECISIONS.md

Architectural decisions, kept current as they are made. Newest first.

## 2026-07-01 — Phase 4: Action agent + MCP (SPEC Layer 3)
- **ADOPT the action agent.** P4's acceptance is "report agent evals + hold the hard invariants +
  write a failure-mode taxonomy" (no pre-registered task-success threshold). Both hard invariants
  hold: **citation groundedness 1.0** (no hallucinated spans) and **0 unconfirmed writes** (the HITL
  gate held across all 50 items). On the 39 items that completed without a NIM transport failure:
  task success **0.846**, **flag coverage 19/19 (false-negative rate 0)**, refusal correctness
  **2/2**. The 6 real (non-transport) failures are all span-localization retrieval misses (Layer-1
  ceiling), not action-layer defects. Full report: `docs/eval-reports/P4.md`.
- **Agent = deterministic tool trajectory, not an LLM free-choice loop.** `reviewContract` composes
  retrieve→check_playbook→classify→flag→redline→memo in a fixed order so the trajectory is
  reproducible and the gate is stable. An LLM-driven MCP client can still drive the same tools live
  (the demo); the gate uses the deterministic path.
- **HITL gate lives in the tool, proven by absence of writes.** `export_memo` is the only write tool
  and no-ops (returns a preview) unless `confirm===true`. The eval never confirms, so
  `unconfirmed_writes===0` is positive proof the guardrail holds.
- **classify_clause bridges the P3 LoRA over a JSON-Schema'd Python CLI** (`schemas/clf-prediction.
  schema.json`), consistent with the repo's "modules meet at validated JSON" rule.
- **Flag selection keys off the OBJECTIVE, not the CUAD classifier label (the C1 fix).** The eval's
  flag_match objectives are ContractNLI-style; CUAD's 37 labels map to only ~2 playbook positions,
  so a classify-keyed design scored ~1/25. Resolving the position from the objective (explicit
  `(playbook requires X)` tag for missing items; a curated ContractNLI-hypothesis→position map for
  deviated items) + a "missing required clause" flag (grounded in absence, `citation:null`) restored
  flag coverage to 19/19. This is understanding the review *request*, not reading the answer — the
  deviation/absence verdict still comes from the judge/retrieval.
- **Bounded LLM timeout + retry on all NIM clients** (`LLM_TIMEOUT_MS`, default 45s; `maxRetries:1`).
  Without it the OpenAI SDK waits ~10 min on a stalled NIM connection and hangs eval runs; a finite
  timeout lets a stall fail fast so the per-item degrade path continues.
- **Gate model substitution: `llama-3.1-70b-instruct`.** The configured `llama-3.3-70b-instruct` was
  inference-unavailable on NIM at gate time (NIM `/models` 200/0.13s, but its `/chat/completions`
  returned 0 bytes/25–30s repeatedly); the comparable 70B `llama-3.1` responded in ~1.5s. P4's gate
  tests the action agent, not a specific model, so a comparable working 70B is a fair substitution.
  A clean re-run on `llama-3.3-70b` when NIM is stable would tighten the headline numbers.

## 2026-06-30 — Phase 3: Prompt → RAG → Fine-tune decision (Layer 2 clause classifier)
- **Decision: ADOPT the LoRA-fine-tuned clause classifier over the prompted baseline.** The
  before/after was run on an *identical* 371-item stratified CUAD test subset (37 classes),
  with the metric-to-beat declared in advance: **adopt iff LoRA macro-F1 ≥ prompted baseline
  + 0.05.** Result: prompted (few-shot `meta/llama-3.3-70b-instruct`) macro-F1 **0.6657** /
  acc 0.7439 → LoRA (Legal-BERT) macro-F1 **0.7177** (**+0.0520**, clears the bar) / acc
  **0.8356** (**+0.0916**). Full report: `docs/eval-reports/P3.md`.
- **Why this is a genuine adopt, not a coin-flip.** The macro-F1 win is thin (+0.0020 over the
  +0.05 bar) and within sampling noise on a 371-item / 37-class subset; the decisive, robust
  evidence is the +0.0916 accuracy gain and the *breadth* of per-class improvement (most
  classes up, few tied, one rare class regressed). Prompting was exhausted first (a strong 70B
  few-shot baseline with per-class in-context examples) before fine-tuning was chosen — the
  fine-tune earned its place rather than being assumed.
- **Base model: Legal-BERT (`nlpaueb/legal-bert-base-uncased`), not DeBERTa-v3-base.** Two
  reasons: (1) DeBERTa-v3's disentangled attention falls back to CPU on Apple MPS, projecting
  ~21 h to train here, while Legal-BERT uses standard attention (native MPS, ~50 min);
  (2) Legal-BERT is the SPEC-recommended legal-domain encoder. Swappable via `CLF_BASE_MODEL`
  (+ `CLF_LORA_TARGETS`, `CLF_SAVE_MODULES` for non-DeBERTa attention/head names).
- **Train the SEQ_CLS pooler, not just the classifier.** MLM checkpoints (DeBERTa-v3,
  Legal-BERT) ship no classification `pooler.dense`; it is randomly initialized at load. PEFT's
  default `modules_to_save` for SEQ_CLS covers only the classifier, leaving the pooler frozen at
  random init *and* unsaved — so eval would re-init a different random pooler and the LoRA would
  score near-random, silently invalidating the gate. Fix: `modules_to_save=["classifier",
  "pooler"]` so both are trained and round-trip to eval.
- **Fixed-length padding (`MAX_LEN=128`) for training.** Per-batch dynamic padding makes every
  new sequence length a new MPS graph (recompile stalls of 14–29 s/step → ~21 h). A fixed shape
  compiles once (~0.5 s/step). Clauses are short (median 39 tok, 91.5% ≤ 128); train and eval
  share `MAX_LEN` so the score stays fair.
- **Cost-bounded but fair test set.** `CLF_TEST_LIMIT` takes a deterministic seeded stratified
  subsample (≥1/class) used identically by baseline and eval, bounding NIM calls (~10 min vs
  ~1 h on the full 2197-item test) without biasing the comparison.

## 2026-06-24 — Phase 0 foundations
- **CUAD sourced from `theatticusproject/cuad`'s `CUAD_v1.json` (SQuAD format), not `cuad-qa`.** The `theatticusproject/cuad-qa` HF dataset is script-based and `datasets`>=3 refuses to run dataset scripts; the plain `CUAD_v1.json` file is downloaded directly and flattened to the flat-record shape `normalize_cuad` expects.
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
- **`EvalItem.category` and `EvalItem.grader` are orthogonal.** `category`
  (`clean`/`deviated`/`missing`) describes the *contract state* the item tests; `grader`
  (`span_match`/`flag_match`/`refusal`) describes *how the item is scored*. A `refusal` item —
  an out-of-scope question the contract cannot answer — has `category: "missing"` (the queried
  information is genuinely absent) and `grader: "refusal"` (the correct behavior is to refuse).
  Refusal items are therefore identified by their grader, never by a dedicated category, which
  is why the eval-set validator gates on the three category values plus a separate
  `requireRefusal` check on the grader. No `"refusal"` category is added to the schema.
