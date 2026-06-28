# P2a — Hybrid Retrieval + Cross-Encoder Rerank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hybrid retrieval (dense + Postgres FTS, fused with RRF) and a local cross-encoder reranker behind the existing `retrieve()` boundary, measured against the P1 baseline on the same eval set.

**Architecture:** A 4-stage doc-scoped pipeline — dense (pgvector cosine) + lexical (Postgres full-text) run in parallel, fuse via Reciprocal Rank Fusion, cap at M, then a local cross-encoder reranks to top-k. The returned `Candidate[]` shape is unchanged, so generation, clause cards, and the SSE layer are untouched. A `makeRetriever(mode)` factory keeps `RETRIEVE_MODE=naive` byte-for-byte identical to the P1 baseline for an honest delta.

**Tech Stack:** TypeScript/Node 20 (ESM, NodeNext), Postgres 16 + pgvector + GIN full-text, `@huggingface/transformers` (onnxruntime) for the cross-encoder, vitest.

## Global Constraints

- ESM relative imports use explicit `.js` extensions (NodeNext).
- **Candidate shape is unchanged** — `{ node_id, doc_id, type, number, heading, text, char_start, char_end, score }`. Generation and the UI depend on it. Pipeline stages reorder candidates and overwrite only `score`; they MUST preserve `char_start`/`char_end`/`text`/`quote`-relevant fields untouched (citation integrity: `quote === raw_text.slice(char_start, char_end)` is enforced downstream by `toClauseCard`, which is not modified).
- `RETRIEVE_MODE` default is `naive` — the P1 baseline (`evals/reports/baseline.json`) must stay reproducible.
- All DB access goes through `core/src/db/` (`withClient`). Vector backend stays swappable.
- Metrics/fusion are **pure** functions. Tests must produce pristine output (no stray logs).
- **Evals are the merge gate** (CLAUDE.md). The P2a delta table vs baseline is the deliverable; groundedness must hold at ~1.0 (no new hallucination).
- DB-backed tests require `make db-up` + `npm run migrate` (incl. the new `0005` migration). Model tests download ONNX weights on first run (use a 120s timeout) and should be run in isolation — the onnxruntime teardown crash (`mutex lock failed`) on process exit truncates a full-suite run but fails no test.
- Run all commands from `core/` unless stated. Focused test: `npx vitest run test/<file>`.

## File Structure

| File | Responsibility |
|---|---|
| `core/src/retrieve/types.ts` (new) | The `Candidate` interface (moved out of `retrieve.ts`). |
| `core/src/retrieve/dense.ts` (new) | `denseRetrieve` — pgvector cosine top-n (extracted from today's `retrieve`). |
| `core/src/retrieve/lexical.ts` (new) | `lexicalRetrieve` — Postgres FTS top-n. |
| `core/src/retrieve/rrf.ts` (new) | `rrfFuse` — pure Reciprocal Rank Fusion. |
| `core/src/rerank/model.ts` (new) | `rerank` / `rerankScores` — local cross-encoder. |
| `core/src/retrieve/hybrid.ts` (new) | `hybridRetrieve` — orchestrator with injectable deps. |
| `core/src/retrieve/retrieve.ts` (modify) | `makeRetriever(mode)` factory + back-compat `retrieve`; re-exports `Candidate`. |
| `core/src/eval/compare.ts` (new) | `compareReports` / `falseNegativeRate` / `formatDelta` — pure delta table. |
| `core/src/eval/cli.ts` (modify) | Wire `RETRIEVE_MODE`, stamp provenance, mode-based report path, `compare` subcommand. |
| `core/migrations/0005_clauses_fts.sql` (new) | Generated STORED `tsvector` + GIN index. |
| `app/app/api/answer/route.ts` (modify) | Use `makeRetriever(process.env.RETRIEVE_MODE)`. |

---

### Task 1: Extract `Candidate` type and dense retrieval into modules (refactor, no behavior change)

**Files:**
- Create: `core/src/retrieve/types.ts`
- Create: `core/src/retrieve/dense.ts`
- Modify: `core/src/retrieve/retrieve.ts`
- Test: existing `core/test/retrieve.test.ts` is the regression gate (DB-backed)

**Interfaces:**
- Produces: `interface Candidate { node_id: string; doc_id: string; type: string; number: string | null; heading: string | null; text: string; char_start: number; char_end: number; score: number }` (in `types.ts`, re-exported from `retrieve.ts`).
- Produces: `denseRetrieve(query: string, docId: string, n: number): Promise<Candidate[]>`.
- Consumes: `withClient` (`../db/client.js`), `toVectorLiteral` (`../db/vector.js`), `embedTexts` (`../embed/model.js`).

- [ ] **Step 1: Confirm the regression baseline is green** (DB must be up)

Run: `npx vitest run test/retrieve.test.ts`
Expected: PASS (2 tests). This is the behavior we must preserve.

- [ ] **Step 2: Create the `Candidate` type module**

Create `core/src/retrieve/types.ts`:
```ts
export interface Candidate {
  node_id: string;
  doc_id: string;
  type: string;
  number: string | null;
  heading: string | null;
  text: string;
  char_start: number;
  char_end: number;
  score: number;
}
```

- [ ] **Step 3: Create `dense.ts` with the extracted cosine query**

Create `core/src/retrieve/dense.ts`:
```ts
import { withClient } from "../db/client.js";
import { toVectorLiteral } from "../db/vector.js";
import { embedTexts } from "../embed/model.js";
import type { Candidate } from "./types.js";

/** Document-scoped dense retrieval: cosine top-n over pgvector. */
export async function denseRetrieve(query: string, docId: string, n: number): Promise<Candidate[]> {
  const [qv] = await embedTexts([query], { kind: "query" });
  const lit = toVectorLiteral(qv);
  const rows = (
    await withClient((c) =>
      c.query(
        `SELECT c.node_id, c.doc_id, c.type, c.number, c.heading, c.text,
                c.char_start, c.char_end,
                1 - (e.embedding <=> $1::vector) AS score
         FROM clauses c
         JOIN embeddings e USING (node_id)
         WHERE c.doc_id = $2
         ORDER BY e.embedding <=> $1::vector
         LIMIT $3`,
        [lit, docId, n],
      ),
    )
  ).rows;
  return rows.map((r) => ({
    node_id: r.node_id, doc_id: r.doc_id, type: r.type, number: r.number,
    heading: r.heading, text: r.text, char_start: r.char_start, char_end: r.char_end,
    score: Number(r.score),
  }));
}
```

- [ ] **Step 4: Rewrite `retrieve.ts` to delegate to `denseRetrieve` and re-export `Candidate`**

Replace the entire contents of `core/src/retrieve/retrieve.ts` with:
```ts
import { denseRetrieve } from "./dense.js";
import type { Candidate } from "./types.js";

export type { Candidate } from "./types.js";

/** Naive baseline: single-embedding, document-scoped cosine top-k over pgvector. */
export function retrieve(query: string, docId: string, k = 8): Promise<Candidate[]> {
  return denseRetrieve(query, docId, k);
}
```
(Note: `makeRetriever` is added in Task 5. Keeping `retrieve` as the naive path here preserves every current import — `generate/types.ts`, `runEval.ts`, `eval/cli.ts`, the SSE route — unchanged.)

- [ ] **Step 5: Typecheck and re-run the regression test**

Run: `npm run typecheck`
Expected: clean.
Run: `npx vitest run test/retrieve.test.ts`
Expected: PASS (2 tests) — identical behavior.

- [ ] **Step 6: Commit**

```bash
git add core/src/retrieve/types.ts core/src/retrieve/dense.ts core/src/retrieve/retrieve.ts
git commit -m "refactor(retrieve): extract Candidate type + denseRetrieve module (no behavior change)"
```

---

### Task 2: Lexical retrieval over Postgres full-text search (migration + module)

**Files:**
- Create: `core/migrations/0005_clauses_fts.sql`
- Create: `core/src/retrieve/lexical.ts`
- Test: `core/test/lexical.test.ts` (DB-backed)

**Interfaces:**
- Consumes: `Candidate` (`./types.js`), `withClient` (`../db/client.js`).
- Produces: `lexicalRetrieve(query: string, docId: string, n: number): Promise<Candidate[]>` — doc-scoped FTS, ranked by `ts_rank_cd` desc, returns `[]` when nothing matches.

- [ ] **Step 1: Write the failing test**

Create `core/test/lexical.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withClient } from "../src/db/client.js";
import { lexicalRetrieve } from "../src/retrieve/lexical.js";

const DOC = "lextest_doc";
const OTHER = "lextest_other";
const GOV = "This Agreement shall be governed by the laws of the State of New York.";
const CONF = "The Receiving Party shall return all Confidential Information upon request.";

async function seedDoc(doc: string) {
  const raw = GOV + "\n" + CONF;
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO documents (doc_id, source, title, contract_type, raw_text, char_length, raw_sha256)
       VALUES ($1,'cuad','t','nda',$2,$3,'x') ON CONFLICT (doc_id) DO NOTHING`,
      [doc, raw, raw.length],
    );
    await c.query(
      `INSERT INTO clauses (node_id, doc_id, parent_id, type, number, heading, text, char_start, char_end, depth)
       VALUES ($1,$2,NULL,'section','1','Governing Law',$3,0,$4,0) ON CONFLICT (node_id) DO NOTHING`,
      [`${doc}::n0`, doc, GOV, GOV.length],
    );
    await c.query(
      `INSERT INTO clauses (node_id, doc_id, parent_id, type, number, heading, text, char_start, char_end, depth)
       VALUES ($1,$2,NULL,'section','2','Return of Materials',$3,$4,$5,0) ON CONFLICT (node_id) DO NOTHING`,
      [`${doc}::n1`, doc, CONF, GOV.length + 1, GOV.length + 1 + CONF.length],
    );
  });
}
async function cleanup() {
  await withClient((c) => c.query("DELETE FROM documents WHERE doc_id = ANY($1)", [[DOC, OTHER]]));
}

describe("lexicalRetrieve", () => {
  beforeAll(async () => { await cleanup(); await seedDoc(DOC); await seedDoc(OTHER); });
  afterAll(cleanup);

  it("ranks the lexically matching clause first", async () => {
    const hits = await lexicalRetrieve("governing law", DOC, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].node_id).toBe(`${DOC}::n0`);
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it("is document-scoped", async () => {
    const hits = await lexicalRetrieve("confidential information", DOC, 5);
    expect(hits.every((h) => h.doc_id === DOC)).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("returns [] when no lexical term matches", async () => {
    const hits = await lexicalRetrieve("zzzznotapresentterm", DOC, 5);
    expect(hits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/lexical.test.ts`
Expected: FAIL — `lexicalRetrieve` is not defined / `text_search` column does not exist.

- [ ] **Step 3: Create the migration**

Create `core/migrations/0005_clauses_fts.sql`:
```sql
-- Lexical half of hybrid retrieval (P2a). Generated STORED tsvector auto-backfills existing
-- rows on ALTER and self-maintains on future loads. Heading weighted 'A' (objectives often
-- name the clause title), body text 'B'. Two-arg to_tsvector('english', ...) is IMMUTABLE,
-- which a generated column requires.
ALTER TABLE clauses ADD COLUMN IF NOT EXISTS text_search tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(heading, '')), 'A') ||
    setweight(to_tsvector('english', text), 'B')
  ) STORED;
CREATE INDEX IF NOT EXISTS clauses_fts_idx ON clauses USING GIN (text_search);
```

- [ ] **Step 4: Apply the migration** (backfills all existing clauses)

Run: `npm run migrate`
Expected: `applied: 0005_clauses_fts.sql`

- [ ] **Step 5: Implement `lexical.ts`**

Create `core/src/retrieve/lexical.ts`:
```ts
import { withClient } from "../db/client.js";
import type { Candidate } from "./types.js";

/** Document-scoped lexical retrieval via Postgres full-text search (ts_rank_cd). */
export async function lexicalRetrieve(query: string, docId: string, n: number): Promise<Candidate[]> {
  const rows = (
    await withClient((c) =>
      c.query(
        `SELECT c.node_id, c.doc_id, c.type, c.number, c.heading, c.text,
                c.char_start, c.char_end,
                ts_rank_cd(c.text_search, websearch_to_tsquery('english', $1)) AS score
         FROM clauses c
         WHERE c.doc_id = $2
           AND c.text_search @@ websearch_to_tsquery('english', $1)
         ORDER BY score DESC
         LIMIT $3`,
        [query, docId, n],
      ),
    )
  ).rows;
  return rows.map((r) => ({
    node_id: r.node_id, doc_id: r.doc_id, type: r.type, number: r.number,
    heading: r.heading, text: r.text, char_start: r.char_start, char_end: r.char_end,
    score: Number(r.score),
  }));
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/lexical.test.ts`
Expected: PASS (3 tests).
Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add core/migrations/0005_clauses_fts.sql core/src/retrieve/lexical.ts core/test/lexical.test.ts
git commit -m "feat(retrieve): Postgres FTS lexical retrieval + tsvector migration"
```

---

### Task 3: Reciprocal Rank Fusion (pure function)

**Files:**
- Create: `core/src/retrieve/rrf.ts`
- Test: `core/test/rrf.test.ts` (pure, no infra)

**Interfaces:**
- Consumes: `Candidate` (`./types.js`).
- Produces: `rrfFuse(lists: Candidate[][], opts: { k: number }): Candidate[]` — fused score `= Σ 1/(k + rank)` (rank 1-based per list), deduped by `node_id` (first occurrence's fields kept), sorted desc, `score` set to the fused value.

- [ ] **Step 1: Write the failing test**

Create `core/test/rrf.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { rrfFuse } from "../src/retrieve/rrf.js";
import type { Candidate } from "../src/retrieve/types.js";

function cand(id: string, score = 0): Candidate {
  return { node_id: id, doc_id: "d", type: "section", number: null, heading: null, text: id, char_start: 0, char_end: 1, score };
}

describe("rrfFuse", () => {
  it("ranks a node appearing in both lists above singletons", () => {
    const dense = [cand("a"), cand("b"), cand("c")];
    const lexical = [cand("a"), cand("d")];
    const fused = rrfFuse([dense, lexical], { k: 60 });
    expect(fused[0].node_id).toBe("a");
    expect(fused.map((c) => c.node_id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("sets score to the RRF score (sum of 1/(k+rank))", () => {
    const fused = rrfFuse([[cand("a"), cand("b")]], { k: 60 });
    expect(fused[0].score).toBeCloseTo(1 / 61, 10);
    expect(fused[1].score).toBeCloseTo(1 / 62, 10);
  });

  it("dedupes by node_id, keeping the first occurrence's fields", () => {
    const first = { ...cand("a"), text: "first" };
    const second = { ...cand("a"), text: "second" };
    const fused = rrfFuse([[first], [second]], { k: 60 });
    expect(fused).toHaveLength(1);
    expect(fused[0].text).toBe("first");
  });

  it("handles empty input", () => {
    expect(rrfFuse([], { k: 60 })).toEqual([]);
    expect(rrfFuse([[], []], { k: 60 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/rrf.test.ts`
Expected: FAIL — `rrfFuse` is not defined.

- [ ] **Step 3: Implement `rrf.ts`**

Create `core/src/retrieve/rrf.ts`:
```ts
import type { Candidate } from "./types.js";

/**
 * Reciprocal Rank Fusion. Each candidate's fused score is the sum, over the input
 * lists, of 1/(k + rank) with rank the 1-based position in that list. Deduped by
 * node_id (first occurrence's fields kept); returns candidates sorted by fused score
 * descending, each with `score` overwritten by its fused value.
 */
export function rrfFuse(lists: Candidate[][], opts: { k: number }): Candidate[] {
  const { k } = opts;
  const fused = new Map<string, number>();
  const byId = new Map<string, Candidate>();
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      fused.set(c.node_id, (fused.get(c.node_id) ?? 0) + 1 / (k + i + 1));
      if (!byId.has(c.node_id)) byId.set(c.node_id, c);
    }
  }
  return [...byId.values()]
    .map((c) => ({ ...c, score: fused.get(c.node_id)! }))
    .sort((a, b) => b.score - a.score);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/rrf.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/retrieve/rrf.ts core/test/rrf.test.ts
git commit -m "feat(retrieve): pure Reciprocal Rank Fusion (rrfFuse)"
```

---

### Task 4: Local cross-encoder reranker

**Files:**
- Create: `core/src/rerank/model.ts`
- Test: `core/test/rerank.model.test.ts` (infra: downloads ONNX weights)

**Interfaces:**
- Consumes: `Candidate` (`../retrieve/types.js`), `@huggingface/transformers`.
- Produces:
  - `RERANK_MODEL: string` (env `RERANK_MODEL`, default `"Xenova/ms-marco-MiniLM-L-6-v2"`).
  - `rerankScores(query: string, passages: string[]): Promise<number[]>` — one relevance score per passage (higher = more relevant); `[]` for no passages.
  - `rerank(query: string, candidates: Candidate[], topK: number): Promise<Candidate[]>` — sorted by relevance desc, top-K, `score` = relevance.

- [ ] **Step 1: Write the failing test**

Create `core/test/rerank.model.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { rerankScores } from "../src/rerank/model.js";

// First run downloads the cross-encoder ONNX weights (~tens of MB), then caches them.
describe("rerankScores", () => {
  it("scores a relevant passage above an irrelevant one", async () => {
    const q = "Which state's law governs this agreement?";
    const [relevant, irrelevant] = await rerankScores(q, [
      "This Agreement shall be governed by the laws of the State of New York.",
      "The cafeteria serves lunch between noon and 2pm on weekdays.",
    ]);
    expect(relevant).toBeGreaterThan(irrelevant);
  }, 120_000);

  it("returns [] for no passages", async () => {
    expect(await rerankScores("q", [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/rerank.model.test.ts`
Expected: FAIL — `rerankScores` is not defined.

- [ ] **Step 3: Implement `rerank/model.ts`**

Create `core/src/rerank/model.ts`:
```ts
import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
  type PreTrainedTokenizer,
  type PreTrainedModel,
} from "@huggingface/transformers";
import type { Candidate } from "../retrieve/types.js";

export const RERANK_MODEL = process.env.RERANK_MODEL ?? "Xenova/ms-marco-MiniLM-L-6-v2";

let _rr: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> | null = null;
function reranker() {
  return (_rr ??= (async () => {
    const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL);
    const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, {
      dtype: "fp32",
    });
    return { tokenizer, model };
  })());
}

/** Relevance score per passage for the query (higher = more relevant). */
export async function rerankScores(query: string, passages: string[]): Promise<number[]> {
  if (passages.length === 0) return [];
  const { tokenizer, model } = await reranker();
  // ms-marco / bge cross-encoders take (query, passage) pairs and emit a single
  // relevance logit per pair: logits shape [N, 1]. Tokenizer→model types in v3 are
  // loose; cast like embed/model.ts does for the pipeline.
  const inputs = tokenizer(new Array(passages.length).fill(query), {
    text_pair: passages,
    padding: true,
    truncation: true,
  });
  const { logits } = (await model(inputs)) as unknown as {
    logits: { sigmoid(): { tolist(): number[][] } };
  };
  return logits.sigmoid().tolist().map((row) => row[0]);
}

/** Rerank candidates by cross-encoder relevance; returns the top-K, score = relevance. */
export async function rerank(
  query: string,
  candidates: Candidate[],
  topK: number,
): Promise<Candidate[]> {
  if (candidates.length === 0) return [];
  const scores = await rerankScores(query, candidates.map((c) => c.text));
  return candidates
    .map((c, i) => ({ ...c, score: scores[i] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
```
(If `tsc` rejects `model(inputs)` on the input type, change to `model(inputs as never)` — same pattern as the `embed/model.ts` cast. Fallback model if `Xenova/ms-marco-MiniLM-L-6-v2` misbehaves: set `RERANK_MODEL=Xenova/bge-reranker-base`, which is also single-logit.)

- [ ] **Step 4: Run the test to verify it passes** (downloads weights on first run)

Run: `npx vitest run test/rerank.model.test.ts`
Expected: PASS (2 tests).
Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add core/src/rerank/model.ts core/test/rerank.model.test.ts
git commit -m "feat(rerank): local cross-encoder reranker (ms-marco-MiniLM)"
```

---

### Task 5: Hybrid orchestrator + `makeRetriever` mode factory

**Files:**
- Create: `core/src/retrieve/hybrid.ts`
- Modify: `core/src/retrieve/retrieve.ts`
- Test: `core/test/retrieve.hybrid.test.ts` (unit, injected fakes — no infra)

**Interfaces:**
- Consumes: `denseRetrieve` (`./dense.js`), `lexicalRetrieve` (`./lexical.js`), `rrfFuse` (`./rrf.js`), `rerank` (`../rerank/model.js`), `Candidate` (`./types.js`).
- Produces:
  - `interface HybridDeps { dense; lexical; rerank }` and `hybridRetrieve(query, docId, k?, deps?, cfg?): Promise<Candidate[]>`.
  - `HYBRID_DEFAULTS = { N_DENSE: 50, N_LEX: 50, M: 100, K_RRF: 60 }`.
  - `type RetrieveFn = (query: string, docId: string, k?: number) => Promise<Candidate[]>`.
  - `makeRetriever(mode: string | undefined): RetrieveFn` — `"hybrid"` → pipeline, anything else → naive dense.
  - `retrieve(query, docId, k?)` (back-compat) resolves mode from `process.env.RETRIEVE_MODE`.

- [ ] **Step 1: Write the failing test**

Create `core/test/retrieve.hybrid.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { hybridRetrieve, type HybridDeps } from "../src/retrieve/hybrid.js";
import { makeRetriever } from "../src/retrieve/retrieve.js";
import type { Candidate } from "../src/retrieve/types.js";

function cand(id: string): Candidate {
  return { node_id: id, doc_id: "d", type: "section", number: null, heading: null, text: id, char_start: 0, char_end: 1, score: 0 };
}

describe("hybridRetrieve", () => {
  it("fuses dense+lexical, caps at M, reranks, returns top-k preserving spans", async () => {
    const deps: HybridDeps = {
      dense: vi.fn().mockResolvedValue([cand("a"), cand("b")]),
      lexical: vi.fn().mockResolvedValue([cand("b"), cand("c")]),
      // rerank returns its input reversed so we can assert it ran and ordered the output
      rerank: vi.fn(async (_q, cs: Candidate[], topK: number) => [...cs].reverse().slice(0, topK)),
    };
    const out = await hybridRetrieve("q", "d", 2, deps, { N_DENSE: 50, N_LEX: 50, M: 100, K_RRF: 60 });
    expect(out).toHaveLength(2);
    expect((deps.dense as any)).toHaveBeenCalledWith("q", "d", 50);
    expect((deps.lexical as any)).toHaveBeenCalledWith("q", "d", 50);
    // rerank received the fused, deduped union {a,b,c}
    const rerankArg = (deps.rerank as any).mock.calls[0][1].map((c: Candidate) => c.node_id).sort();
    expect(rerankArg).toEqual(["a", "b", "c"]);
    expect(out[0].char_start).toBe(0); // span fields preserved
  });

  it("caps the rerank pool at M", async () => {
    const many = Array.from({ length: 80 }, (_, i) => cand("d" + i));
    const deps: HybridDeps = {
      dense: vi.fn().mockResolvedValue(many.slice(0, 50)),
      lexical: vi.fn().mockResolvedValue(many.slice(40, 80)), // union = 80 distinct
      rerank: vi.fn(async (_q, cs: Candidate[], topK: number) => cs.slice(0, topK)),
    };
    await hybridRetrieve("q", "d", 8, deps, { N_DENSE: 50, N_LEX: 50, M: 60, K_RRF: 60 });
    expect((deps.rerank as any).mock.calls[0][1]).toHaveLength(60); // capped at M
  });

  it("falls back to fused order when rerank throws", async () => {
    const deps: HybridDeps = {
      dense: vi.fn().mockResolvedValue([cand("a"), cand("b")]),
      lexical: vi.fn().mockResolvedValue([]),
      rerank: vi.fn().mockRejectedValue(new Error("model load failed")),
    };
    const out = await hybridRetrieve("q", "d", 8, deps);
    expect(out.map((c) => c.node_id)).toEqual(["a", "b"]); // fused order, no throw
  });

  it("returns [] when both stages are empty", async () => {
    const deps: HybridDeps = {
      dense: vi.fn().mockResolvedValue([]),
      lexical: vi.fn().mockResolvedValue([]),
      rerank: vi.fn(),
    };
    expect(await hybridRetrieve("q", "d", 8, deps)).toEqual([]);
    expect((deps.rerank as any)).not.toHaveBeenCalled();
  });
});

describe("makeRetriever", () => {
  it("returns a function for naive (default) and hybrid modes", () => {
    expect(typeof makeRetriever("naive")).toBe("function");
    expect(typeof makeRetriever("hybrid")).toBe("function");
    expect(typeof makeRetriever(undefined)).toBe("function");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/retrieve.hybrid.test.ts`
Expected: FAIL — `hybridRetrieve` / `makeRetriever` not defined.

- [ ] **Step 3: Implement `hybrid.ts`**

Create `core/src/retrieve/hybrid.ts`:
```ts
import type { Candidate } from "./types.js";
import { denseRetrieve } from "./dense.js";
import { lexicalRetrieve } from "./lexical.js";
import { rrfFuse } from "./rrf.js";
import { rerank as rerankDefault } from "../rerank/model.js";

export interface HybridDeps {
  dense: (query: string, docId: string, n: number) => Promise<Candidate[]>;
  lexical: (query: string, docId: string, n: number) => Promise<Candidate[]>;
  rerank: (query: string, candidates: Candidate[], topK: number) => Promise<Candidate[]>;
}

export const HYBRID_DEFAULTS = { N_DENSE: 50, N_LEX: 50, M: 100, K_RRF: 60 };

const defaultDeps: HybridDeps = {
  dense: denseRetrieve,
  lexical: lexicalRetrieve,
  rerank: rerankDefault,
};

/**
 * Hybrid doc-scoped retrieval: dense + lexical (parallel) → RRF fuse → cap at M →
 * cross-encoder rerank → top-k. If rerank throws (e.g. model load failure), falls back
 * to the fused order so a query never hard-fails.
 */
export async function hybridRetrieve(
  query: string,
  docId: string,
  k = 8,
  deps: HybridDeps = defaultDeps,
  cfg = HYBRID_DEFAULTS,
): Promise<Candidate[]> {
  const [dense, lexical] = await Promise.all([
    deps.dense(query, docId, cfg.N_DENSE),
    deps.lexical(query, docId, cfg.N_LEX),
  ]);
  const fused = rrfFuse([dense, lexical], { k: cfg.K_RRF }).slice(0, cfg.M);
  if (fused.length === 0) return [];
  try {
    return await deps.rerank(query, fused, k);
  } catch (e) {
    process.stderr.write(
      `rerank failed, falling back to fused order: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return fused.slice(0, k);
  }
}
```

- [ ] **Step 4: Add `makeRetriever` + back-compat `retrieve` to `retrieve.ts`**

Replace the entire contents of `core/src/retrieve/retrieve.ts` with:
```ts
import { denseRetrieve } from "./dense.js";
import { hybridRetrieve } from "./hybrid.js";
import type { Candidate } from "./types.js";

export type { Candidate } from "./types.js";

export type RetrieveFn = (query: string, docId: string, k?: number) => Promise<Candidate[]>;

/** Select a retrieval strategy. naive = dense cosine top-k (P1 baseline); hybrid = P2a pipeline. */
export function makeRetriever(mode: string | undefined): RetrieveFn {
  if (mode === "hybrid") return (q, d, k = 8) => hybridRetrieve(q, d, k);
  return (q, d, k = 8) => denseRetrieve(q, d, k); // default: naive
}

/** Back-compat entry point: resolves the mode from RETRIEVE_MODE (default naive). */
export function retrieve(query: string, docId: string, k = 8): Promise<Candidate[]> {
  return makeRetriever(process.env.RETRIEVE_MODE)(query, docId, k);
}
```

- [ ] **Step 5: Run tests + typecheck, and confirm naive behavior is unchanged**

Run: `npx vitest run test/retrieve.hybrid.test.ts`
Expected: PASS (5 tests).
Run: `npm run typecheck`
Expected: clean.
Run: `npx vitest run test/retrieve.test.ts` (DB up; `RETRIEVE_MODE` unset → naive)
Expected: PASS (2 tests) — baseline path unchanged.

- [ ] **Step 6: Commit**

```bash
git add core/src/retrieve/hybrid.ts core/src/retrieve/retrieve.ts core/test/retrieve.hybrid.test.ts
git commit -m "feat(retrieve): hybrid orchestrator + makeRetriever(naive|hybrid) factory"
```

---

### Task 6: `compare` subcommand + false-negative-rate metric

**Files:**
- Create: `core/src/eval/compare.ts`
- Modify: `core/src/eval/cli.ts`
- Test: `core/test/compare.test.ts` (pure)

**Interfaces:**
- Consumes: `EvalReport`, `ItemResult` (`./runEval.js`).
- Produces:
  - `falseNegativeRate(items: ItemResult[]): number | null` — of answerable items (category `clean`|`deviated`), the fraction that `refused` OR had `recall_at_k === 0` (required clause never reached the answer). `null` if no answerable items.
  - `compareReports(baseline: EvalReport, candidate: EvalReport): MetricRow[]` where `interface MetricRow { metric: string; baseline: number | null; candidate: number | null; delta: number | null }`.
  - `formatDelta(rows: MetricRow[]): string`.
- CLI: `npm run eval -- compare <baselineFile> <candidateFile>` (filenames resolved under `evals/reports/`).

> **Note (spec refinement):** the design defined the false-negative rate as "refused, or answered without citing a gold-overlapping span." This task implements the **computable proxy** `refused || recall_at_k === 0`, so `compare` runs on existing report files (incl. the current `baseline.json`) with no re-run and no schema change. It slightly under-counts (an answer that retrieved the gold span but cited a different clause isn't flagged). Good enough for the P2a delta; P2b can tighten it with a per-item `gold_cited` field.

- [ ] **Step 1: Write the failing test**

Create `core/test/compare.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { compareReports, falseNegativeRate } from "../src/eval/compare.js";
import type { EvalReport, ItemResult } from "../src/eval/runEval.js";

function item(p: Partial<ItemResult>): ItemResult {
  return { id: "x", category: "clean", grader: "span_match", recall_at_k: 1, ndcg_at_k: 1, groundedness: 1, refused: false, num_candidates: 8, num_citations: 1, error: null, ...p };
}
function report(items: ItemResult[], agg: Partial<EvalReport["aggregates"]>): EvalReport {
  return { k: 8, total: items.length, items, aggregates: { mean_recall_at_k: 0, mean_ndcg_at_k: 0, mean_groundedness: 1, refusal_rate: 0, errored: 0, ...agg } };
}

describe("falseNegativeRate", () => {
  it("counts answerable items that refused or never retrieved the gold span", () => {
    const items = [
      item({ category: "clean", refused: true, recall_at_k: 0 }),
      item({ category: "deviated", refused: false, recall_at_k: 0 }),
      item({ category: "clean", refused: false, recall_at_k: 1 }),
      item({ category: "missing", refused: true, recall_at_k: null }), // not answerable → excluded
    ];
    expect(falseNegativeRate(items)).toBeCloseTo(2 / 3, 10);
  });
  it("returns null with no answerable items", () => {
    expect(falseNegativeRate([item({ category: "missing" })])).toBeNull();
  });
});

describe("compareReports", () => {
  it("computes per-metric deltas including FN rate", () => {
    const base = report([item({ recall_at_k: 0, refused: true })], { mean_recall_at_k: 0.75 });
    const cand = report([item({ recall_at_k: 1, refused: false })], { mean_recall_at_k: 0.9 });
    const rows = compareReports(base, cand);
    const recall = rows.find((r) => r.metric === "recall@k")!;
    expect(recall.delta).toBeCloseTo(0.15, 10);
    const fn = rows.find((r) => r.metric === "false_negative_rate")!;
    expect(fn.baseline).toBe(1);
    expect(fn.candidate).toBe(0);
    expect(fn.delta).toBe(-1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/compare.test.ts`
Expected: FAIL — `compareReports` not defined.

- [ ] **Step 3: Implement `compare.ts`**

Create `core/src/eval/compare.ts`:
```ts
import type { EvalReport, ItemResult } from "./runEval.js";

export interface MetricRow {
  metric: string;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
}

const ANSWERABLE = new Set(["clean", "deviated"]);

/**
 * False-negative rate: of the answerable items (category clean | deviated), the fraction
 * where the required clause was missed — the item refused, or the gold span was never
 * retrieved into the top-k (recall_at_k === 0), so the answer could not cite it.
 */
export function falseNegativeRate(items: ItemResult[]): number | null {
  const answerable = items.filter((i) => ANSWERABLE.has(i.category));
  if (answerable.length === 0) return null;
  const missed = answerable.filter((i) => i.refused || i.recall_at_k === 0).length;
  return missed / answerable.length;
}

export function compareReports(baseline: EvalReport, candidate: EvalReport): MetricRow[] {
  const rows: [string, number | null, number | null][] = [
    ["recall@k", baseline.aggregates.mean_recall_at_k, candidate.aggregates.mean_recall_at_k],
    ["ndcg@k", baseline.aggregates.mean_ndcg_at_k, candidate.aggregates.mean_ndcg_at_k],
    ["groundedness", baseline.aggregates.mean_groundedness, candidate.aggregates.mean_groundedness],
    ["refusal_rate", baseline.aggregates.refusal_rate, candidate.aggregates.refusal_rate],
    ["false_negative_rate", falseNegativeRate(baseline.items), falseNegativeRate(candidate.items)],
  ];
  return rows.map(([metric, b, c]) => ({
    metric,
    baseline: b,
    candidate: c,
    delta: b === null || c === null ? null : c - b,
  }));
}

export function formatDelta(rows: MetricRow[]): string {
  const fmt = (x: number | null) => (x === null ? " n/a  " : x.toFixed(4));
  const header = `${"metric".padEnd(20)} ${"baseline".padEnd(8)}    ${"candidate".padEnd(9)}  delta`;
  const lines = rows.map((r) => {
    const d = r.delta === null ? " n/a" : (r.delta >= 0 ? "+" : "") + r.delta.toFixed(4);
    return `${r.metric.padEnd(20)} ${fmt(r.baseline)}  →  ${fmt(r.candidate)}   ${d}`;
  });
  return [header, ...lines].join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/compare.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the `compare` subcommand to `cli.ts`**

In `core/src/eval/cli.ts`, add this import near the top (with the other `./` imports):
```ts
import { compareReports, formatDelta } from "./compare.js";
```
Then add a new branch in the command chain — insert it immediately before the final `else` (the `usage:` branch):
```ts
} else if (cmd === "compare") {
  const [aArg, bArg] = process.argv.slice(3);
  if (!aArg || !bArg) {
    console.error("usage: tsx src/eval/cli.ts compare <baselineFile> <candidateFile>  (files under evals/reports/)");
    process.exit(2);
  }
  const a = JSON.parse(readFileSync(`${root}evals/reports/${aArg}`, "utf-8"));
  const b = JSON.parse(readFileSync(`${root}evals/reports/${bArg}`, "utf-8"));
  console.log(formatDelta(compareReports(a, b)));
  process.exit(0);
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.
```bash
git add core/src/eval/compare.ts core/src/eval/cli.ts core/test/compare.test.ts
git commit -m "feat(eval): compare subcommand + false-negative-rate delta table"
```

---

### Task 7: Wire `RETRIEVE_MODE` into the eval CLI and SSE route

**Files:**
- Modify: `core/src/eval/cli.ts` (the `run` branch)
- Modify: `app/app/api/answer/route.ts`

**Interfaces:**
- Consumes: `makeRetriever` (`../retrieve/retrieve.js` in core; `@sift/core/retrieve` in app).
- Behavior: `run` builds its retriever from `RETRIEVE_MODE`, stamps `retrieve_mode` + `rerank_model` into the report, and writes `baseline.json` (naive) or `p2a.json` (hybrid).

- [ ] **Step 1: Swap the eval CLI to `makeRetriever` + provenance + mode-based output**

In `core/src/eval/cli.ts`, change the retrieve import:
```ts
// from:
import { retrieve } from "../retrieve/retrieve.js";
// to:
import { makeRetriever } from "../retrieve/retrieve.js";
```
In the `run` branch, replace the `gen`/`deps`/`report`/`writeFileSync` section with:
```ts
  const mode = process.env.RETRIEVE_MODE ?? "naive";
  const retrieve = makeRetriever(mode);

  const gen = makeGenerator();
  const deps = {
    retrieve,
    generate: gen.generate.bind(gen),
    rawText,
    onProgress: (done: number, total: number, item: { id: string }) =>
      process.stderr.write(`item ${done}/${total} ${item.id}\n`),
  };

  const report = await runEval(items, deps, k);

  // Provenance: provider/model match makeGenerator(); retrieve_mode + rerank_model record P2a config.
  const provider = process.env.LLM_PROVIDER ?? "openai";
  const model = process.env.LLM_MODEL ?? null;
  const rerank_model = mode === "hybrid" ? (process.env.RERANK_MODEL ?? "Xenova/ms-marco-MiniLM-L-6-v2") : null;

  const outName = mode === "hybrid" ? "p2a.json" : "baseline.json";
  mkdirSync(`${root}evals/reports`, { recursive: true });
  writeFileSync(
    `${root}evals/reports/${outName}`,
    JSON.stringify({ provider, model, retrieve_mode: mode, rerank_model, ...report }, null, 2) + "\n",
  );

  console.log(JSON.stringify({ retrieve_mode: mode, k: report.k, total: report.total, aggregates: report.aggregates }, null, 2));
  process.exit(0);
```

- [ ] **Step 2: Verify naive mode still reproduces the baseline shape** (DB up, provider env set)

Run: `RETRIEVE_MODE=naive npm run eval -- run`
Expected: stderr `item 1/50 …` progress; stdout JSON with `"retrieve_mode": "naive"`; writes `evals/reports/baseline.json`. (Aggregates should match the committed baseline within run-to-run LLM variance.)

- [ ] **Step 3: Point the SSE route at `makeRetriever`**

In `app/app/api/answer/route.ts`, change the dynamic import + deps:
```ts
// from:
const [{ retrieve }, { makeGenerator }] = await Promise.all([
  import("@sift/core/retrieve"),
  import("@sift/core/generate"),
]);
// to:
const [{ makeRetriever }, { makeGenerator }] = await Promise.all([
  import("@sift/core/retrieve"),
  import("@sift/core/generate"),
]);
```
And in the `deps` object:
```ts
const deps: AnswerDeps = {
  retrieve: makeRetriever(process.env.RETRIEVE_MODE),
  generate: gen.generate.bind(gen),
};
```

- [ ] **Step 4: Typecheck both packages**

Run: `npm run typecheck` (from `core/`)
Expected: clean.
Run (from `app/`): `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add core/src/eval/cli.ts app/app/api/answer/route.ts
git commit -m "feat(eval,app): RETRIEVE_MODE wiring + report provenance (naive→baseline, hybrid→p2a)"
```

---

### Task 8: Run the P2a eval gate and record the delta table

**Files:**
- Produces: `evals/reports/p2a.json`
- Modify: append the measured delta table to `docs/superpowers/specs/2026-06-28-p2a-hybrid-retrieval-rerank-design.md` (a "Results" section)

This is the **merge gate** (CLAUDE.md: evals gate the phase). It runs on the user's infra (DB up, embeddings present, LLM provider working, reranker weights downloaded). Not a unit test — a measurement.

- [ ] **Step 1: Ensure infra is ready**

Run: `make db-up` (if not already), then from `core/`: `npm run migrate`
Expected: migrations up to `0005` applied. `.env` has a working `LLM_PROVIDER`/`LLM_MODEL` (e.g. `meta/llama-3.3-70b-instruct`) and `LLM_RPM=36`.

- [ ] **Step 2: Run the hybrid eval**

Run: `RETRIEVE_MODE=hybrid npm run eval -- run`
Expected: `item X/50` progress; first run downloads the reranker weights; writes `evals/reports/p2a.json` with `"retrieve_mode": "hybrid"`, `"errored": 0`.

- [ ] **Step 3: Print the delta table**

Run: `npm run eval -- compare baseline.json p2a.json`
Expected: a table — recall@k, ndcg@k, groundedness, refusal_rate, false_negative_rate, each `baseline → candidate (delta)`.

- [ ] **Step 4: Record results + judge the gate**

Append a "## Results (P2a)" section to the design doc with the delta table. **Gate:** groundedness holds at ~1.0 (no new hallucination); recall@k and NDCG should rise (target recall@k ≥ ~0.85) and false_negative_rate should fall. If a metric regresses or is flat, record the finding and the hypothesis — that is a valid P2a outcome and feeds P2b.

- [ ] **Step 5: Commit**

```bash
git add evals/reports/p2a.json docs/superpowers/specs/2026-06-28-p2a-hybrid-retrieval-rerank-design.md
git commit -m "eval(p2a): record hybrid+rerank delta vs baseline"
```

---

## Self-Review

**Spec coverage:**
- Hybrid dense+lexical+RRF → Tasks 2 (lexical), 3 (RRF), 5 (orchestrator), plus dense via Task 1. ✓
- Postgres FTS for BM25 half → Task 2 migration + module. ✓
- Cross-encoder rerank (local) → Task 4 + wired in Task 5. ✓
- `RETRIEVE_MODE=naive|hybrid`, baseline reproducible → Task 5 factory + Task 7 wiring. ✓
- Schema migration (generated STORED tsvector + GIN) → Task 2. ✓
- Candidate shape unchanged, generator/UI untouched → enforced across Tasks 1/3/4/5 (reorder + score only). ✓
- Eval: same eval-set-v1, p2a.json, compare delta table incl. FN rate, groundedness gate → Tasks 6, 7, 8. ✓
- Error handling: rerank failure → fused fallback; empty stages → []/refuse → Task 5. ✓
- Out of scope (embedder comparison, agentic loop, metadata filters, true-BM25 extension) → not planned. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; every command has expected output. ✓

**Type consistency:** `Candidate` (types.ts) used uniformly; `denseRetrieve/lexicalRetrieve` share `(query, docId, n)`; `rerank(query, candidates, topK)` matches `HybridDeps.rerank`; `RetrieveFn = (query, docId, k?) => Promise<Candidate[]>` matches `runEval.RunDeps.retrieve` and `AnswerDeps.retrieve`; `compareReports`/`MetricRow` consistent between `compare.ts` and its test. ✓

**Deviation noted for the user:** false-negative rate is implemented as the computable proxy `refused || recall_at_k === 0` (Task 6 note) rather than the design's citation-overlap definition, so `compare` works on existing reports with no re-run.
