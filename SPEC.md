> Trimmed from PLAN.md. PLAN.md remains the canonical source; update both together.

# SPEC.md — Grounded Contract Clause Review Copilot ("sift")

## Project summary
The system is an agentic, citation-grounded contract review copilot for a single contract type. Given a contract, it extracts the key clauses and fields, flags non-standard and missing terms against a defined playbook, drafts playbook-compliant redlines, and takes structured actions (export a review memo, set key-date reminders, etc.). Every surfaced fact is grounded in and cited to a specific source span in the contract; when an answer is not supported by retrieved context, the system refuses rather than guessing. A human remains the decision-maker.

## Goals
- Build a narrow, deep contract-review system that extracts key clauses, flags non-standard and missing terms against a playbook, drafts redlines, and takes real actions.
- Ground every claim in a retrieved source span with a verifiable citation; refuse when context is insufficient.
- Minimize the false-negative rate (real risks the system misses) and the hallucination rate; treat false-negative rate as the top-line metric.
- Implement and quantify the full modern retrieval stack (structure-aware chunking, embeddings, hybrid search, reranking, agentic retrieval loop), measuring each improvement against public benchmarks.
- Fine-tune one component and prove or disprove its lift with a disciplined before/after evaluation.
- Keep a human in the loop and gate all destructive or external actions behind confirmation.

## Core engineering invariants
- Every factual claim cites the exact source span it came from.
- Model output reaches the UI only through typed, schema-validated payloads (Zod-validated before leaving the server).
- When an answer is not grounded in retrieved context, the system refuses ("insufficient context") rather than guessing.
- A human approves before any destructive or external action; the system escalates instead of guessing.
- Build and evaluate only on public contracts. No client data, no PII.

---

## 2. The three layers, with acceptance criteria

### Layer 1 — Agentic, measured RAG (RAG + vector DB + embeddings)
Build in this order; each step is gated by the retrieval eval:

1. **Naive baseline first, and measure it.** Single embedding model, fixed top-k, one-shot generation. Record the metrics; this baseline is the reference point for every later improvement.
2. **Structure-aware ingestion.** Parse each contract into a hierarchy (articles → sections → subsections, definitions, exhibits) and preserve relationships. Chunk along these boundaries, not blindly by token count.
3. **Hybrid retrieval.** Dense vectors + BM25 keyword + metadata filters, fused with Reciprocal Rank Fusion (RRF).
4. **Cross-encoder reranking** over the top 50–100 candidates.
5. **Embedding-model comparison.** Benchmark at least two embedders (a strong general model vs a legal-domain model such as `voyage-law-2` or `Legal-BERT`) on the retrieval eval.
6. **Make it agentic.** Query reformulation, a retrieve → evaluate-sufficiency → retrieve-again loop, and an explicit "insufficient context, will not answer" path.

**Acceptance criteria:** retrieval eval (recall@k, NDCG@10) reported for baseline vs final; answer-level groundedness measured; "insufficient context" correctly triggered on out-of-scope questions; vector backend swappable via config.

### Layer 2 — LoRA-tuned component, lift proven (training)
Fine-tune one small, behavior-bound component of the Layer 1 system. Choose from: clause classifier, cross-encoder reranker, or query rewriter.

**Method:** LoRA/QLoRA on a small base. Document the Prompt → RAG → Fine-tune decision explicitly; exhaust prompting and RAG first.

**Acceptance criteria:** a before/after table on the SAME eval, tuned component vs prompted baseline, with the metric that defines "better" stated in advance; the decision rationale recorded in `DECISIONS.md`.

### Layer 3 — Action-taking agent over MCP (agents)
Tools (3–5, with real side effects): `extract_fields`, `classify_clause`, `check_playbook`, `flag_risks`, `draft_redline`, `export_memo`, `set_date_reminders`. Wrap Layer 1 RAG as one tool. Expose the toolset via an MCP server. Confirmation required before any destructive or external action.

**Acceptance criteria:** agent evals reported — end-to-end task success rate, step-level/trajectory checks, and a written failure-mode taxonomy; destructive actions gated behind confirmation; MCP server documented with a sample client call.

---

## 3. The evaluation harness

**Datasets (all public):**

| Dataset | What it provides | Use |
|---|---|---|
| **CUAD** (510 SEC-EDGAR contracts, 13,101 expert labels, 41 clause types) | Gold clause-extraction + Yes/No labels | Extraction precision/recall/F1; classification; retrieval relevance |
| **ContractNLI** (NDA document-level NLI) | NDA hypotheses (entail/contradict/neutral) | NDA-specific reasoning + risk-flagging eval |
| **LEDGAR** (large clause-provision classification) | Many labeled provisions | Fine-tuning + eval for the clause classifier |
| **LegalBench-RAG** (6,858 expert query/span pairs) | Retrieval ground truth for legal RAG | The headline retrieval benchmark for Layer 1 |
| **LegalBench** (contract-analysis + issue-spotting tasks) | Reasoning task suite | Sanity-check reasoning/issue-spotting |
| **SEC EDGAR** (raw exhibits, Material Contracts, leases) | Unlimited real contracts | Demo corpus + lease expansion |

**Metrics (report all):**
- **Retrieval:** recall@k, NDCG@10 (use LegalBench-RAG ground truth).
- **Extraction/classification:** precision, recall, F1 / Span-F1 (use CUAD).
- **Groundedness / faithfulness:** every claim must be supported by a retrieved span; measure with an LLM-as-judge plus a citation-correctness check.
- **False-negative rate (top-line metric):** the percentage of real risks / required clauses the system misses.
- **Hallucination rate:** fabricated clauses, citations, or facts.
- **Refusal correctness:** does the system correctly say "insufficient context" instead of guessing?

**Eval set:** 50–100 graded items per contract type (a mix of clean, deviated, and missing-clause contracts), each with expected fields, expected flags, and gold source spans.

---

## 6. Phased roadmap (eval-gated)

| Phase | Sequence | Build | Eval gate / deliverable |
|---|---|---|---|
| **P0 — Foundation** | first | Repo, `CLAUDE.md`, `SPEC.md`, ingest CUAD + ContractNLI, structure-aware parser, pgvector setup | Corpus loaded; parser preserves hierarchy on 10 sample contracts; eval set v1 (50 items) authored |
| **P1 — Naive baseline** | then | Single-embedding top-k RAG, clause cards with source-span citations, SSE UI shell | Baseline recall@k / NDCG@10 + groundedness recorded; live URL deployed |
| **P2 — Retrieval upgrade** | then | Hybrid (BM25 + dense + RRF) + cross-encoder rerank + embedder comparison + agentic retrieve-evaluate loop + refusal path | Final vs baseline delta table (retrieval + groundedness + false-negative rate); P2 eval report |
| **P3 — Fine-tune a component** | then | Curate examples from logs; LoRA the clause classifier (or reranker); swap in | Before/after table vs prompted baseline; Prompt → RAG → Fine-tune decision in `DECISIONS.md`; P3 eval report |
| **P4 — Action agent + MCP** | then | Tools with real side effects; MCP server; HITL guardrails; redline + memo export | Agent evals (task success, trajectory, failure-mode taxonomy); MCP sample call; P4 eval report |
| **P5 — Expansion / polish** | optional | Add commercial-lease support (key-date extraction + reminders); optional user validation; optional public benchmark | Lease pipeline passing the eval; optional usage metric (review-time saved or % auto-handled) |

Sequencing is relative; advance when the gate passes, not on a fixed schedule.
