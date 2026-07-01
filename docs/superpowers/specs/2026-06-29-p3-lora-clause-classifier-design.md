# P3 — LoRA-tuned clause classifier (design)

- **Date:** 2026-06-29
- **Status:** Approved (brainstorming) → ready for implementation plan
- **Phase:** P3 — SPEC Layer 2 ("LoRA-tuned component, lift proven"). Layer 1 (P1–P2)
  is complete and merged.
- **Branch:** `phase-3-lora-clause-classifier` (off `main`, which now carries P1 + P2a/b/c).

## Context

Layer 1 built and measured the full RAG stack (naive → hybrid+rerank → embedder comparison →
agentic loop). Layer 2 fine-tunes **one small, behavior-bound component** and proves the lift
on the same eval, after exhausting prompting and RAG. The spec offers three targets — clause
classifier, cross-encoder reranker, or query rewriter. We chose the **clause classifier**:
the reranker already maxed out in P2a (NDCG +7.3 pts), and P2c's convergence finding (18/22
reformulation rounds found nothing new) shows a query rewriter would likely hit the embedder
ceiling. The classifier is a fresh, free/local, behavior-bound component, and it feeds Layer 3's
`classify_clause` / `check_playbook` tools.

The label source is **CUAD's `clause_type` taxonomy**: `data/raw/cuad/CUAD_v1.json` (SQuAD
format) carries expert clause annotations across 41 categories. The existing ingest
(`pipeline/pipeline/ingest/cuad.py`, `_clause_type(question)` + `_flatten_squad`) is currently
**capped** for a fast first pass, so our processed `gold.jsonl` is a subset; the raw file holds
far more annotated spans. ContractNLI's labels are NLI (a different task) and are not used here.

## Goal & non-goals

**Goal:** train a LoRA clause-type classifier and **prove (or disprove) that it beats a fair
prompted-LLM baseline** on a held-out, document-disjoint CUAD test split — primary metric
**macro-F1**, decision rule stated in advance — and record the Prompt→Fine-tune decision in
`DECISIONS.md`.

**Non-goals (later / out of scope):** an "Other"/reject class for out-of-taxonomy clauses
(Layer 3's concern); wiring the classifier into the live retrieve/generate path (Layer 3's
`classify_clause` tool); a context window beyond the annotated span; tuning the reranker or a
query rewriter; QLoRA on an instruct LLM (the encoder route was chosen); the NDA-playbook
taxonomy (no direct gold labels). A measured null (prompting wins) is an in-scope deliverable.

## Decisions (with rationale)

1. **CUAD `clause_type` taxonomy, closed-set, count-floored.** Re-extract all annotated spans
   from `CUAD_v1.json`; keep the clause types with **≥ a floor count (default 50)** — roughly
   the top ~15–20 of 41 types. Closed-set: input is assumed to be one of those types, **no
   "Other" class** (YAGNI; Layer 3 handles real-world rejection). Real expert labels → a
   credible held-out test set.
2. **Classify the annotated span's text** (the CUAD `quote`), which is exactly what CUAD labels.
   Short spans (e.g. *Parties* = entity names) are a known limitation macro-F1 will expose, not
   paper over. *(Deferred alternative: map spans to containing parsed clause nodes and classify
   whole-clause text — adds a join; not worth it for a first cut.)*
3. **Encoder + LoRA, `deberta-v3-base`.** LoRA adapters via PEFT over
   `AutoModelForSequenceClassification`. Free/local, trains in minutes on a Mac (MPS/CPU), tiny
   adapter. `legal-bert-base` is a swappable A/B base (legitimate for *classification* even
   though P2b ruled it out for *retrieval*). This is *training* (PyTorch), not the onnxruntime
   inference path, so it sidesteps the P2 teardown crash.
4. **Fair prompted baseline = the "before."** A genuine few-shot LLM classifier on the same NIM
   `meta/llama-3.3-70b-instruct`: each clause type gets a one-line definition + in-context
   examples. The spec mandates exhausting prompting first; a strawman baseline would make a
   fine-tune "win" meaningless.
5. **Full CUAD re-extract** (extend `ingest/cuad.py`/add an extractor) — thousands of labeled
   spans give the LoRA a fair chance, so the before/after is a real test, not a small-data
   artifact.
6. **Document-level split.** Group by `doc_id`: every span from a contract goes to exactly one
   of train/val/test. Splitting by *span* would leak a contract's idiosyncratic phrasing across
   train and test and inflate scores. This is the safeguard that makes the result credible.
7. **Primary metric `macro-F1`, stated in advance** (every clause type weighted equally — the
   model can't win by predicting only frequent types). Secondary: accuracy (micro-F1), per-class
   F1, worst-confused pairs. **Decision rule: fine-tune wins iff tuned macro-F1 ≥ prompted
   macro-F1 + 0.05** (absolute); below that → inconclusive / Prompt wins, recorded as such.

## Data flow

```
extract:  CUAD_v1.json → (span_text, clause_type) for every non-empty annotation
          → drop clause_types with < floor examples
          → document-GROUPED split (≈70/15/15 of documents, seeded; no doc in two splits;
            every kept class present in all three splits)
          → data/processed/cuad_clf/{train,val,test}.jsonl  +  label_map.json

baseline: few-shot prompted llama-3.3-70b classifies the TEST split → macro-F1     ← "before"
          → evals/reports/clf_baseline.json

train:    LoRA-tune deberta-v3-base (+ seq-class head) on train, early-stop on val
          → models/cuad_clf/{adapter, label_map}

eval:     tuned classifier predicts the SAME test split → macro-F1                  ← "after"
          → evals/reports/clf_lora.json

decide:   before/after table (macro-F1, accuracy, per-class) → DECISIONS.md verdict
```

The frozen `test.jsonl` is the single shared yardstick for both the baseline and the tuned
model — apples-to-apples.

## Components (each isolated, one responsibility)

All new, under `pipeline/pipeline/classify/` (Python — the spec reserves `pipeline/` for data +
fine-tuning):

- **`extract.py`** — read `CUAD_v1.json`, emit `(span_text, clause_type, doc_id)` for every
  non-empty annotation (reuses `_flatten_squad` / `_clause_type` from `ingest/cuad.py`), apply
  the count floor, document-level stratified split, write the three `.jsonl` splits +
  `label_map.json` (sorted, stable index↔label).
- **`metrics.py`** — **pure** macro-F1 / accuracy / per-class F1 from `(y_true, y_pred)` +
  label set. No model, fully unit-testable.
- **`baseline.py`** — few-shot prompted-LLM classifier over the test split; tolerant parse of
  the model's answer to a label (unparseable → recorded as wrong); NIM rpm pacing via `LLM_RPM`;
  writes `clf_baseline.json` (predictions + macro-F1).
- **`train.py`** — LoRA training (HF `Trainer` + PEFT `LoraConfig`), seeded; early-stop on val
  macro-F1; saves adapter + label map under `models/cuad_clf/`.
- **`evaluate.py`** — load base + adapter, predict the test split, compute metrics via
  `metrics.py`, write `clf_lora.json`, and print the before/after table against
  `clf_baseline.json`.
- **`schemas/clf-example.schema.json`** + **`clf-report.schema.json`** — JSON Schema for a
  classification example and a report (typed-payloads convention).
- **Makefile**: `clf-extract` · `clf-baseline` · `clf-train` · `clf-eval`.

## New dependencies

`pipeline/pyproject.toml` gains an optional `[ml]` extra (kept out of the default install so
ingestion/parsing stay lightweight): `torch`, `transformers`, `peft`, `scikit-learn`, and an
OpenAI-compatible client (`openai`) for the baseline. The heavy ML stack installs only when
training (`pip install -e 'pipeline[ml]'`).

## Eval method & success criteria (the gate)

1. **`make clf-extract`** → the three document-disjoint splits + `label_map.json`.
2. **`make clf-baseline`** (`LLM_MODEL=meta/llama-3.3-70b-instruct LLM_RPM=36`) → prompted
   macro-F1 on test (`clf_baseline.json`).
3. **`make clf-train`** → LoRA adapter (seeded; early-stop on val macro-F1).
4. **`make clf-eval`** → tuned macro-F1 on test (`clf_lora.json`) + the before/after table.

**Gate = a reported before/after table** (macro-F1 headline, accuracy + per-class F1 secondary)
on the **same** test split, with the **document-level split verified** (no `doc_id` in two
splits). **Decision rule (pre-stated):** adopt the LoRA classifier iff **tuned macro-F1 ≥
prompted macro-F1 + 0.05**; otherwise Prompt wins and the adapter is not shipped. Either way the
verdict + table + rationale go to **`DECISIONS.md`** as the Prompt→Fine-tune decision the spec
requires.

## Testing

- **`test_clf_metrics.py`** (pure) — macro-F1 / accuracy / per-class F1 on toy confusion cases
  (perfect, all-wrong, class-imbalanced, single-class-missing).
- **`test_clf_extract.py`** — deterministic seeded split; **no `doc_id` appears in two splits**
  (the leakage guard, explicit); **every kept class appears in train and test** (closed-set eval
  is valid); count-floor respected; `label_map` sorted/stable; span text non-empty.
- **`test_clf_baseline_parse.py`** — the LLM answer→label parser maps valid answers, and an
  off-taxonomy/garbled answer falls back to a recorded "wrong" (no throw).
- **Training + the two scoring runs are heavy** (model download, train, LLM calls) → the
  **controller-run gate** (as with the P2 eval gates), producing the before/after table.

## Risks / open questions

- **Small-data fine-tune may not beat a strong prompt** — the measured-null path, explicitly
  allowed by the decision rule. A clean null is a legitimate Layer-2 result.
- **Class imbalance** after the floor → macro-F1 + document-stratified split + optional
  class-weighted loss in `train.py`.
- **Short spans** (*Parties*, *Document Name*) are hard to type from text alone → per-class F1
  surfaces this honestly.
- **Baseline fairness** — the prompt must be a real attempt (definitions + few-shot), or the
  comparison is rigged. Reviewed as part of the gate.
- **Mac compute** — PyTorch + PEFT on MPS/CPU; seed split + training for reproducibility. Heavy
  deps gated behind the `[ml]` extra so they don't burden the ingestion path.
- **Document-disjoint split shrinks effective data per class** (whole contracts move together) —
  accepted: leakage-free is worth the smaller, honest test set; the count floor protects the
  rarest kept classes.

## Results (P3) — TBD

(Filled after the gated run: the prompted-vs-LoRA before/after table — macro-F1, accuracy,
per-class F1 — the document-split verification, and the KEEP/REVERT (ship-adapter or Prompt-wins)
decision per the gate, mirrored into `DECISIONS.md`.)
