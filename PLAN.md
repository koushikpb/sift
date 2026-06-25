# Project Plan - Grounded Contract Clause Review Copilot

## What this document is
This is the complete build plan for the Grounded Contract Clause Review Copilot. It defines the project, its goals, the architecture, the three implementation layers, the evaluation harness, the data, and a phased, eval-gated roadmap. Read it in full before writing code, then begin at **Phase 0** (Section 6). Every phase is gated by its evaluation: a phase is not complete until its eval passes. Keep `SPEC.md`, `DECISIONS.md`, `DATA.md`, and the project memory/planning documents current as the build progresses.

## Project summary
The system is an agentic, citation-grounded contract review copilot for a single contract type. Given a contract, it extracts the key clauses and fields, flags non-standard and missing terms against a defined playbook, drafts playbook-compliant redlines, and takes structured actions (export a review memo, set key-date reminders, etc.). Every surfaced fact is grounded in and cited to a specific source span in the contract; when an answer is not supported by retrieved context, the system refuses rather than guessing. A human remains the decision-maker.

## Goals
- Build a narrow, deep contract-review system that extracts key clauses, flags non-standard and missing terms against a playbook, drafts redlines, and takes real actions.
- Ground every claim in a retrieved source span with a verifiable citation; refuse when context is insufficient.
- Minimize the false-negative rate (real risks the system misses) and the hallucination rate; treat false-negative rate as the top-line metric.
- Implement and quantify the full modern retrieval stack (structure-aware chunking, embeddings, hybrid search, reranking, agentic retrieval loop), measuring each improvement against public benchmarks.
- Fine-tune one component and prove or disprove its lift with a disciplined before/after evaluation.
- Keep a human in the loop and gate all destructive or external actions behind confirmation.

## High-level deliverables
1. A deployed web application implementing the three layers, with a UI that shows clause cards, source-span citations, a risk table, a redline view, and explicit "insufficient context" refusals.
2. **Layer 1** - an agentic, measured RAG retrieval pipeline (structure-aware ingestion, hybrid BM25 + dense + RRF, cross-encoder reranking, agentic retrieve-evaluate loop) over a structured contract corpus, with a swappable vector backend.
3. **Layer 2** - one LoRA-fine-tuned component with a documented before/after evaluation versus a prompted baseline.
4. **Layer 3** - an action-taking agent exposed through an MCP server, with human-in-the-loop guardrails.
5. **Evaluation harness** - a first-class `evals/` suite and results report covering retrieval, extraction, groundedness, hallucination, refusal correctness, and false-negative rate, benchmarked on public datasets.
6. **Project documentation** - `SPEC.md`, `DECISIONS.md`, `DATA.md`, and per-phase eval reports under `docs/`.
7. *(Optional)* Commercial-lease expansion and a published mini-benchmark for the chosen contract type.

## Core thesis
The system's identity is measured grounding. Generic "chat with your contract" retrieval is not the target: the system extracts specific fields, flags specific deviations against a playbook, drafts redlines, takes actions, and is rigorously evaluated. Rigor is central because even purpose-built commercial legal AI tools have been shown to hallucinate 17-33% of the time; the system is designed and measured to drive missed risks and fabrications down, with every claim tied to a citable source span.

## Core engineering invariants (apply to all layers)
- Every factual claim cites the exact source span it came from.
- Model output reaches the UI only through typed, schema-validated payloads (Zod-validated before leaving the server).
- When an answer is not grounded in retrieved context, the system refuses ("insufficient context") rather than guessing.
- A human approves before any destructive or external action; the system escalates instead of guessing.
- Build and evaluate only on public contracts. No client data, no PII.

---

## 0. Scope and positioning

**Wedge (build this first):** NDA review. Highest volume, most standardized, and the fastest path to a defensible auto-handled rate, with NDA-specific public data available (ContractNLI).
**Expansion (Phase 5):** Commercial lease review - key-date extraction (commencement, expiration, renewal, notice), rent escalation, and assignment/repair/indemnity flagging across a portfolio. CUAD includes leasing among its 25 contract types, so the same pipeline extends.

**Target user:** A solo practitioner, small firm, or freelancer who reviews many NDAs (or leases) and needs a fast, consistent, auditable first pass, with a human as the decision-maker.

**Non-goals:**
- Not legal advice. The system accelerates review; a human makes every call. Human-in-the-loop is a core feature.
- Not a broad, multi-contract enterprise platform. This is a focused, narrow build on one contract type.
- Not a retrieval-and-chat wrapper over a PDF. The system extracts structured fields, flags deviations, drafts redlines, takes actions, and is evaluated against benchmarks.
- No client or PII data. Build and evaluate entirely on public, SEC EDGAR-sourced contract corpora.

---

## 1. Architecture

```
Contracts (public)                 Build-time + ingest
  CUAD / ContractNLI / EDGAR  -->  parse + structure-map (articles, sections,
                                   defs, exhibits; preserve hierarchy) -->
                                   chunk + embed --> vector store (pgvector)
                                                              |
  Playbook (standard positions, fallbacks, red-flags)         |
                                                              v
                          LAYER 1: Agentic, measured RAG retrieval
                          (hybrid BM25 + dense + RRF --> cross-encoder rerank
                           --> retrieve-evaluate-iterate loop)
                                                              |
                          LAYER 2: LoRA-tuned component (clause classifier
                           OR reranker OR query-rewriter) swapped in, lift proven
                                                              |
                          LAYER 3: Action agent (Claude Agent SDK loop)
                           tools: extract_fields, classify_clause, check_playbook,
                           flag_risks, draft_redline, export_memo, set_date_reminders
                           exposed via an MCP server
                                                              v
                          Typed/validated outputs --> SSE --> Next.js UI
                          (clause cards w/ source-span citations, risk table,
                           redline view, "insufficient context" refusals)

                 EVAL HARNESS runs across all layers (the spine)
```

**Stack:** TypeScript + Next.js (App Router) + Claude Agent SDK + SSE for the application; Python for fine-tuning and any encoder models (Hugging Face ecosystem). `pgvector` is the default vector store behind a swappable interface; add a second backend (Qdrant) selectable by config. Zod schemas validate every tool payload before it leaves the server.

---

## 2. The three layers, with acceptance criteria

### Layer 1 - Agentic, measured RAG (RAG + vector DB + embeddings)
Build in this order; each step is gated by the retrieval eval:

1. **Naive baseline first, and measure it.** Single embedding model, fixed top-k, one-shot generation. Record the metrics; this baseline is the reference point for every later improvement.
2. **Structure-aware ingestion.** Parse each contract into a hierarchy (articles -> sections -> subsections, definitions, exhibits) and preserve relationships (e.g., an indemnification exception in 8.2(c) modifies the obligation in 8.1). Chunk along these boundaries, not blindly by token count.
3. **Hybrid retrieval.** Dense vectors + BM25 keyword + metadata filters, fused with Reciprocal Rank Fusion (RRF). BM25 catches the rare tokens dense retrieval misses (defined terms, section references, dollar figures).
4. **Cross-encoder reranking** over the top 50-100 candidates. State the hypothesis up front (reranking lifts NDCG@10 over either signal alone) and confirm it with the measured number.
5. **Embedding-model comparison.** Benchmark at least two embedders (a strong general model vs a legal-domain model such as `voyage-law-2` or `Legal-BERT`) on the retrieval eval. Embedding choice materially affects legal retrieval quality, so treat this as a measured experiment.
6. **Make it agentic.** Query reformulation, a retrieve -> evaluate-sufficiency -> retrieve-again loop, and an explicit "insufficient context, will not answer" path.

**Acceptance criteria:** retrieval eval (recall@k, NDCG@10) reported for baseline vs final; answer-level groundedness measured; "insufficient context" correctly triggered on out-of-scope questions; vector backend swappable via config.

### Layer 2 - LoRA-tuned component, lift proven (training)
Fine-tune one small, behavior-bound component of the Layer 1 system. Choose from:
- **Clause classifier** (label a span by clause type) - train on LEDGAR (provision classification) and/or CUAD; encoder models (Legal-BERT, CaseLawBERT) are well-suited and small.
- **Cross-encoder reranker** - fine-tune on (query, candidate) relevance pairs from the eval set.
- **Query rewriter** - (raw question -> ideal retrieval query) pairs harvested from system logs.

**Method:** LoRA/QLoRA on a small base (an encoder for classification; a small Llama/Mistral for generative components). Inexpensive - single-digit to low-double-digit dollars of GPU time. Reference pattern: the "Text to Trust" study compares full fine-tuning vs LoRA vs zero-shot prompting on clause-level detection; replicate that comparison shape on the chosen task.

**The decision is the point.** Document the Prompt -> RAG -> Fine-tune decision explicitly: exhaust prompting and RAG first, and only fine-tune where it earns its place. If the tuned component does not beat the prompted baseline, record that as the result. The disciplined before/after evaluation is the deliverable, not a successful training run.

**Acceptance criteria:** a before/after table on the SAME eval, tuned component vs prompted baseline, with the metric that defines "better" stated in advance; the decision rationale recorded in `DECISIONS.md`.

### Layer 3 - Action-taking agent over MCP (agents)
This layer takes real actions, not just retrieval and chat:
- **Tools (3-5, with real side effects):** `extract_fields` (structured term sheet), `classify_clause`, `check_playbook` (compare a clause to the standard position + fallback), `flag_risks` (severity + missing-clause detection + internal-inconsistency checks, e.g. net-30 in one section vs net-45 in another), `draft_redline` (playbook-compliant alternative language), `export_memo` (structured review memo with citations), and for leases `set_date_reminders` (write key dates to a calendar/system - a genuine side effect).
- **Wrap Layer 1 RAG as one tool** among the others.
- **Expose the toolset via an MCP server** so any MCP client (including the implementing agent itself, to dogfood it) can drive it. MCP is the standard protocol for exposing tools to agents.
- **Guardrails / human-in-the-loop:** confirmation before any destructive or external action; every flag links to its source span; the agent escalates instead of guessing.

**Acceptance criteria:** agent evals reported - end-to-end task success rate, step-level/trajectory checks, and a written failure-mode taxonomy; destructive actions gated behind confirmation; MCP server documented with a sample client call.

---

## 3. The evaluation harness (the spine)

Evaluation is a first-class artifact: an `evals/` directory plus a results report. Build the eval set before optimizing anything.

**Datasets (all public):**
| Dataset | What it provides | Use |
|---|---|---|
| **CUAD** (510 SEC-EDGAR contracts, 13,101 expert labels, 41 clause types, incl. leasing) | Gold clause-extraction + Yes/No labels (e.g. "uncapped liability") | Extraction precision/recall/F1; classification; retrieval relevance |
| **ContractNLI** (NDA document-level NLI) | NDA hypotheses (entail/contradict/neutral) | NDA-specific reasoning + risk-flagging eval |
| **LEDGAR** (large clause-provision classification) | Many labeled provisions | Fine-tuning + eval for the clause classifier |
| **LegalBench-RAG** (6,858 expert query/span pairs over NDAs, M&A, commercial contracts, privacy policies) | Retrieval ground truth for legal RAG | The headline retrieval benchmark for Layer 1 |
| **LegalBench** (contract-analysis + issue-spotting tasks) | Reasoning task suite | Sanity-check reasoning/issue-spotting |
| **SEC EDGAR** (raw exhibits, Material Contracts, leases) | Unlimited real contracts | Demo corpus + lease expansion |

**Metrics (report all):**
- **Retrieval:** recall@k, NDCG@10 (use LegalBench-RAG ground truth).
- **Extraction/classification:** precision, recall, F1 / Span-F1 (use CUAD).
- **Groundedness / faithfulness:** every claim must be supported by a retrieved span; measure with an LLM-as-judge plus a citation-correctness check (does the cited span actually support the claim?). An unverifiable "correct" answer can never be proven true, so groundedness is as important as correctness.
- **False-negative rate (top-line metric):** the percentage of real risks / required clauses the system misses. A missed risk is the dangerous failure in contract review. Make this the headline number and optimize the pipeline to drive it down (recall-biased retrieval, explicit missing-clause checks).
- **Hallucination rate:** fabricated clauses, citations, or facts. Report it alongside the published 17-33% figures for commercial legal tools as context.
- **Refusal correctness:** does the system correctly say "insufficient context" instead of guessing?

**Eval set:** 50-100 graded items per contract type (a mix of clean, deviated, and missing-clause contracts), each with expected fields, expected flags, and gold source spans. This is the verification target the entire build runs against.

---

## 4. Data and safety plan

- Use only public contracts (CUAD, ContractNLI, LEDGAR, LegalBench-RAG, and SEC EDGAR exhibits). No client data, no PII.
- Check and record each dataset's license in `DATA.md` (CUAD is openly available for research; credit The Atticus Project), noting source, license, and how each set is used.
- Author a small **playbook** (standard positions, fallback language, red-flag terms) for the chosen contract type - this defines the standard the system compares against. For NDAs: mutual vs one-sided confidentiality, acceptable confidentiality period (e.g. flag perpetual vs 3-5 years), definition scope, exclusions, return-of-materials, jurisdiction, remedies.
- **Optional deliverable:** publish a small, reproducible retrieval/extraction benchmark for the chosen contract type (LegalBench-RAG-style); public benchmarks for narrow contract types are scarce.

---

## 5. Execution workflow (for the implementing agent)

The build is executed agentically. The key to reliable agentic execution is a verifiable target, which is exactly what the eval harness provides.

**Repo bootstrapping:**
- Create `CLAUDE.md` at the repo root with the stack, conventions (TypeScript, Zod-validated payloads, citation format), the eval commands (`npm run eval` and the Python eval scripts), and the non-goals. The implementing agent reads this automatically to stay on-spec.
- Create `SPEC.md` (a trimmed version of this plan) and `DECISIONS.md` (kept current as architectural calls are made - why pgvector, why hybrid + rerank, the RAG-vs-fine-tune decision).

**Per-task loop:** research -> plan -> implement -> verify.
- Use plan mode for any non-trivial task; review the plan before implementing.
- Decompose each phase into small, independently verifiable units of work. Keep diffs small and focused.
- **Evals are the gate.** No task is complete until its test or eval passes; iterate against the eval suite until it does. Optimize against the metric, not against impressions.
- Use subagents for parallel work (e.g., one builds the retrieval module while another scaffolds the eval set) and for an independent review pass before merge.
- Connect the agent to GitHub via MCP (issues/PRs); once Layer 3 exists, point the agent at the project's own MCP server to dogfood it.
- **Guardrails:** never commit secrets; tests and typecheck stay green; the eval score is the merge gate.
- **Documentation:** after each phase, record results in an eval report under `docs/` (metrics, deltas vs the prior phase, and decisions made).

---

## 6. Phased roadmap (eval-gated)

| Phase | Sequence | Build | Eval gate / deliverable |
|---|---|---|---|
| **P0 - Foundation** | first | Repo, `CLAUDE.md`, `SPEC.md`, ingest CUAD + ContractNLI, structure-aware parser, pgvector setup | Corpus loaded; parser preserves hierarchy on 10 sample contracts; eval set v1 (50 items) authored |
| **P1 - Naive baseline** | then | Single-embedding top-k RAG, clause cards with source-span citations, SSE UI shell | Baseline recall@k / NDCG@10 + groundedness recorded; live URL deployed |
| **P2 - Retrieval upgrade** | then | Hybrid (BM25 + dense + RRF) + cross-encoder rerank + embedder comparison + agentic retrieve-evaluate loop + refusal path | Final vs baseline delta table (retrieval + groundedness + false-negative rate); P2 eval report |
| **P3 - Fine-tune a component** | then | Curate examples from logs; LoRA the clause classifier (or reranker); swap in | Before/after table vs prompted baseline; Prompt -> RAG -> Fine-tune decision in `DECISIONS.md`; P3 eval report |
| **P4 - Action agent + MCP** | then | Tools with real side effects; MCP server; HITL guardrails; redline + memo export | Agent evals (task success, trajectory, failure-mode taxonomy); MCP sample call; P4 eval report |
| **P5 - Expansion / polish** | optional | Add commercial-lease support (key-date extraction + reminders); optional user validation; optional public benchmark | Lease pipeline passing the eval; optional usage metric (review-time saved or % auto-handled) |

Sequencing is relative; advance when the gate passes, not on a fixed schedule.

---

## 7. Definition of done (quality bar)

- [ ] Evaluation harness present and reported: an `evals/` suite plus before/after delta tables across phases.
- [ ] False-negative rate and groundedness measured and reported; hallucination rate reported alongside the 17-33% reference figures.
- [ ] Benchmarked on the public expert datasets (CUAD / ContractNLI / LegalBench-RAG), not on ad-hoc samples.
- [ ] Extracts the specific fields and flags the specific deviations relevant to the contract type, links each to its source span, and drafts redlines.
- [ ] Fine-tuning decision documented with the supporting numbers, including a negative result if that is the outcome.
- [ ] Action layer and MCP server working, with human-in-the-loop confirmation on destructive actions.
- [ ] Every surfaced claim carries a citation; ungrounded questions trigger refusal.
- [ ] Deployed with a live URL and a README (one-line description, architecture diagram, headline metrics).
- [ ] `SPEC.md`, `DECISIONS.md`, `DATA.md`, and per-phase eval reports are current.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Scope creep (too many contract types) | One wedge (NDAs) to a working, evaluated state before any expansion |
| Drifts into a retrieval-and-chat wrapper | The action layer, MCP, and eval rigor are the point; enforce via the acceptance criteria |
| User validation unavailable | Public data is sufficient to build and evaluate the full system; user validation is optional (P5) |
| Fine-tune shows no lift | Record the negative result and the decision; the evaluation is the deliverable, not a successful training run |
| Legal-accuracy liability | Human-in-the-loop, "not legal advice," public data only, refuse-when-ungrounded |

---

## 9. References (datasets, benchmarks, studies)

- CUAD - The Atticus Project: https://www.atticusprojectai.org/cuad (HF: theatticusproject/cuad-qa; paper arXiv:2103.06268)
- ContractNLI (NDA NLI): https://stanfordnlp.github.io/contract-nli/
- LEDGAR (clause classification) - part of LexGLUE: https://huggingface.co/datasets/lex_glue
- LegalBench-RAG (legal RAG retrieval benchmark): arXiv:2408.10343
- LegalBench (legal reasoning benchmark): https://hazyresearch.stanford.edu/legalbench/
- Stanford RegLab, "Hallucination-Free? Assessing the Reliability of Leading AI Legal Research Tools" (legal tools hallucinate 17-33%): arXiv:2405.20362
- Legal embedding models: voyage-law-2 (Voyage AI), Legal-BERT (nlpaueb/legal-bert-base-uncased); MLEB - Massive Legal Embedding Benchmark
- awesome-legaltech (datasets, models, legal MCP servers): github.com/Vaquill-AI/awesome-legaltech

*Build narrow. Measure everything. Drive the false-negative rate down.*
