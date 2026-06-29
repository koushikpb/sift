# P2b — Embedder Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the embedder a configured choice (a model registry + `(node_id, model)` composite key so two models' vectors coexist), then benchmark `bge-large-en-v1.5` vs `mxbai-embed-large-v1` on the retrieval eval and report the delta.

**Architecture:** One env knob, `EMBED_MODEL`, selects the active embedder everywhere — `indexClauses` embeds clauses with it, `denseRetrieve` embeds the query with it and filters `embeddings` by it. A small registry maps each model name to its repo/pooling/prefix/dim. The benchmark re-embeds the corpus as mxbai and runs the eval in naive (dense-only) mode to isolate the embedder, then compares to the bge-large baseline with the existing P2a `compare` tool.

**Tech Stack:** TypeScript/Node 20 (ESM, NodeNext), Postgres 16 + pgvector, `@huggingface/transformers` (onnxruntime) feature-extraction, vitest.

## Global Constraints

- ESM relative imports use explicit `.js` extensions (NodeNext).
- **`EMBED_MODEL` default is `"bge-large-en-v1.5"`.** With the default model, embedding output is **byte-for-byte unchanged** (registry bge config = repo `Xenova/bge-large-en-v1.5`, `mean` pooling, prefix `"Represent this sentence for searching relevant passages: "`), so `baseline.json`/`p2a.json` stay reproducible.
- The active embedder is consistent end-to-end: clauses stored under `model = EMBED_MODEL`, queries embedded with `EMBED_MODEL`, and `denseRetrieve` filters `e.model = EMBED_MODEL`. Never compare a query vector from one model against another model's stored vectors.
- `embeddings` PK becomes `(node_id, model)`; both registry embedders are **1024-dim** (the `vector(1024)` column is unchanged). A model whose `dim` ≠ 1024 is out of scope.
- All DB access goes through `core/src/db/` (`withClient`).
- The registry is pure data + a pure resolver; pristine test output.
- DB-backed tests need `make db-up` + `npm run migrate` (incl. the new `0006`). Model tests download ONNX weights on first run — **mxbai is a large model (first download is ~1 GB+)**, so use a long timeout and run model-loading test files in isolation (the onnxruntime teardown crash on exit truncates a full-suite run but fails no test).
- Run commands from `core/` unless stated; commit from the repo root.

## File Structure

| File | Responsibility |
|---|---|
| `core/src/embed/registry.ts` (new) | `EmbedConfig` type, `EMBED_REGISTRY` (bge + mxbai), `resolveEmbedConfig`. |
| `core/src/embed/model.ts` (modify) | Model-aware `embedTexts({ kind, model? })`; per-model singleton; `EMBED_MODEL` from env. |
| `core/migrations/0006_embeddings_model_pk.sql` (new) | `embeddings` PK `(node_id)` → `(node_id, model)`. |
| `core/src/embed/indexClauses.ts` (modify) | Embed with active model; skip + upsert keyed on `(node_id, model)`. |
| `core/src/embed/cli.ts` (modify) | Log the active `EMBED_MODEL`. |
| `core/src/retrieve/dense.ts` (modify) | Filter the cosine query by `e.model = EMBED_MODEL`. |
| `core/src/eval/cli.ts` (modify) | Stamp `embed_model`; `EVAL_OUT` report-filename override. |

---

### Task 1: Embed model registry

**Files:**
- Create: `core/src/embed/registry.ts`
- Test: `core/test/registry.test.ts` (pure, no infra)

**Interfaces:**
- Produces: `interface EmbedConfig { repo: string; pooling: "mean" | "cls"; queryPrefix: string; dim: number }`; `EMBED_REGISTRY: Record<string, EmbedConfig>`; `resolveEmbedConfig(name: string): EmbedConfig` (throws naming known models on miss).

- [ ] **Step 1: Write the failing test**

Create `core/test/registry.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { resolveEmbedConfig, EMBED_REGISTRY } from "../src/embed/registry.js";

describe("resolveEmbedConfig", () => {
  it("returns the bge-large config (mean pooling)", () => {
    const cfg = resolveEmbedConfig("bge-large-en-v1.5");
    expect(cfg.repo).toBe("Xenova/bge-large-en-v1.5");
    expect(cfg.pooling).toBe("mean");
    expect(cfg.dim).toBe(1024);
  });

  it("returns the mxbai config (cls pooling)", () => {
    const cfg = resolveEmbedConfig("mxbai-embed-large-v1");
    expect(cfg.repo).toBe("mixedbread-ai/mxbai-embed-large-v1");
    expect(cfg.pooling).toBe("cls");
    expect(cfg.dim).toBe(1024);
  });

  it("throws naming known models on an unknown name", () => {
    expect(() => resolveEmbedConfig("nope")).toThrow(/unknown EMBED_MODEL/);
    expect(() => resolveEmbedConfig("nope")).toThrow(/bge-large-en-v1\.5/);
  });

  it("every registry entry is 1024-dim (matches the vector(1024) column)", () => {
    for (const cfg of Object.values(EMBED_REGISTRY)) expect(cfg.dim).toBe(1024);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/registry.test.ts`
Expected: FAIL — `resolveEmbedConfig` is not defined.

- [ ] **Step 3: Implement `registry.ts`**

Create `core/src/embed/registry.ts`:
```ts
export interface EmbedConfig {
  repo: string;
  pooling: "mean" | "cls";
  queryPrefix: string;
  dim: number;
}

// bge query prefix is the retrieval instruction bge recommends; mxbai's model card uses the
// same prefix for queries. Passages are embedded raw (no prefix). Pooling differs per model.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export const EMBED_REGISTRY: Record<string, EmbedConfig> = {
  "bge-large-en-v1.5": {
    repo: "Xenova/bge-large-en-v1.5",
    pooling: "mean",
    queryPrefix: QUERY_PREFIX,
    dim: 1024,
  },
  "mxbai-embed-large-v1": {
    repo: "mixedbread-ai/mxbai-embed-large-v1",
    pooling: "cls",
    queryPrefix: QUERY_PREFIX,
    dim: 1024,
  },
};

export function resolveEmbedConfig(name: string): EmbedConfig {
  const cfg = EMBED_REGISTRY[name];
  if (!cfg) {
    throw new Error(
      `unknown EMBED_MODEL: "${name}" (known: ${Object.keys(EMBED_REGISTRY).join(", ")})`,
    );
  }
  return cfg;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/embed/registry.ts core/test/registry.test.ts
git commit -m "feat(embed): embedder registry (bge-large + mxbai configs)"
```

---

### Task 2: Model-aware `embedTexts`

**Files:**
- Modify: `core/src/embed/model.ts`
- Test: `core/test/embed.model.test.ts` (infra; first run downloads mxbai weights)

**Interfaces:**
- Consumes: `resolveEmbedConfig` (`./registry.js`).
- Produces: `EMBED_MODEL: string` (env `EMBED_MODEL`, default `"bge-large-en-v1.5"`); `EMBED_DIM = 1024`; `embedTexts(texts: string[], opts: { kind: "query" | "passage"; model?: string }): Promise<number[][]>` — uses the registry's repo/pooling/prefix; per-model lazy singleton; `model` defaults to `EMBED_MODEL`.

- [ ] **Step 1: Add the failing mxbai test case**

Append this test to `core/test/embed.model.test.ts` (keep the two existing bge tests unchanged):
```ts
import { embedTexts, EMBED_DIM } from "../src/embed/model.js";
// ^ existing import line — do not duplicate; shown for context.

it("loads a second registry model (mxbai) → normalized 1024-d, distinct from bge", async () => {
  const [m] = await embedTexts(["governing law"], { kind: "passage", model: "mxbai-embed-large-v1" });
  expect(m).toHaveLength(EMBED_DIM);
  const norm = Math.sqrt(m.reduce((s, x) => s + x * x, 0));
  expect(norm).toBeCloseTo(1, 2);
  const [b] = await embedTexts(["governing law"], { kind: "passage", model: "bge-large-en-v1.5" });
  expect(m).not.toEqual(b);
}, 300_000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/embed.model.test.ts -t "second registry model"`
Expected: FAIL — `embedTexts` doesn't accept a `model` option yet (TS error or the option is ignored so `m` equals `b`).

- [ ] **Step 3: Make `model.ts` model-aware**

Replace the entire contents of `core/src/embed/model.ts` with:
```ts
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { resolveEmbedConfig } from "./registry.js";

/** Active embedder, env-selectable. Default keeps the P1/P2a baseline reproducible. */
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "bge-large-en-v1.5";
export const EMBED_DIM = 1024;

// One lazy singleton pipeline per model name (a model swap must not reuse another's weights).
const _extractors = new Map<string, Promise<FeatureExtractionPipeline>>();
function extractor(model: string): Promise<FeatureExtractionPipeline> {
  let p = _extractors.get(model);
  if (!p) {
    const cfg = resolveEmbedConfig(model);
    // Cast needed: `pipeline()` v3 returns a union too complex for tsc (TS2590).
    p = pipeline("feature-extraction", cfg.repo, { dtype: "fp32" }) as unknown as Promise<FeatureExtractionPipeline>;
    _extractors.set(model, p);
  }
  return p;
}

export async function embedTexts(
  texts: string[],
  opts: { kind: "query" | "passage"; model?: string },
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const name = opts.model ?? EMBED_MODEL;
  const cfg = resolveEmbedConfig(name);
  const inputs = opts.kind === "query" ? texts.map((t) => cfg.queryPrefix + t) : texts;
  const out = await (await extractor(name))(inputs, { pooling: cfg.pooling, normalize: true });
  return out.tolist() as number[][];
}
```

- [ ] **Step 4: Run the tests to verify they pass** (first run downloads mxbai — slow)

Run: `npx vitest run test/embed.model.test.ts`
Expected: PASS (3 tests — the two existing bge tests + the new mxbai test). If vitest prints all passed before a teardown `mutex lock failed` line, that's the known cosmetic exit crash, not a failure.
Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add core/src/embed/model.ts core/test/embed.model.test.ts
git commit -m "feat(embed): model-aware embedTexts via registry (per-model singleton)"
```

---

### Task 3: Composite-key migration + model-aware `indexClauses`

**Files:**
- Create: `core/migrations/0006_embeddings_model_pk.sql`
- Modify: `core/src/embed/indexClauses.ts`
- Modify: `core/src/embed/cli.ts`
- Test: `core/test/indexClauses.model.test.ts` (DB-backed; uses bge — cached from Task 2)

**Interfaces:**
- Consumes: `EMBED_MODEL` (`./model.js`), `withClient`, `toVectorLiteral`.
- Produces: `indexAllClauses({ batchSize?, docId? })` unchanged signature, now model-scoped (skip + upsert on `(node_id, model)` using `EMBED_MODEL`).

- [ ] **Step 1: Write the failing test**

Create `core/test/indexClauses.model.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withClient } from "../src/db/client.js";
import { indexAllClauses } from "../src/embed/indexClauses.js";
import { EMBED_DIM } from "../src/embed/model.js";

const DOC = "idxmodeltest_doc";
const N0 = `${DOC}::n0`;
const TEXT = "This Agreement is governed by the laws of New York.";
const vec = (fill: number) => "[" + Array(EMBED_DIM).fill(fill).join(",") + "]";

async function cleanup() {
  await withClient((c) => c.query("DELETE FROM documents WHERE doc_id = $1", [DOC]));
}

describe("indexAllClauses (model-aware)", () => {
  beforeAll(async () => {
    await cleanup();
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO documents (doc_id, source, title, contract_type, raw_text, char_length, raw_sha256)
         VALUES ($1,'cuad','t','nda',$2,$3,'x') ON CONFLICT (doc_id) DO NOTHING`,
        [DOC, TEXT, TEXT.length],
      );
      await c.query(
        `INSERT INTO clauses (node_id, doc_id, parent_id, type, number, heading, text, char_start, char_end, depth)
         VALUES ($1,$2,NULL,'section',NULL,NULL,$3,0,$4,0) ON CONFLICT (node_id) DO NOTHING`,
        [N0, DOC, TEXT, TEXT.length],
      );
    });
  });
  afterAll(cleanup);

  it("the composite key lets one node hold two models' vectors", async () => {
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO embeddings (node_id, model, embedding) VALUES ($1,'bge-large-en-v1.5',$2::vector)
         ON CONFLICT (node_id, model) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [N0, vec(0.01)],
      );
      await c.query(
        `INSERT INTO embeddings (node_id, model, embedding) VALUES ($1,'mxbai-embed-large-v1',$2::vector)
         ON CONFLICT (node_id, model) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [N0, vec(0.02)],
      );
      const r = await c.query("SELECT count(*)::int AS n FROM embeddings WHERE node_id = $1", [N0]);
      expect(r.rows[0].n).toBe(2);
    });
  });

  it("skips clauses already embedded with the active model (no re-embed)", async () => {
    // N0 already has a bge-large-en-v1.5 row from the previous test; default EMBED_MODEL is bge.
    const { embedded } = await indexAllClauses({ docId: DOC });
    expect(embedded).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/indexClauses.model.test.ts`
Expected: FAIL — first test errors because the `(node_id, model)` PK doesn't exist yet (`ON CONFLICT (node_id, model)` has no matching unique constraint), and/or the second test re-embeds because the skip still keys on `node_id` only.

- [ ] **Step 3: Create + apply the migration**

Create `core/migrations/0006_embeddings_model_pk.sql`:
```sql
-- Hold multiple embedders' vectors per clause: PK (node_id) -> (node_id, model).
-- Existing rows already carry model='bge-large-en-v1.5', so this is non-destructive.
-- The vector(1024) column and HNSW index are unchanged (both registry models are 1024-dim).
ALTER TABLE embeddings DROP CONSTRAINT IF EXISTS embeddings_pkey;
ALTER TABLE embeddings ADD PRIMARY KEY (node_id, model);
```
Run: `npm run migrate`
Expected: `applied: 0006_embeddings_model_pk.sql`

- [ ] **Step 4: Make `indexClauses.ts` model-scoped**

Replace the entire contents of `core/src/embed/indexClauses.ts` with:
```ts
import { withClient } from "../db/client.js";
import { toVectorLiteral } from "../db/vector.js";
import { embedTexts, EMBED_MODEL } from "./model.js";

export async function indexAllClauses(
  opts: { batchSize?: number; docId?: string } = {},
): Promise<{ embedded: number }> {
  const batchSize = opts.batchSize ?? 32;
  // Skip clauses already embedded WITH THE ACTIVE MODEL (the join is model-scoped),
  // so switching EMBED_MODEL re-embeds rather than no-ops.
  const where = opts.docId
    ? "WHERE e.node_id IS NULL AND c.doc_id = $2"
    : "WHERE e.node_id IS NULL";
  const params = opts.docId ? [EMBED_MODEL, opts.docId] : [EMBED_MODEL];
  const rows = (
    await withClient((c) =>
      c.query<{ node_id: string; text: string }>(
        `SELECT c.node_id, c.text
         FROM clauses c
         LEFT JOIN embeddings e ON e.node_id = c.node_id AND e.model = $1
         ${where}
         ORDER BY c.node_id`,
        params,
      ),
    )
  ).rows;

  let embedded = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const vecs = await embedTexts(batch.map((r) => r.text), { kind: "passage" });
    await withClient(async (c) => {
      for (let j = 0; j < batch.length; j++) {
        await c.query(
          `INSERT INTO embeddings (node_id, model, embedding)
           VALUES ($1, $2, $3::vector)
           ON CONFLICT (node_id, model) DO UPDATE SET embedding = EXCLUDED.embedding`,
          [batch[j].node_id, EMBED_MODEL, toVectorLiteral(vecs[j])],
        );
        embedded += 1;
      }
    });
    process.stderr.write(`embedded ${Math.min(i + batchSize, rows.length)}/${rows.length}\n`);
  }
  return { embedded };
}
```

- [ ] **Step 5: Update the embed CLI log to the active model**

Replace the entire contents of `core/src/embed/cli.ts` with:
```ts
import { indexAllClauses } from "./indexClauses.js";
import { EMBED_MODEL } from "./model.js";

const { embedded } = await indexAllClauses();
console.log(`embedded ${embedded} clauses (model=${EMBED_MODEL})`);
process.exit(0);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/indexClauses.model.test.ts`
Expected: PASS (2 tests).
Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add core/migrations/0006_embeddings_model_pk.sql core/src/embed/indexClauses.ts core/src/embed/cli.ts core/test/indexClauses.model.test.ts
git commit -m "feat(embed): (node_id,model) composite key + model-scoped indexAllClauses"
```

---

### Task 4: Model-aware dense retrieval

**Files:**
- Modify: `core/src/retrieve/dense.ts`
- Test: `core/test/dense.model.test.ts` (DB-backed; uses bge — cached)

**Interfaces:**
- Consumes: `EMBED_MODEL`, `embedTexts` (`../embed/model.js`), `withClient`, `toVectorLiteral`, `Candidate` (`./types.js`).
- Produces: `denseRetrieve(query, docId, n)` unchanged signature; the cosine query now filters `e.model = EMBED_MODEL`.

- [ ] **Step 1: Write the failing test**

Create `core/test/dense.model.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withClient } from "../src/db/client.js";
import { denseRetrieve } from "../src/retrieve/dense.js";
import { EMBED_DIM } from "../src/embed/model.js";

const DOC = "densemodeltest_doc";
const N0 = `${DOC}::n0`;
const TEXT = "This Agreement is governed by the laws of New York.";
const vec = (fill: number) => "[" + Array(EMBED_DIM).fill(fill).join(",") + "]";

async function cleanup() {
  await withClient((c) => c.query("DELETE FROM documents WHERE doc_id = $1", [DOC]));
}

describe("denseRetrieve model filter", () => {
  beforeAll(async () => {
    await cleanup();
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO documents (doc_id, source, title, contract_type, raw_text, char_length, raw_sha256)
         VALUES ($1,'cuad','t','nda',$2,$3,'x') ON CONFLICT (doc_id) DO NOTHING`,
        [DOC, TEXT, TEXT.length],
      );
      await c.query(
        `INSERT INTO clauses (node_id, doc_id, parent_id, type, number, heading, text, char_start, char_end, depth)
         VALUES ($1,$2,NULL,'section',NULL,NULL,$3,0,$4,0) ON CONFLICT (node_id) DO NOTHING`,
        [N0, DOC, TEXT, TEXT.length],
      );
      // Same node, two models' vectors. Without an e.model filter the JOIN would return N0 twice.
      await c.query(
        `INSERT INTO embeddings (node_id, model, embedding) VALUES ($1,'bge-large-en-v1.5',$2::vector)
         ON CONFLICT (node_id, model) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [N0, vec(0.01)],
      );
      await c.query(
        `INSERT INTO embeddings (node_id, model, embedding) VALUES ($1,'other-model',$2::vector)
         ON CONFLICT (node_id, model) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [N0, vec(0.02)],
      );
    });
  });
  afterAll(cleanup);

  it("returns each node once for the active model (no duplicate from the other model's row)", async () => {
    const hits = await denseRetrieve("governing law", DOC, 5); // active EMBED_MODEL defaults to bge
    const ids = hits.map((h) => h.node_id);
    expect(ids).toContain(N0);
    expect(ids.filter((id) => id === N0)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/dense.model.test.ts`
Expected: FAIL — without the `e.model` filter the JOIN yields two rows for `N0` (one per model), so `N0` appears twice and the length assertion fails.

- [ ] **Step 3: Add the model filter to `dense.ts`**

Replace the entire contents of `core/src/retrieve/dense.ts` with:
```ts
import { withClient } from "../db/client.js";
import { toVectorLiteral } from "../db/vector.js";
import { embedTexts, EMBED_MODEL } from "../embed/model.js";
import type { Candidate } from "./types.js";

/** Document-scoped dense retrieval: cosine top-n over pgvector, for the active embedder. */
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
         WHERE c.doc_id = $2 AND e.model = $3
         ORDER BY e.embedding <=> $1::vector
         LIMIT $4`,
        [lit, docId, EMBED_MODEL, n],
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/dense.model.test.ts`
Expected: PASS (1 test).
Run: `npx vitest run test/retrieve.test.ts` (DB up; default EMBED_MODEL = bge → existing rows match)
Expected: PASS (2 tests) — naive retrieval unchanged for the default model.
Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add core/src/retrieve/dense.ts core/test/dense.model.test.ts
git commit -m "feat(retrieve): filter dense retrieval by active embedding model"
```

---

### Task 5: Eval provenance (`embed_model`) + `EVAL_OUT` override

**Files:**
- Modify: `core/src/eval/cli.ts` (the `run` branch only)

**Interfaces:**
- Behavior: the `run` branch stamps `embed_model` into the report and writes to `process.env.EVAL_OUT` if set (else the existing mode-based name). No signature changes.

- [ ] **Step 1: Stamp `embed_model` and honor `EVAL_OUT`**

In `core/src/eval/cli.ts`, inside the `cmd === "run"` branch, change the provenance + output block. Replace:
```ts
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
```
with:
```ts
  // Provenance: provider/model match makeGenerator(); retrieve_mode/rerank_model/embed_model record config.
  const provider = process.env.LLM_PROVIDER ?? "openai";
  const model = process.env.LLM_MODEL ?? null;
  const rerank_model = mode === "hybrid" ? (process.env.RERANK_MODEL ?? "Xenova/ms-marco-MiniLM-L-6-v2") : null;
  const embed_model = process.env.EMBED_MODEL ?? "bge-large-en-v1.5";

  // EVAL_OUT overrides the report filename so a benchmark run doesn't clobber baseline.json/p2a.json.
  const outName = process.env.EVAL_OUT ?? (mode === "hybrid" ? "p2a.json" : "baseline.json");
  mkdirSync(`${root}evals/reports`, { recursive: true });
  writeFileSync(
    `${root}evals/reports/${outName}`,
    JSON.stringify({ provider, model, retrieve_mode: mode, rerank_model, embed_model, ...report }, null, 2) + "\n",
  );

  console.log(JSON.stringify({ retrieve_mode: mode, embed_model, k: report.k, total: report.total, aggregates: report.aggregates }, null, 2));
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean. (This is small CLI wiring; it is exercised end-to-end by the Task 6 eval gate, which writes `p2b-mxbai.json` via `EVAL_OUT`.)

- [ ] **Step 3: Commit**

```bash
git add core/src/eval/cli.ts
git commit -m "feat(eval): stamp embed_model + EVAL_OUT report-filename override"
```

---

### Task 6: Run the embedder-comparison eval gate

**Files:**
- Produces: `evals/reports/p2b-mxbai.json`
- Modify: append a "Results (P2b)" section to `docs/superpowers/specs/2026-06-28-p2b-embedder-comparison-design.md`

The **merge gate** (CLAUDE.md). Controller-run on the user's infra (DB up, mxbai weights, working LLM provider). Not a unit test — a measurement.

- [ ] **Step 1: Ensure infra**

Run: `make db-up` (if needed), then from `core/`: `npm run migrate`
Expected: migrations through `0006` applied. `.env` has a working `LLM_PROVIDER`/`LLM_MODEL` (e.g. `meta/llama-3.3-70b-instruct`).

- [ ] **Step 2: Re-embed the corpus as mxbai** (~30–60 min; resumable)

Run: `EMBED_MODEL=mxbai-embed-large-v1 npm run embed`
Expected: `embedded N/5792` progress; final `embedded <N> clauses (model=mxbai-embed-large-v1)`. The `(node_id, model)` skip means bge-large vectors are untouched and a re-run resumes. (An onnxruntime teardown crash on exit is the known cosmetic artifact.)

- [ ] **Step 3: Run the eval in naive mode with mxbai active**

Run: `EMBED_MODEL=mxbai-embed-large-v1 RETRIEVE_MODE=naive EVAL_OUT=p2b-mxbai.json npm run eval -- run`
Expected: `item X/50` progress; writes `evals/reports/p2b-mxbai.json` with `"embed_model": "mxbai-embed-large-v1"`, `"retrieve_mode": "naive"`, `"errored": 0`.

- [ ] **Step 4: Print the delta table**

Run: `npm run eval -- compare baseline.json p2b-mxbai.json`
Expected: a table — recall@k, ndcg@k, groundedness, refusal_rate, false_negative_rate, each `baseline → candidate (delta)`. (Note: `baseline.json` is bge-large naive; both are naive, so the delta isolates the embedder.)

- [ ] **Step 5: Record results + apply the decision rule**

Append a "## Results (P2b)" section to the design doc with the delta table. **Decision rule:** if mxbai lifts recall@8 / NDCG (groundedness holding ~1.0) → adopt mxbai as the default dense embedder (record the decision; set `EMBED_MODEL=mxbai-embed-large-v1` in `.env`; the hybrid pipeline inherits it). If flat/worse → keep bge-large; record the measured null and that it argues for/against the paid legal embedder in a future slice.

- [ ] **Step 6: Commit**

```bash
git add evals/reports/p2b-mxbai.json docs/superpowers/specs/2026-06-28-p2b-embedder-comparison-design.md
git commit -m "eval(p2b): record bge-large vs mxbai embedder delta"
```

---

## Self-Review

**Spec coverage:**
- Model registry (bge + mxbai) → Task 1. ✓
- Model-aware embedding (per-model singleton, pooling/prefix from registry, `EMBED_MODEL` env) → Task 2. ✓
- `(node_id, model)` composite-key migration → Task 3. ✓
- Model-scoped embed (skip + upsert on `(node_id, model)`; fixes the phase-1 footgun) → Task 3. ✓
- Model-aware dense retrieval (filter `e.model`) → Task 4. ✓
- `embed_model` provenance + `EVAL_OUT` override → Task 5. ✓
- Naive-mode benchmark, re-embed, compare delta, decision rule → Task 6. ✓
- bge-large byte-for-byte reproducible (default model, mean pooling, same repo/prefix) → enforced in Tasks 1/2. ✓
- Out of scope (voyage-law-2, agentic loop, non-1024 dims) → not planned. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; every command has expected output. ✓

**Type consistency:** `EmbedConfig`/`resolveEmbedConfig` used identically in Tasks 1–2; `embedTexts(texts, { kind, model? })` signature consistent across Tasks 2/3/4; `EMBED_MODEL` imported from `./model.js` (Task 3) / `../embed/model.js` (Task 4); migration constraint name `embeddings_pkey` matches Postgres' default for table `embeddings`; `ON CONFLICT (node_id, model)` matches the PK added in the migration. ✓
