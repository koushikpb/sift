# P2c — Agentic retrieve→evaluate loop (design)

- **Date:** 2026-06-29
- **Status:** Approved (brainstorming) → ready for implementation plan
- **Phase:** P2 "Retrieval upgrade", third and final slice (P2c). Completes SPEC
  Layer 1 step 6 ("Make it agentic"). The next phase is P3 (LoRA fine-tune).
- **Branch:** `phase-2c-agentic-retrieve-loop` (off `main`, which now carries P2a + P2b).

## Context

P2a (hybrid + cross-encoder rerank) lifted recall@8 0.748 → 0.784 and NDCG@8 0.559 →
0.632 at groundedness 1.0; P2b measured a null (a stronger *general* embedder, `mxbai`,
did not beat `bge-large`), so the remaining free recall lever is **the agentic loop**, not
a better embedder. The P2a analysis showed the refusals that remain track retrieval misses:
on the 37 answerable items, refused items had mean recall@8 ≈ 0.30 (the gold span was never
retrieved), answered items ≈ 0.91. A one-shot retrieve cannot recover from a bad first query.

This slice implements SPEC Layer 1 step 6: **query reformulation + a retrieve →
evaluate-sufficiency → retrieve-again loop + the explicit "insufficient context" path.**
The goal is to rescue one-shot misses — convert "the first query missed the gold span" into
"a reformulated query found it" — lifting recall and lowering the false-negative rate while
holding groundedness at ~1.0 and **preserving correct refusal on out-of-scope questions**.

### Current state (the seams P2c plugs into)
- `makeRetriever(mode)` dispatches on `RETRIEVE_MODE` (`naive` | `hybrid`), returning a
  `RetrieveFn = (query, docId, k?) => Promise<Candidate[]>`. Both call sites — the eval CLI
  (`core/src/eval/cli.ts`) and the SSE route (`app/app/api/answer/route.ts`) — go through it.
- The eval runner (`core/src/eval/runEval.ts`) computes recall/NDCG on whatever `Candidate[]`
  `retrieve()` returns, **then** calls `generate` once. So a retriever that internally loops
  and returns the final accumulated top-k is measured by the existing metrics for free.
- P2a primitives already exist and are reused as-is: `core/src/retrieve/dense.ts`
  (`denseRetrieve`), `core/src/retrieve/lexical.ts` (`lexicalRetrieve`), `core/src/retrieve/rrf.ts`
  (pure `rrfFuse`), `core/src/rerank/model.ts` (`rerank`). `hybrid.ts` composes these for the
  single-query case; the loop composes the same four for the multi-query/looping case.
- The generator (`core/src/generate/`) already owns a tested refusal path; groundedness is 1.0.
- The OpenAI-compat client carries a **per-generator-instance** throttle (`nextAllowedAt`
  closure in `openaiCompat.ts`) derived from `LLM_RPM` / `LLM_MIN_INTERVAL_MS`. Agentic mode
  adds LLM calls, so the judge MUST share one rpm budget with the generator (see Components).

## Goal & non-goals

**Goal:** add an `agentic` retrieval mode — an injected-deps loop that retrieves, asks an LLM
sufficiency judge whether the pool can answer the objective, and on "insufficient" runs one
reformulated multi-query round (RRF-fused, reranked) before returning the final top-k —
measured against the P2a hybrid report on the same eval set, with groundedness held and
refusal on the `missing` category preserved.

**Non-goals (later / out of scope):** more than 2 rounds (the cap is a tunable constant, but
this slice ships 2); the paid `voyage-law-2` legal embedder (P2b's deferred "maybe later");
a LoRA query-rewriter (P3 — this slice's prompt-based reformulator is the baseline that
justifies or rules out tuning one); a `refining` SSE status event between rounds; surfacing
the judge's verdict in the `ClauseCard`; HyDE / cross-document retrieval; any schema change.

## Decisions (with rationale)

1. **Dedicated LLM sufficiency judge** (not generator-refusal reuse, not a heuristic). A
   separate call evaluates "do these candidates contain enough to answer the objective?" →
   `sufficient` + (if not) reformulations. Matches the spec's "evaluate-sufficiency" wording,
   cleanly separates *retrieval sufficiency* from *answer refusal*, and is unit-testable in
   isolation. Cost: +1 judge call per item, +1 more when a retry fires.
2. **Multi-query expansion** for reformulation (not single-rewrite, not HyDE). The judge emits
   1–3 targeted reformulations (synonyms, legal-term variants, sub-aspects); each is retrieved
   via `dense` + `lexical`, and all round-1 and round-2 ranked lists are **RRF-fused once** into
   one pool, then reranked against the original objective. Biggest recall lift per round and
   reuses P2a's RRF + cross-encoder exactly; the extra queries are cheap local retrievals — only
   the single merged pool hits the reranker.
3. **Max 2 rounds** (1 initial + 1 retry), as a named constant `AGENT_MAX_ROUNDS` (default 2).
   Cheapest first cut, fastest eval; the measured delta tells us whether more rounds earn their
   cost — same incremental-evidence discipline as P2a/P2b. Bumping the cap is a config change.
4. **The retriever boundary owns the loop; the generator still owns refusal.** The loop lives
   inside a `RetrieveFn` (new `RETRIEVE_MODE=agentic`) and returns the same `Candidate[]`, so
   the eval runner, metrics, and SSE route are untouched. The judge's verdict drives retries
   and is *logged* as the explicit sufficiency signal; when the loop exhausts rounds still
   "insufficient," it returns the best pool and the generator refuses as it correctly does
   today (groundedness 1.0). This honors the spec's "insufficient-context path" without
   risking the judge over-refusing answerable items.
5. **One shared rpm throttle across all LLM calls.** The generator's inline slot reservation
   moves to a shared `core/src/llm/throttle.ts`; the judge calls the same `reserveSlot`. Module
   state = one rpm budget, so agentic mode cannot re-trigger the 429s P1 hit.

## Data flow

`agenticRetrieve(query, docId, k)` — doc-scoped, returns `Candidate[]` (unchanged shape). It
composes the same four primitives `hybridRetrieve` is built from (`dense`, `lexical`, `rrfFuse`,
`rerank`), generalized from one query to N and wrapped in the judge loop — so `hybridRetrieve`
stays the single-query sibling and there is no double-rerank:

```
round 1: d₁,x₁  ← dense(query, docId, N), lexical(query, docId, N)    (N = N_DENSE = N_LEX = 50)
         lists  ← [d₁, x₁]                                            (raw ranked lists, kept)
         top    ← rerank(query, rrfFuse(lists, {k:60}).slice(0, M), k)   (M = 100)
         verdict ← judge(objective, top)
         if verdict.sufficient OR no rounds left:  return top

round 2: queries ← verdict.reformulations             (1–3; empty ⇒ return round-1 `top`)
         for q in queries:                            (each adds two raw lists)
             lists ← lists ++ [dense(q, docId, N), lexical(q, docId, N)]
         fused  ← rrfFuse(lists, {k:60}).slice(0, M)   (one fusion over ALL round-1+2 lists)
         if fused introduced no node_id beyond round-1:  return round-1 `top`   (convergence)
         return rerank(query, fused, k)               (single final rerank vs the ORIGINAL query)
```

RRF fuses the **raw dense/lexical ranked lists** (two per query), deduping by `node_id` on rank
position — so a weak reformulation only *adds* lists, never displaces the original. The final
`rerank` scores the fused pool against the **original objective** (not the reformulations), so
ranking quality targets the real question. The judge sees the **reranked top-k** (what the
generator would actually see), so its sufficiency call reflects the real answer context.
`rerank(query, candidates, k)`, `rrfFuse(lists, {k})`, `dense`, and `lexical` are P2a's existing
functions with their existing signatures.

## Components (each isolated, one responsibility, testable alone)

- **`core/src/llm/throttle.ts`** (new) — shared module-level slot reservation:
  `reserveSlot(minIntervalMs: number): Promise<void>` with a module-scoped `nextAllowedAt`,
  plus the existing `resolveMinIntervalMs(env)` moved here (re-exported from `openaiCompat.ts`
  for back-compat). The generator's inline throttle (`openaiCompat.ts` lines ~51–61) is
  replaced by `await reserveSlot(minIntervalMs)`. This is the only change to existing
  generator behavior, and it's byte-for-byte equivalent for the generator-only path.
- **`core/src/agent/judge.ts`** (new) — `judgeSufficiency(objective, candidates, deps?):
  Promise<{ sufficient: boolean; reformulations: string[] }>`. A pinned sufficiency prompt;
  tolerant JSON parse reusing `extractJsonObject` from `generate/prompt.ts`. Injectable
  `ChatClient` (the existing minimal interface from `openaiCompat.ts`) and model for tests;
  calls `reserveSlot` so it shares the rpm budget. Reformulations capped at 3; deduped/trimmed.
- **`core/src/agent/loop.ts`** (new) — `agenticRetrieve(query, docId, k, deps): Promise<Candidate[]>`.
  Orchestrates the rounds with **injected** deps `{ dense, lexical, rerank, rrfFuse, judge }`
  (the four P2a retrieval primitives + the judge) so the compose/fuse/cap logic is unit-testable
  with fakes — no DB, no LLM. Holds `AGENT_MAX_ROUNDS` (2), `N` (50), `M` (100), `K_RRF` (60) as
  named constants (mirroring `HYBRID_DEFAULTS`). Emits per-item observability to stderr (round
  count, whether a retry fired).
- **`core/src/retrieve/retrieve.ts`** (modify) — `makeRetriever` gains an `agentic` branch
  wiring the real deps: `agenticRetrieve(q, d, k, { dense: denseRetrieve, lexical:
  lexicalRetrieve, rerank, rrfFuse, judge: judgeSufficiency })`. `naive` and `hybrid` unchanged.
- **`core/src/eval/cli.ts`** (modify) — stamp `agent_max_rounds` into provenance when mode is
  `agentic`; extend `outName` so `agentic → p2c.json` (naive → baseline.json, hybrid → p2a.json
  preserved); the `EVAL_OUT` override still wins.

No schema migration. No new model download — the judge reuses the configured LLM provider/model
(`LLM_PROVIDER` / `LLM_MODEL`, NIM `meta/llama-3.3-70b-instruct` for the measured run).

## Error handling (degrade, never crash)

- **Judge load/call failure or unparseable JSON → treat as `sufficient`** (stop looping),
  fall back to the round-1 reranked top-k, log to stderr. A broken judge cannot take down
  retrieval — same philosophy as P2a's reranker fallback.
- **Reformulation round adds no new candidates → stop early** and return the round-1 top-k
  (convergence guard inside the 2-round cap).
- **Empty `reformulations` from the judge → no second retrieve**; return round-1 top-k.
- `runEval`'s per-item try/catch still isolates any single-item failure; the run continues.

## Eval method & success criteria (the gate)

1. **Run agentic:** `RETRIEVE_MODE=agentic EVAL_OUT=p2c.json LLM_MODEL=meta/llama-3.3-70b-instruct
   LLM_RPM=36 npm run eval -- run` (same `eval-set-v1`, 50 items, k=8).
2. **Compare vs the current best:** `npm run eval -- compare p2a.json p2c.json` → delta table
   (recall@8, NDCG@8, groundedness, refusal_rate, false_negative_rate). The comparison is
   against **`p2a.json`** (hybrid+rerank), not the naive baseline — the question is whether the
   loop beats one-shot hybrid.
3. **Observability (stderr, not stored):** per-item round count + a `rescued` tally (items whose
   recall went 0 → >0 because of round 2). "The loop fired on N items, rescued M" is the P2c
   story; the report stays schema-compatible.

**Gate = PASS when** recall@8 and/or false_negative_rate improve over p2a, **groundedness holds
~1.0**, AND — the make-or-break guardrail — **the `missing` category still refuses correctly**
(the loop must rescue genuine misses without manufacturing context for out-of-scope questions; a
recall lift bought by breaking refusal on `missing` is a FAIL). A flat result is a valid measured
finding (as in P2b): recorded, and it tells us prompt-based reformulation isn't the lever —
pointing at P3's LoRA query-rewriter or the deferred paid legal embedder.

## Cost & runtime

+1 judge call per item always; +1 reformulation round (local, cheap retrievals) +1 judge call
when a retry fires. ~100–150 LLM calls over 50 items under the shared 40-rpm throttle ≈ a few
minutes. Acceptable, and `LLM_RPM` paces it under the NIM free cap.

## Testing

- **`throttle.test.ts`** (pure, no infra) — `reserveSlot` spaces successive calls by
  `minIntervalMs`; two callers (generator + judge) sharing the module share one budget;
  `minIntervalMs = 0` ⇒ no wait (existing behavior preserved). `resolveMinIntervalMs` cases move
  with it.
- **`judge.test.ts`** (injected fake `ChatClient`, no network) — parses `sufficient: true/false`
  + reformulations; caps reformulations at 3; malformed/non-JSON output → safe `sufficient`
  fallback with empty reformulations.
- **`loop.test.ts`** (injected fakes, no DB/LLM) — sufficient round-1 ⇒ no second retrieve,
  returns reranked top-k; insufficient ⇒ reformulations retrieved, RRF-fused, reranked, capped
  to k; no-new-candidates ⇒ early stop; judge-throws ⇒ round-1 pool (degrade); empty
  reformulations ⇒ round-1 pool.
- **Eval delta table is the merge gate** — the p2a→p2c comparison plus the explicit
  `missing`-category refusal check.

## Risks / open questions

- **Over-refusal vs over-reach.** The judge could be too eager (kills recall by stopping never)
  or too lax (never satisfied). The sufficiency prompt is pinned and tested both directions; the
  2-round cap bounds the lax case; the generator-owns-refusal decision bounds the eager case.
- **Judge model = generator model** (`meta/llama-3.3-70b-instruct`). Fine for a first cut; the
  injectable client/model lets a stronger judge swap in later with no code change.
- **Reformulation quality on legal text.** Defined terms and section references may reformulate
  oddly; the multi-query + RRF design is robust to a weak reformulation (it only *adds* a ranked
  list, never replaces the original). If reformulation is the bottleneck, that is exactly the
  signal that justifies P3's LoRA query-rewriter.
- **Throttle extraction regression.** Moving the generator's throttle to a shared module must
  stay byte-for-byte for the generator-only path; `throttle.test.ts` plus the existing generator
  tests guard this.

## Results (P2c) — TBD

(Filled in after the gated eval run: the p2a→p2c delta table, the rescued-items tally, the
`missing`-category refusal check, and the KEEP/REVERT decision per the gate above.)
