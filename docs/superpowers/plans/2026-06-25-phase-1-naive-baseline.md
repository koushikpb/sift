# Phase 1 — Naive Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the naive single-embedding top-k RAG baseline end-to-end — embed the Phase 0 corpus, retrieve document-scoped clauses, generate citation-grounded clause cards (or refuse), stream them over SSE in a Next.js shell, and record baseline recall@k / NDCG@10 + groundedness + refusal metrics.

**Architecture:** All logic lives in `core/` (the library): a transformers.js embedder, document-scoped pgvector retrieval, a provider-abstracted one-shot generator that cites by candidate index, and an eval harness. `app/` is a thin Next.js + SSE layer that imports `core`. The repo becomes an npm workspace so `app` can depend on `@sift/core`.

**Tech Stack:** TypeScript / Node 20, `@huggingface/transformers` (`Xenova/bge-large-en-v1.5`, 1024-dim), Postgres 16 + pgvector, `openai` SDK (NVIDIA NIM default) + `@anthropic-ai/sdk`, Next.js App Router, Zod, vitest.

## Global Constraints

- **Citation invariant:** every span is `{doc_id,char_start,char_end,quote}` with `quote === raw_text.slice(char_start,char_end)` exactly; enforced server-side before any card crosses SSE.
- **Typed payloads only:** the `ClauseCard` crossing core→UI is Zod-validated and conforms to `schemas/clause-card.schema.json` (JSON Schema is the cross-language source of truth).
- **Refuse when ungrounded:** "insufficient context" is a correct answer, not a failure.
- **Public data only.** No client data, no PII. Never commit secrets; `.env` is gitignored, `.env.example` documents keys.
- **Vector backend swappable:** all DB access goes through `core/src/db/`.
- **Embedding model:** `Xenova/bge-large-en-v1.5`, 1024-dim → matches the existing `embeddings.embedding vector(1024)` column; **no column migration**. `embeddings.model = "bge-large-en-v1.5"`.
- **Retrieval is the naive baseline:** single embedding, **document-scoped**, fixed top-k. No hybrid/rerank/agentic loop (those are P2).
- **Generation is provider-abstracted:** default OpenAI-compatible adapter → NVIDIA NIM; second Anthropic adapter; switchable by env (`LLM_PROVIDER`).
- **Evals are the gate:** `make verify-p1` is the single command that proves the phase. A baseline is recorded, not threshold-gated.
- **DB-backed tests** assume `make db-up && make migrate` has been run and `core/.env` has `DATABASE_URL` (per Phase 0). Run them from `core/`.

---

### Task 1: Root npm workspaces + core dependencies

**Files:**
- Create: `package.json` (repo root)
- Modify: `core/package.json`

**Interfaces:**
- Produces: a root npm workspace containing `core` and `app`; `@sift/core` gains an `exports` map (subpaths added by later tasks) and the P1 dependencies; an `embed` script placeholder.

- [ ] **Step 1: Create the root workspace manifest**

Create `package.json`:

```json
{
  "name": "sift",
  "private": true,
  "version": "0.0.0",
  "workspaces": ["core", "app"],
  "scripts": {
    "test:core": "npm --workspace @sift/core run test",
    "typecheck:core": "npm --workspace @sift/core run typecheck"
  }
}
```

- [ ] **Step 2: Add P1 dependencies and exports to `core/package.json`**

Modify `core/package.json` — add `@huggingface/transformers`, `openai`, `@anthropic-ai/sdk` to `dependencies`; add `ajv` to `devDependencies`; add the `embed` script; add an `exports` map (only `.` for now — later tasks add subpaths). Result:

```json
{
  "name": "@sift/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "migrate": "tsx src/db/migrate.ts",
    "load": "tsx src/load/cli.ts",
    "embed": "tsx src/embed/cli.ts",
    "eval": "tsx src/eval/cli.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.27.0",
    "@huggingface/transformers": "^3.0.0",
    "dotenv": "^16.4.5",
    "openai": "^4.67.0",
    "pg": "^8.11.5",
    "yaml": "^2.4.5",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "@types/pg": "^8.11.0",
    "ajv": "^8.17.1",
    "tsx": "^4.10.0",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 3: Create the `app` workspace placeholder**

The `app` workspace folder must exist for `npm install` to resolve the workspace, and Task 1 commits it. Create a minimal placeholder (Task 13 overwrites it with the real Next.js manifest):

Run:
```bash
mkdir -p /Users/koushik/Documents/GitHub/sift/app && \
printf '{\n  "name": "@sift/app",\n  "version": "0.0.0",\n  "private": true\n}\n' \
  > /Users/koushik/Documents/GitHub/sift/app/package.json
```

- [ ] **Step 3b: Install at the workspace root**

Run: `cd /Users/koushik/Documents/GitHub/sift && npm install`
Expected: installs successfully; creates a single root `node_modules` with `@huggingface/transformers`, `openai`, `@anthropic-ai/sdk` resolved and a `@sift/core` workspace symlink.

- [ ] **Step 4: Verify Phase 0 core still works**

Run: `cd /Users/koushik/Documents/GitHub/sift/core && npm run typecheck && npm test`
Expected: typecheck clean; all Phase 0 vitest tests pass (DB-backed tests require `make db-up && make migrate` first).

- [ ] **Step 5: Commit**

```bash
git add package.json core/package.json package-lock.json app/package.json
git commit -m "build(P1): root npm workspaces + core deps (transformers.js, openai, anthropic, ajv)"
```

---

### Task 2: Embedding model + vector literal helper

**Files:**
- Create: `core/src/db/vector.ts`
- Create: `core/src/embed/model.ts`
- Test: `core/test/embed.model.test.ts`

**Interfaces:**
- Produces: `embedTexts(texts: string[], opts: { kind: "query" | "passage" }): Promise<number[][]>`; `EMBED_MODEL = "bge-large-en-v1.5"`; `EMBED_DIM = 1024`; `toVectorLiteral(vec: number[]): string` (formats `'[v1,v2,...]'` for pgvector).

- [ ] **Step 1: Write the vector helper**

Create `core/src/db/vector.ts`:

```ts
/** Format a numeric vector as a pgvector literal: '[v1,v2,...]'. Use with `$n::vector`. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
```

- [ ] **Step 2: Write the failing embedding test**

Create `core/test/embed.model.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { embedTexts, EMBED_DIM } from "../src/embed/model.js";

// First run downloads the bge-large-en-v1.5 ONNX weights (~hundreds of MB), then caches them.
describe("embedTexts", () => {
  it("returns one L2-normalized 1024-d vector per text", async () => {
    const vecs = await embedTexts(["confidential information"], { kind: "passage" });
    expect(vecs).toHaveLength(1);
    expect(vecs[0]).toHaveLength(EMBED_DIM);
    const norm = Math.sqrt(vecs[0].reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 2);
  }, 120_000);

  it("applies the query instruction only to queries (query != passage embedding)", async () => {
    const [q] = await embedTexts(["governing law"], { kind: "query" });
    const [p] = await embedTexts(["governing law"], { kind: "passage" });
    expect(q).not.toEqual(p);
  }, 120_000);
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd core && npx vitest run test/embed.model.test.ts`
Expected: FAIL — cannot import `../src/embed/model.js` (module not found).

- [ ] **Step 4: Implement the embedder**

Create `core/src/embed/model.ts`:

```ts
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBED_MODEL = "bge-large-en-v1.5";
export const EMBED_DIM = 1024;

// bge models recommend a query instruction prefix for retrieval; passages are embedded raw.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

let _extractor: Promise<FeatureExtractionPipeline> | null = null;
function extractor(): Promise<FeatureExtractionPipeline> {
  return (_extractor ??= pipeline("feature-extraction", "Xenova/bge-large-en-v1.5"));
}

export async function embedTexts(
  texts: string[],
  opts: { kind: "query" | "passage" },
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const inputs = opts.kind === "query" ? texts.map((t) => QUERY_PREFIX + t) : texts;
  const out = await (await extractor())(inputs, { pooling: "mean", normalize: true });
  return out.tolist() as number[][];
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd core && npx vitest run test/embed.model.test.ts`
Expected: PASS (first run downloads + caches model weights, so it is slow; later runs are fast).

- [ ] **Step 6: Add the `./embed` export to core**

Modify `core/package.json` `exports`:

```json
  "exports": {
    ".": "./src/index.ts",
    "./embed": "./src/embed/model.ts"
  },
```

- [ ] **Step 7: Typecheck and commit**

Run: `cd core && npm run typecheck`
Expected: clean.

```bash
git add core/src/db/vector.ts core/src/embed/model.ts core/test/embed.model.test.ts core/package.json
git commit -m "feat(embed): bge-large-en-v1.5 embedder (transformers.js) + pgvector literal helper"
```

---

### Task 3: Migration 0004 (HNSW index) + clause-embedding indexer CLI

**Files:**
- Create: `core/migrations/0004_embeddings_index.sql`
- Create: `core/src/embed/indexClauses.ts`
- Create: `core/src/embed/cli.ts`
- Test: `core/test/indexClauses.test.ts`

**Interfaces:**
- Consumes: `embedTexts` (Task 2), `toVectorLiteral` (Task 2), `withClient` (`core/src/db/client.ts`).
- Produces: `indexAllClauses(opts?: { batchSize?: number; docId?: string }): Promise<{ embedded: number }>`; `npm run embed` populates the `embeddings` table.

- [ ] **Step 1: Write the migration**

Create `core/migrations/0004_embeddings_index.sql`:

```sql
-- Vectors now exist (populated by `npm run embed` in P1), so add the ANN index the 0003
-- comment deferred. HNSW with cosine ops matches the `<=>` retrieval operator.
CREATE INDEX IF NOT EXISTS embeddings_hnsw_idx
  ON embeddings USING hnsw (embedding vector_cosine_ops);
```

- [ ] **Step 2: Write the failing indexer test**

Create `core/test/indexClauses.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withClient } from "../src/db/client.js";
import { indexAllClauses } from "../src/embed/indexClauses.js";

const DOC = "idxtest_doc";

async function seed() {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO documents (doc_id, source, title, contract_type, raw_text, char_length, raw_sha256)
       VALUES ($1,'cuad','t','nda',$2,$3,'x') ON CONFLICT (doc_id) DO NOTHING`,
      [DOC, "ABCDEFGHIJ", 10],
    );
    await c.query(
      `INSERT INTO clauses (node_id, doc_id, parent_id, type, number, heading, text, char_start, char_end, depth)
       VALUES ($1,$2,NULL,'section',NULL,NULL,$3,0,10,0) ON CONFLICT (node_id) DO NOTHING`,
      [`${DOC}::n0`, DOC, "ABCDEFGHIJ"],
    );
  });
}
async function cleanup() {
  await withClient((c) => c.query("DELETE FROM documents WHERE doc_id=$1", [DOC]));
}

describe("indexAllClauses", () => {
  beforeAll(async () => { await cleanup(); await seed(); });
  afterAll(cleanup);

  it("writes a 1024-d embedding row per clause for the given doc", async () => {
    const { embedded } = await indexAllClauses({ docId: DOC });
    expect(embedded).toBe(1);
    const row = await withClient((c) =>
      c.query("SELECT model, vector_dims(embedding) AS dims FROM embeddings WHERE node_id=$1", [`${DOC}::n0`]),
    );
    expect(row.rows[0].model).toBe("bge-large-en-v1.5");
    expect(Number(row.rows[0].dims)).toBe(1024);
  }, 120_000);
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd core && npx vitest run test/indexClauses.test.ts`
Expected: FAIL — cannot import `indexClauses.js`.

- [ ] **Step 4: Implement the indexer**

Create `core/src/embed/indexClauses.ts`:

```ts
import { withClient } from "../db/client.js";
import { toVectorLiteral } from "../db/vector.js";
import { embedTexts, EMBED_MODEL } from "./model.js";

export async function indexAllClauses(
  opts: { batchSize?: number; docId?: string } = {},
): Promise<{ embedded: number }> {
  const batchSize = opts.batchSize ?? 32;
  const where = opts.docId ? "WHERE doc_id = $1" : "";
  const params = opts.docId ? [opts.docId] : [];
  const rows = (
    await withClient((c) =>
      c.query<{ node_id: string; text: string }>(
        `SELECT node_id, text FROM clauses ${where} ORDER BY node_id`,
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
           ON CONFLICT (node_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding`,
          [batch[j].node_id, EMBED_MODEL, toVectorLiteral(vecs[j])],
        );
        embedded += 1;
      }
    });
  }
  return { embedded };
}
```

- [ ] **Step 5: Implement the CLI**

Create `core/src/embed/cli.ts`:

```ts
import { indexAllClauses } from "./indexClauses.js";

const { embedded } = await indexAllClauses();
console.log(`embedded ${embedded} clauses (model=bge-large-en-v1.5)`);
process.exit(0);
```

- [ ] **Step 6: Apply the migration, then run the test**

Run: `cd /Users/koushik/Documents/GitHub/sift && make migrate && cd core && npx vitest run test/indexClauses.test.ts`
Expected: migration applies 0004; test PASSES (embedded=1, model + 1024 dims verified).

- [ ] **Step 7: Add the `./embed/index` export, typecheck, commit**

Modify `core/package.json` `exports` to add `"./embed/index": "./src/embed/indexClauses.ts"`. Then:

Run: `cd core && npm run typecheck`
Expected: clean.

```bash
git add core/migrations/0004_embeddings_index.sql core/src/embed/indexClauses.ts core/src/embed/cli.ts core/test/indexClauses.test.ts core/package.json
git commit -m "feat(embed): clause indexer CLI + HNSW vector index (migration 0004)"
```

---

### Task 4: Document-scoped top-k retrieval

**Files:**
- Create: `core/src/retrieve/retrieve.ts`
- Test: `core/test/retrieve.test.ts`

**Interfaces:**
- Consumes: `embedTexts` (Task 2), `toVectorLiteral` (Task 2), `withClient`.
- Produces: `Candidate` type and `retrieve(query: string, docId: string, k?: number): Promise<Candidate[]>` where
  `Candidate = { node_id, doc_id, type, number, heading, text, char_start, char_end, score }`.

- [ ] **Step 1: Write the failing retrieval test**

Create `core/test/retrieve.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withClient } from "../src/db/client.js";
import { indexAllClauses } from "../src/embed/indexClauses.js";
import { retrieve } from "../src/retrieve/retrieve.js";

const DOC = "rettest_doc";
const OTHER = "rettest_other";
const TEXT_A = "This Agreement shall be governed by the laws of the State of New York.";
const TEXT_B = "The Receiving Party shall return all Confidential Information upon request.";

async function seedDoc(doc: string, t0: string, t1: string) {
  const raw = t0 + "\n" + t1;
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO documents (doc_id, source, title, contract_type, raw_text, char_length, raw_sha256)
       VALUES ($1,'cuad','t','nda',$2,$3,'x') ON CONFLICT (doc_id) DO NOTHING`,
      [doc, raw, raw.length],
    );
    await c.query(
      `INSERT INTO clauses (node_id, doc_id, parent_id, type, number, heading, text, char_start, char_end, depth)
       VALUES ($1,$2,NULL,'section',NULL,NULL,$3,$4,$5,0) ON CONFLICT (node_id) DO NOTHING`,
      [`${doc}::n0`, doc, t0, 0, t0.length],
    );
    await c.query(
      `INSERT INTO clauses (node_id, doc_id, parent_id, type, number, heading, text, char_start, char_end, depth)
       VALUES ($1,$2,NULL,'section',NULL,NULL,$3,$4,$5,0) ON CONFLICT (node_id) DO NOTHING`,
      [`${doc}::n1`, doc, t1, t0.length + 1, raw.length],
    );
  });
}
async function cleanup() {
  await withClient((c) => c.query("DELETE FROM documents WHERE doc_id = ANY($1)", [[DOC, OTHER]]));
}

describe("retrieve", () => {
  beforeAll(async () => {
    await cleanup();
    await seedDoc(DOC, TEXT_A, TEXT_B);
    await seedDoc(OTHER, TEXT_A, TEXT_B);
    await indexAllClauses({ docId: DOC });
    await indexAllClauses({ docId: OTHER });
  });
  afterAll(cleanup);

  it("ranks the semantically closest clause first, with a score in [0,1]", async () => {
    const hits = await retrieve("Which state's law governs this agreement?", DOC, 2);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].node_id).toBe(`${DOC}::n0`);
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].score).toBeLessThanOrEqual(1);
  }, 120_000);

  it("is document-scoped (never returns another doc's nodes)", async () => {
    const hits = await retrieve("return of confidential information", DOC, 5);
    expect(hits.every((h) => h.doc_id === DOC)).toBe(true);
  }, 120_000);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd core && npx vitest run test/retrieve.test.ts`
Expected: FAIL — cannot import `retrieve.js`.

- [ ] **Step 3: Implement retrieval**

Create `core/src/retrieve/retrieve.ts`:

```ts
import { withClient } from "../db/client.js";
import { toVectorLiteral } from "../db/vector.js";
import { embedTexts } from "../embed/model.js";

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

/** Naive baseline: single-embedding, document-scoped cosine top-k over pgvector. */
export async function retrieve(query: string, docId: string, k = 8): Promise<Candidate[]> {
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
        [lit, docId, k],
      ),
    )
  ).rows;
  return rows.map((r) => ({
    node_id: r.node_id,
    doc_id: r.doc_id,
    type: r.type,
    number: r.number,
    heading: r.heading,
    text: r.text,
    char_start: r.char_start,
    char_end: r.char_end,
    score: Number(r.score),
  }));
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd core && npx vitest run test/retrieve.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `./retrieve` export, typecheck, commit**

Add `"./retrieve": "./src/retrieve/retrieve.ts"` to `core/package.json` `exports`. Then:

Run: `cd core && npm run typecheck`
Expected: clean.

```bash
git add core/src/retrieve/retrieve.ts core/test/retrieve.test.ts core/package.json
git commit -m "feat(retrieve): document-scoped single-embedding top-k retrieval"
```

---

### Task 5: ClauseCard schema (Zod + JSON Schema) + citation guard

**Files:**
- Create: `schemas/clause-card.schema.json`
- Create: `core/src/schemas/clauseCard.ts`
- Test: `core/test/clauseCard.test.ts`

**Interfaces:**
- Produces: `SpanSchema`, `ClauseCardSchema` (Zod, `.strict()`); types `Span`, `ClauseCard`; `assertCardCitations(card: ClauseCard, rawTextByDoc: Map<string, string>): void` (throws unless every citation's `quote === raw_text.slice(...)`).

- [ ] **Step 1: Write the JSON Schema (cross-language SOT)**

Create `schemas/clause-card.schema.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://sift/schemas/clause-card.schema.json",
  "title": "ClauseCard",
  "type": "object",
  "additionalProperties": false,
  "required": ["objective", "answer", "citations", "refused"],
  "properties": {
    "objective": { "type": "string", "minLength": 1 },
    "answer": { "type": "string" },
    "citations": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["doc_id", "char_start", "char_end", "quote"],
        "properties": {
          "doc_id": { "type": "string", "minLength": 1 },
          "char_start": { "type": "integer", "minimum": 0 },
          "char_end": { "type": "integer", "minimum": 0 },
          "quote": { "type": "string" }
        }
      }
    },
    "refused": { "type": "boolean" },
    "refusal_reason": { "type": ["string", "null"] }
  }
}
```

- [ ] **Step 2: Write the failing schema test**

Create `core/test/clauseCard.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { ClauseCardSchema, assertCardCitations, type ClauseCard } from "../src/schemas/clauseCard.js";

const valid: ClauseCard = {
  objective: "Find the governing law clause.",
  answer: "Governed by New York law.",
  citations: [{ doc_id: "d1", char_start: 0, char_end: 5, quote: "ABCDE" }],
  refused: false,
  refusal_reason: null,
};

describe("ClauseCard schema", () => {
  it("accepts a valid card and rejects unknown keys", () => {
    expect(ClauseCardSchema.parse(valid)).toEqual(valid);
    expect(() => ClauseCardSchema.parse({ ...valid, oops: 1 })).toThrow();
  });

  it("conforms to the JSON Schema source of truth (Zod ⇄ JSON Schema seam)", () => {
    const schemaPath = fileURLToPath(new URL("../../schemas/clause-card.schema.json", import.meta.url));
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf-8")));
    expect(validate(valid)).toBe(true);
    expect(validate({ ...valid, oops: 1 })).toBe(false);
  });

  it("assertCardCitations throws when a quote does not match its slice", () => {
    const raw = new Map([["d1", "ABCDEFG"]]);
    expect(() => assertCardCitations(valid, raw)).not.toThrow();
    const bad: ClauseCard = { ...valid, citations: [{ doc_id: "d1", char_start: 0, char_end: 5, quote: "ZZZZZ" }] };
    expect(() => assertCardCitations(bad, raw)).toThrow(/citation/i);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd core && npx vitest run test/clauseCard.test.ts`
Expected: FAIL — cannot import `clauseCard.js`.

- [ ] **Step 4: Implement the Zod schema + guard**

Create `core/src/schemas/clauseCard.ts`:

```ts
import { z } from "zod";

export const SpanSchema = z
  .object({
    doc_id: z.string().min(1),
    char_start: z.number().int().nonnegative(),
    char_end: z.number().int().nonnegative(),
    quote: z.string(),
  })
  .strict();

export const ClauseCardSchema = z
  .object({
    objective: z.string().min(1),
    answer: z.string(),
    citations: z.array(SpanSchema),
    refused: z.boolean(),
    refusal_reason: z.string().nullish(),
  })
  .strict();

export type Span = z.infer<typeof SpanSchema>;
export type ClauseCard = z.infer<typeof ClauseCardSchema>;

/** Throw unless every citation's quote equals its slice of the document's raw_text. */
export function assertCardCitations(card: ClauseCard, rawTextByDoc: Map<string, string>): void {
  for (const c of card.citations) {
    const raw = rawTextByDoc.get(c.doc_id);
    if (raw == null) throw new Error(`citation integrity: unknown doc ${c.doc_id}`);
    if (raw.slice(c.char_start, c.char_end) !== c.quote) {
      throw new Error(`citation integrity violation in ${c.doc_id} [${c.char_start},${c.char_end})`);
    }
  }
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd core && npx vitest run test/clauseCard.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the `./schemas` export, typecheck, commit**

Add `"./schemas": "./src/schemas/clauseCard.ts"` to `core/package.json` `exports`. Then:

Run: `cd core && npm run typecheck`
Expected: clean.

```bash
git add schemas/clause-card.schema.json core/src/schemas/clauseCard.ts core/test/clauseCard.test.ts core/package.json
git commit -m "feat(schemas): ClauseCard Zod + JSON Schema + citation-integrity guard"
```

---

### Task 6: Generation core — types, prompt, JSON parse, toClauseCard

**Files:**
- Create: `core/src/generate/types.ts`
- Create: `core/src/generate/prompt.ts`
- Create: `core/src/generate/toClauseCard.ts`
- Test: `core/test/generate.core.test.ts`

**Interfaces:**
- Consumes: `Candidate` (Task 4), `ClauseCard`/`Span` (Task 5).
- Produces:
  - `types.ts`: `GenInput = { objective: string; candidates: Candidate[] }`; `RawGen = { answer: string; supporting: number[]; refused: boolean; refusal_reason?: string | null }`; `interface Generator { generate(input: GenInput): Promise<RawGen> }`.
  - `prompt.ts`: `buildPrompt(input: GenInput): { system: string; user: string }`; `extractJsonObject(text: string): unknown`; `parseRawGen(text: string): RawGen`.
  - `toClauseCard.ts`: `toClauseCard(objective: string, raw: RawGen, candidates: Candidate[]): ClauseCard`.

- [ ] **Step 1: Write the types**

Create `core/src/generate/types.ts`:

```ts
import type { Candidate } from "../retrieve/retrieve.js";

export interface GenInput {
  objective: string;
  candidates: Candidate[];
}

export interface RawGen {
  answer: string;
  supporting: number[];
  refused: boolean;
  refusal_reason?: string | null;
}

export interface Generator {
  generate(input: GenInput): Promise<RawGen>;
}
```

- [ ] **Step 2: Write the failing core test**

Create `core/test/generate.core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPrompt, extractJsonObject, parseRawGen } from "../src/generate/prompt.js";
import { toClauseCard } from "../src/generate/toClauseCard.js";
import type { Candidate } from "../src/retrieve/retrieve.js";

const cands: Candidate[] = [
  { node_id: "d::0", doc_id: "d", type: "section", number: "1", heading: null, text: "Governed by New York law.", char_start: 0, char_end: 25, score: 0.9 },
  { node_id: "d::1", doc_id: "d", type: "section", number: "2", heading: null, text: "Term is three years.", char_start: 26, char_end: 46, score: 0.5 },
];

describe("buildPrompt", () => {
  it("numbers candidates and instructs index-citation + refusal", () => {
    const { system, user } = buildPrompt({ objective: "What law governs?", candidates: cands });
    expect(system).toMatch(/insufficient context/i);
    expect(user).toContain("[0]");
    expect(user).toContain("Governed by New York law.");
    expect(user).toContain("What law governs?");
  });
});

describe("extractJsonObject", () => {
  it("parses raw JSON, fenced JSON, and JSON with preamble", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Sure!\n{"a":1}\nDone')).toEqual({ a: 1 });
  });
});

describe("parseRawGen", () => {
  it("coerces a valid object and defaults a garbage response to a refusal", () => {
    expect(parseRawGen('{"answer":"x","supporting":[0],"refused":false}')).toEqual({
      answer: "x", supporting: [0], refused: false, refusal_reason: null,
    });
    expect(parseRawGen("not json at all").refused).toBe(true);
  });
});

describe("toClauseCard", () => {
  it("maps supporting indices to exact candidate spans", () => {
    const card = toClauseCard("What law governs?", { answer: "NY law.", supporting: [0], refused: false }, cands);
    expect(card.refused).toBe(false);
    expect(card.citations).toEqual([{ doc_id: "d", char_start: 0, char_end: 25, quote: "Governed by New York law." }]);
  });

  it("drops out-of-range / duplicate indices and refuses when none remain", () => {
    const card = toClauseCard("q", { answer: "x", supporting: [9, 9], refused: false }, cands);
    expect(card.refused).toBe(true);
    expect(card.citations).toEqual([]);
  });

  it("passes through an explicit refusal", () => {
    const card = toClauseCard("q", { answer: "", supporting: [], refused: true, refusal_reason: "nope" }, cands);
    expect(card).toMatchObject({ refused: true, citations: [], answer: "" });
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd core && npx vitest run test/generate.core.test.ts`
Expected: FAIL — cannot import `prompt.js` / `toClauseCard.js`.

- [ ] **Step 4: Implement the prompt + parser**

Create `core/src/generate/prompt.ts`:

```ts
import { z } from "zod";
import type { GenInput, RawGen } from "./types.js";

const SYSTEM = [
  "You are a contract-review assistant. Answer ONLY from the numbered candidate clauses provided.",
  "Cite support by listing the candidate indices in `supporting`. Do not invent clauses or facts.",
  "If the candidates do not contain enough information to answer, set `refused` to true and explain in",
  "`refusal_reason` — replying \"insufficient context\" is correct and expected.",
  'Reply with ONLY a JSON object: {"answer": string, "supporting": number[], "refused": boolean, "refusal_reason": string|null}.',
].join(" ");

export function buildPrompt(input: GenInput): { system: string; user: string } {
  const lines = input.candidates.map(
    (c, i) => `[${i}] (${c.doc_id}, chars ${c.char_start}-${c.char_end}) ${c.text}`,
  );
  const user = `Objective: ${input.objective}\n\nCandidate clauses:\n${lines.join("\n")}`;
  return { system: SYSTEM, user };
}

/** Extract the first balanced JSON object from a model response (tolerates fences/preamble). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON object found");
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error("unbalanced JSON object");
}

const RawGenSchema = z.object({
  answer: z.string().catch(""),
  supporting: z.array(z.number()).catch([]),
  refused: z.boolean().catch(false),
  refusal_reason: z.string().nullish(),
});

/** Parse a model response into RawGen; any failure becomes a safe refusal. */
export function parseRawGen(text: string): RawGen {
  try {
    const obj = RawGenSchema.parse(extractJsonObject(text));
    return {
      answer: obj.answer,
      supporting: obj.supporting.filter((n) => Number.isInteger(n)),
      refused: obj.refused,
      refusal_reason: obj.refusal_reason ?? null,
    };
  } catch {
    return { answer: "", supporting: [], refused: true, refusal_reason: "could not parse model output" };
  }
}
```

- [ ] **Step 5: Implement toClauseCard**

Create `core/src/generate/toClauseCard.ts`:

```ts
import type { Candidate } from "../retrieve/retrieve.js";
import type { ClauseCard } from "../schemas/clauseCard.js";
import type { RawGen } from "./types.js";

/**
 * Build a ClauseCard from a raw generation. Citations are derived from the model's chosen
 * candidate indices and the candidates' known-good spans, so every citation resolves by
 * construction. If the model refused, or no valid citation survives, return a refusal.
 */
export function toClauseCard(objective: string, raw: RawGen, candidates: Candidate[]): ClauseCard {
  if (raw.refused) {
    return { objective, answer: "", citations: [], refused: true, refusal_reason: raw.refusal_reason ?? "insufficient context" };
  }
  const seen = new Set<number>();
  const citations = [];
  for (const idx of raw.supporting) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length || seen.has(idx)) continue;
    seen.add(idx);
    const c = candidates[idx];
    citations.push({ doc_id: c.doc_id, char_start: c.char_start, char_end: c.char_end, quote: c.text });
  }
  if (citations.length === 0) {
    return { objective, answer: "", citations: [], refused: true, refusal_reason: "insufficient context" };
  }
  return { objective, answer: raw.answer, citations, refused: false, refusal_reason: null };
}
```

- [ ] **Step 6: Run the test to confirm it passes**

Run: `cd core && npx vitest run test/generate.core.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `cd core && npm run typecheck`
Expected: clean.

```bash
git add core/src/generate/types.ts core/src/generate/prompt.ts core/src/generate/toClauseCard.ts core/test/generate.core.test.ts
git commit -m "feat(generate): prompt builder, tolerant JSON parse, index-referenced clause cards"
```

---

### Task 7: OpenAI-compatible adapter + generator factory

**Files:**
- Create: `core/src/generate/openaiCompat.ts`
- Create: `core/src/generate/index.ts`
- Test: `core/test/generate.openai.test.ts`

**Interfaces:**
- Consumes: `Generator`, `GenInput`, `RawGen` (Task 6); `buildPrompt`, `parseRawGen` (Task 6).
- Produces:
  - `makeOpenAICompatGenerator(opts?: { client?: ChatClient; model?: string }): Generator` where `ChatClient` is a minimal interface over `client.chat.completions.create`.
  - `index.ts`: `makeGenerator(): Generator` — selects adapter from env (`LLM_PROVIDER`, default `"openai"`); re-exports `Generator`, `GenInput`, `RawGen`, `buildPrompt`, `parseRawGen`, `toClauseCard`.

- [ ] **Step 1: Write the failing adapter test (mocked client)**

Create `core/test/generate.openai.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { makeOpenAICompatGenerator } from "../src/generate/openaiCompat.js";
import type { Candidate } from "../src/retrieve/retrieve.js";

const cands: Candidate[] = [
  { node_id: "d::0", doc_id: "d", type: "section", number: null, heading: null, text: "Governed by NY law.", char_start: 0, char_end: 19, score: 0.9 },
];

describe("makeOpenAICompatGenerator", () => {
  it("sends model + system/user messages and parses the JSON response into RawGen", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"answer":"NY law.","supporting":[0],"refused":false}' } }],
    });
    const gen = makeOpenAICompatGenerator({ client: { chat: { completions: { create } } }, model: "test-model" });
    const raw = await gen.generate({ objective: "What law governs?", candidates: cands });

    expect(raw).toMatchObject({ answer: "NY law.", supporting: [0], refused: false });
    const arg = create.mock.calls[0][0];
    expect(arg.model).toBe("test-model");
    expect(arg.messages[0].role).toBe("system");
    expect(arg.messages[1].content).toContain("[0]");
  });

  it("returns a refusal when the response is unparseable", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "garbage" } }] });
    const gen = makeOpenAICompatGenerator({ client: { chat: { completions: { create } } }, model: "m" });
    const raw = await gen.generate({ objective: "q", candidates: cands });
    expect(raw.refused).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd core && npx vitest run test/generate.openai.test.ts`
Expected: FAIL — cannot import `openaiCompat.js`.

- [ ] **Step 3: Implement the adapter**

Create `core/src/generate/openaiCompat.ts`:

```ts
import OpenAI from "openai";
import { buildPrompt, parseRawGen } from "./prompt.js";
import type { GenInput, Generator, RawGen } from "./types.js";

/** Minimal surface of the OpenAI chat client, so tests can inject a fake. */
export interface ChatClient {
  chat: {
    completions: {
      create(args: {
        model: string;
        messages: { role: "system" | "user"; content: string }[];
        temperature?: number;
      }): Promise<{ choices: { message: { content: string | null } }[] }>;
    };
  };
}

export function makeOpenAICompatGenerator(opts: { client?: ChatClient; model?: string } = {}): Generator {
  const model = opts.model ?? process.env.LLM_MODEL ?? "moonshotai/kimi-k2-instruct";
  const client: ChatClient =
    opts.client ??
    (new OpenAI({
      baseURL: process.env.LLM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
      apiKey: process.env.LLM_API_KEY ?? "",
    }) as unknown as ChatClient);

  return {
    async generate(input: GenInput): Promise<RawGen> {
      const { system, user } = buildPrompt(input);
      const resp = await client.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      return parseRawGen(resp.choices[0]?.message?.content ?? "");
    },
  };
}
```

- [ ] **Step 4: Implement the factory**

Create `core/src/generate/index.ts`:

```ts
import { makeOpenAICompatGenerator } from "./openaiCompat.js";
import type { Generator } from "./types.js";

/** Select the generation provider from env. `anthropic` is added in Task 8. */
export function makeGenerator(): Generator {
  const provider = process.env.LLM_PROVIDER ?? "openai";
  if (provider === "openai") return makeOpenAICompatGenerator();
  throw new Error(`unknown LLM_PROVIDER: ${provider}`);
}

export type { Generator, GenInput, RawGen } from "./types.js";
export { buildPrompt, parseRawGen, extractJsonObject } from "./prompt.js";
export { toClauseCard } from "./toClauseCard.js";
export { makeOpenAICompatGenerator } from "./openaiCompat.js";
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd core && npx vitest run test/generate.openai.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the `./generate` export, typecheck, commit**

Add `"./generate": "./src/generate/index.ts"` to `core/package.json` `exports`. Then:

Run: `cd core && npm run typecheck`
Expected: clean.

```bash
git add core/src/generate/openaiCompat.ts core/src/generate/index.ts core/test/generate.openai.test.ts core/package.json
git commit -m "feat(generate): OpenAI-compatible adapter (NVIDIA NIM default) + provider factory"
```

---

### Task 8: Anthropic adapter

**Files:**
- Create: `core/src/generate/anthropic.ts`
- Modify: `core/src/generate/index.ts`
- Test: `core/test/generate.anthropic.test.ts`

**Interfaces:**
- Consumes: `Generator`, `GenInput`, `RawGen` (Task 6); `buildPrompt`, `parseRawGen` (Task 6).
- Produces: `makeAnthropicGenerator(opts?: { client?: AnthropicClient; model?: string }): Generator`; `makeGenerator()` now routes `LLM_PROVIDER=anthropic` to it. Default model `claude-sonnet-4-6`.

> **Before implementing:** invoke the `claude-api` skill and follow it for the exact `@anthropic-ai/sdk` Messages API call shape, the current model id, and JSON-output handling. The code below is the target shape; reconcile it with the skill.

- [ ] **Step 1: Write the failing adapter test (mocked client)**

Create `core/test/generate.anthropic.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { makeAnthropicGenerator } from "../src/generate/anthropic.js";
import type { Candidate } from "../src/retrieve/retrieve.js";

const cands: Candidate[] = [
  { node_id: "d::0", doc_id: "d", type: "section", number: null, heading: null, text: "Governed by NY law.", char_start: 0, char_end: 19, score: 0.9 },
];

describe("makeAnthropicGenerator", () => {
  it("sends model + system + user message and parses the response into RawGen", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"answer":"NY law.","supporting":[0],"refused":false}' }],
    });
    const gen = makeAnthropicGenerator({ client: { messages: { create } }, model: "claude-sonnet-4-6" });
    const raw = await gen.generate({ objective: "What law governs?", candidates: cands });

    expect(raw).toMatchObject({ answer: "NY law.", supporting: [0], refused: false });
    const arg = create.mock.calls[0][0];
    expect(arg.model).toBe("claude-sonnet-4-6");
    expect(typeof arg.system).toBe("string");
    expect(arg.messages[0].content).toContain("[0]");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd core && npx vitest run test/generate.anthropic.test.ts`
Expected: FAIL — cannot import `anthropic.js`.

- [ ] **Step 3: Implement the adapter** (reconcile with the `claude-api` skill)

Create `core/src/generate/anthropic.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { buildPrompt, parseRawGen } from "./prompt.js";
import type { GenInput, Generator, RawGen } from "./types.js";

/** Minimal surface of the Anthropic Messages client, so tests can inject a fake. */
export interface AnthropicClient {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: "user"; content: string }[];
    }): Promise<{ content: { type: string; text?: string }[] }>;
  };
}

export function makeAnthropicGenerator(opts: { client?: AnthropicClient; model?: string } = {}): Generator {
  const model = opts.model ?? process.env.LLM_MODEL ?? "claude-sonnet-4-6";
  const client: AnthropicClient =
    opts.client ?? (new Anthropic({ apiKey: process.env.LLM_API_KEY ?? "" }) as unknown as AnthropicClient);

  return {
    async generate(input: GenInput): Promise<RawGen> {
      const { system, user } = buildPrompt(input);
      const resp = await client.messages.create({
        model,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: user }],
      });
      const text = resp.content.find((b) => b.type === "text")?.text ?? "";
      return parseRawGen(text);
    },
  };
}
```

- [ ] **Step 4: Route the factory to the new adapter**

Modify `core/src/generate/index.ts` — update `makeGenerator` and add the re-export:

```ts
import { makeOpenAICompatGenerator } from "./openaiCompat.js";
import { makeAnthropicGenerator } from "./anthropic.js";
import type { Generator } from "./types.js";

export function makeGenerator(): Generator {
  const provider = process.env.LLM_PROVIDER ?? "openai";
  if (provider === "openai") return makeOpenAICompatGenerator();
  if (provider === "anthropic") return makeAnthropicGenerator();
  throw new Error(`unknown LLM_PROVIDER: ${provider}`);
}

export type { Generator, GenInput, RawGen } from "./types.js";
export { buildPrompt, parseRawGen, extractJsonObject } from "./prompt.js";
export { toClauseCard } from "./toClauseCard.js";
export { makeOpenAICompatGenerator } from "./openaiCompat.js";
export { makeAnthropicGenerator } from "./anthropic.js";
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd core && npx vitest run test/generate.anthropic.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `cd core && npm run typecheck`
Expected: clean.

```bash
git add core/src/generate/anthropic.ts core/src/generate/index.ts core/test/generate.anthropic.test.ts
git commit -m "feat(generate): Anthropic (Claude) adapter behind LLM_PROVIDER switch"
```

---

### Task 9: Review orchestration (retrieve → generate → grounded card) + helpers

**Files:**
- Create: `core/src/review/review.ts`
- Create: `core/src/review/docs.ts`
- Create: `core/src/review/sse.ts`
- Create: `core/src/review/index.ts`
- Test: `core/test/review.test.ts`

**Interfaces:**
- Consumes: `retrieve` (Task 4), `makeGenerator`/`toClauseCard` (Tasks 6–7), `Generator`/`GenInput` (Task 6), `ClauseCard`/`assertCardCitations` (Task 5), `withClient`.
- Produces:
  - `reviewQuery(objective: string, docId: string, opts?: { k?: number; generator?: Generator }): Promise<ClauseCard>` — the single end-to-end pipeline (citations re-verified before return).
  - `listDocs(): Promise<{ doc_id: string; title: string | null; source: string }[]>`.
  - `formatSseEvent(event: string, data: unknown): string`.

- [ ] **Step 1: Write the SSE + review failing tests**

Create `core/test/review.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withClient } from "../src/db/client.js";
import { indexAllClauses } from "../src/embed/indexClauses.js";
import { reviewQuery } from "../src/review/review.js";
import { formatSseEvent } from "../src/review/sse.js";
import type { Generator } from "../src/generate/index.js";

const DOC = "revtest_doc";
const T0 = "This Agreement is governed by the laws of the State of New York.";
const T1 = "Confidential Information must be returned within thirty days.";

async function seed() {
  const raw = T0 + "\n" + T1;
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO documents (doc_id, source, title, contract_type, raw_text, char_length, raw_sha256)
       VALUES ($1,'cuad','t','nda',$2,$3,'x') ON CONFLICT (doc_id) DO NOTHING`,
      [DOC, raw, raw.length],
    );
    await c.query(
      `INSERT INTO clauses (node_id, doc_id, parent_id, type, number, heading, text, char_start, char_end, depth)
       VALUES ($1,$2,NULL,'section',NULL,NULL,$3,0,$4,0) ON CONFLICT (node_id) DO NOTHING`,
      [`${DOC}::n0`, DOC, T0, T0.length],
    );
    await c.query(
      `INSERT INTO clauses (node_id, doc_id, parent_id, type, number, heading, text, char_start, char_end, depth)
       VALUES ($1,$2,NULL,'section',NULL,NULL,$3,$4,$5,0) ON CONFLICT (node_id) DO NOTHING`,
      [`${DOC}::n1`, DOC, T1, T0.length + 1, raw.length],
    );
  });
}
async function cleanup() {
  await withClient((c) => c.query("DELETE FROM documents WHERE doc_id=$1", [DOC]));
}

// Fake generator: cite candidate 0. reviewQuery supplies real retrieved candidates.
const fakeGen: Generator = {
  async generate() {
    return { answer: "Governed by New York law.", supporting: [0], refused: false };
  },
};
const refuseGen: Generator = {
  async generate() {
    return { answer: "", supporting: [], refused: true, refusal_reason: "insufficient context" };
  },
};

describe("formatSseEvent", () => {
  it("emits an SSE frame", () => {
    expect(formatSseEvent("card", { a: 1 })).toBe('event: card\ndata: {"a":1}\n\n');
  });
});

describe("reviewQuery", () => {
  beforeAll(async () => { await cleanup(); await seed(); await indexAllClauses({ docId: DOC }); });
  afterAll(cleanup);

  it("returns a grounded card whose citations resolve against raw_text", async () => {
    const card = await reviewQuery("What law governs?", DOC, { k: 4, generator: fakeGen });
    expect(card.refused).toBe(false);
    expect(card.citations.length).toBeGreaterThan(0);
    const raw = T0 + "\n" + T1;
    for (const c of card.citations) expect(raw.slice(c.char_start, c.char_end)).toBe(c.quote);
  }, 120_000);

  it("passes a refusal through", async () => {
    const card = await reviewQuery("What is the price of tea?", DOC, { k: 4, generator: refuseGen });
    expect(card.refused).toBe(true);
    expect(card.citations).toEqual([]);
  }, 120_000);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd core && npx vitest run test/review.test.ts`
Expected: FAIL — cannot import `review.js` / `sse.js`.

- [ ] **Step 3: Implement the SSE helper**

Create `core/src/review/sse.ts`:

```ts
/** Format a Server-Sent Events frame. */
export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
```

- [ ] **Step 4: Implement docs listing**

Create `core/src/review/docs.ts`:

```ts
import { withClient } from "../db/client.js";

export async function listDocs(): Promise<{ doc_id: string; title: string | null; source: string }[]> {
  const rows = await withClient((c) =>
    c.query("SELECT doc_id, title, source FROM documents ORDER BY doc_id"),
  );
  return rows.rows as { doc_id: string; title: string | null; source: string }[];
}
```

- [ ] **Step 5: Implement the review pipeline**

Create `core/src/review/review.ts`:

```ts
import { withClient } from "../db/client.js";
import { retrieve } from "../retrieve/retrieve.js";
import { makeGenerator, toClauseCard, type Generator } from "../generate/index.js";
import { assertCardCitations, type ClauseCard } from "../schemas/clauseCard.js";

async function rawText(docId: string): Promise<string> {
  const r = await withClient((c) => c.query("SELECT raw_text FROM documents WHERE doc_id=$1", [docId]));
  if (!r.rowCount) throw new Error(`unknown document ${docId}`);
  return r.rows[0].raw_text as string;
}

/** End-to-end naive baseline: retrieve → generate → grounded ClauseCard (citations re-verified). */
export async function reviewQuery(
  objective: string,
  docId: string,
  opts: { k?: number; generator?: Generator } = {},
): Promise<ClauseCard> {
  const candidates = await retrieve(objective, docId, opts.k ?? 8);
  const generator = opts.generator ?? makeGenerator();
  const raw = await generator.generate({ objective, candidates });
  const card = toClauseCard(objective, raw, candidates);

  const byDoc = new Map<string, string>();
  for (const c of card.citations) {
    if (!byDoc.has(c.doc_id)) byDoc.set(c.doc_id, await rawText(c.doc_id));
  }
  assertCardCitations(card, byDoc);
  return card;
}
```

- [ ] **Step 6: Implement the review barrel**

Create `core/src/review/index.ts`:

```ts
export { reviewQuery } from "./review.js";
export { listDocs } from "./docs.js";
export { formatSseEvent } from "./sse.js";
```

- [ ] **Step 7: Run the test to confirm it passes**

Run: `cd core && npx vitest run test/review.test.ts`
Expected: PASS.

- [ ] **Step 8: Add the `./review` export, typecheck, commit**

Add `"./review": "./src/review/index.ts"` to `core/package.json` `exports`. Then:

Run: `cd core && npm run typecheck`
Expected: clean.

```bash
git add core/src/review/review.ts core/src/review/docs.ts core/src/review/sse.ts core/src/review/index.ts core/test/review.test.ts core/package.json
git commit -m "feat(review): end-to-end reviewQuery pipeline + listDocs + SSE helper"
```

---

### Task 10: Eval — retrieval metrics (recall@k, NDCG@10)

**Files:**
- Create: `core/src/eval/retrieval.ts`
- Test: `core/test/eval.retrieval.test.ts`

**Interfaces:**
- Consumes: `EvalItem` (`core/src/eval/evalItem.ts`).
- Produces: `overlaps(aStart,aEnd,bStart,bEnd): boolean`; `RankedNode = { char_start: number; char_end: number; doc_id: string }`; `RetrieveRanked = (objective: string, docId: string, kMax: number) => Promise<RankedNode[]>`; `RetrievalMetrics = { recallAt: Record<string, number>; ndcgAt10: number; nItems: number }`; `computeRetrievalMetrics(items, retrieve, opts?): Promise<RetrievalMetrics>`.

- [ ] **Step 1: Write the failing metrics test**

Create `core/test/eval.retrieval.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { overlaps, computeRetrievalMetrics, type RankedNode } from "../src/eval/retrieval.js";
import type { EvalItem } from "../src/eval/evalItem.js";

function item(gold: [number, number][]): EvalItem {
  return {
    id: "i", doc_id: "d", source: "cuad", contract_type: "nda", category: "clean",
    objective: "o", expected_fields: [], expected_flags: [],
    gold_spans: gold.map(([s, e]) => ({ doc_id: "d", char_start: s, char_end: e, quote: "" })),
    grader: "span_match", notes: "",
  };
}

describe("overlaps", () => {
  it("detects interval overlap", () => {
    expect(overlaps(0, 10, 5, 15)).toBe(true);
    expect(overlaps(0, 10, 10, 20)).toBe(false);
  });
});

describe("computeRetrievalMetrics", () => {
  it("computes recall@k and NDCG@10 from ranked overlaps", async () => {
    // gold span [0,10). Ranked: rank0 misses, rank1 hits.
    const ranked: RankedNode[] = [
      { doc_id: "d", char_start: 100, char_end: 110 },
      { doc_id: "d", char_start: 0, char_end: 10 },
    ];
    const retrieve = async () => ranked;
    const m = await computeRetrievalMetrics([item([[0, 10]])], retrieve, { ks: [1, 5] });
    expect(m.nItems).toBe(1);
    expect(m.recallAt["1"]).toBe(0); // top-1 misses
    expect(m.recallAt["5"]).toBe(1); // within top-5 the gold span is covered
    // DCG = 1/log2(3) (hit at rank 2); IDCG = 1/log2(2) = 1 → NDCG = 1/log2(3) ≈ 0.6309
    expect(m.ndcgAt10).toBeCloseTo(1 / Math.log2(3), 4);
  });

  it("skips items with no gold spans", async () => {
    const m = await computeRetrievalMetrics([item([])], async () => [], {});
    expect(m.nItems).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd core && npx vitest run test/eval.retrieval.test.ts`
Expected: FAIL — cannot import `retrieval.js`.

- [ ] **Step 3: Implement the metrics**

Create `core/src/eval/retrieval.ts`:

```ts
import type { EvalItem } from "./evalItem.js";

export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

export interface RankedNode {
  doc_id: string;
  char_start: number;
  char_end: number;
}

export type RetrieveRanked = (objective: string, docId: string, kMax: number) => Promise<RankedNode[]>;

export interface RetrievalMetrics {
  recallAt: Record<string, number>;
  ndcgAt10: number;
  nItems: number;
}

/**
 * recall@k = mean over items of (gold spans covered by top-k) / (gold spans).
 * NDCG@10 with binary relevance (a retrieved node is relevant if it overlaps any gold span);
 * IDCG uses R = relevant nodes found within the top-kMax retrieval (a self-contained proxy).
 */
export async function computeRetrievalMetrics(
  items: EvalItem[],
  retrieve: RetrieveRanked,
  opts: { ks?: number[]; kMax?: number } = {},
): Promise<RetrievalMetrics> {
  const ks = opts.ks ?? [1, 5, 10];
  const kMax = opts.kMax ?? 50;
  const recallSums: Record<string, number> = {};
  ks.forEach((k) => (recallSums[String(k)] = 0));
  let ndcgSum = 0;
  let ndcgN = 0;
  let n = 0;

  for (const item of items) {
    if (item.gold_spans.length === 0) continue;
    n += 1;
    const ranked = await retrieve(item.objective, item.doc_id, kMax);
    const rel = ranked.map((node) =>
      item.gold_spans.some(
        (g) => g.doc_id === item.doc_id && overlaps(node.char_start, node.char_end, g.char_start, g.char_end),
      )
        ? 1
        : 0,
    );

    for (const k of ks) {
      const top = ranked.slice(0, k);
      let covered = 0;
      for (const g of item.gold_spans) {
        if (top.some((node) => overlaps(node.char_start, node.char_end, g.char_start, g.char_end))) covered += 1;
      }
      recallSums[String(k)] += covered / item.gold_spans.length;
    }

    const R = rel.reduce((a, b) => a + b, 0);
    if (R > 0) {
      let dcg = 0;
      for (let i = 0; i < Math.min(10, rel.length); i++) dcg += rel[i] / Math.log2(i + 2);
      let idcg = 0;
      for (let i = 0; i < Math.min(10, R); i++) idcg += 1 / Math.log2(i + 2);
      ndcgSum += dcg / idcg;
      ndcgN += 1;
    }
  }

  const recallAt: Record<string, number> = {};
  for (const k of ks) recallAt[String(k)] = n ? recallSums[String(k)] / n : 0;
  return { recallAt, ndcgAt10: ndcgN ? ndcgSum / ndcgN : 0, nItems: n };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd core && npx vitest run test/eval.retrieval.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `cd core && npm run typecheck`
Expected: clean.

```bash
git add core/src/eval/retrieval.ts core/test/eval.retrieval.test.ts
git commit -m "feat(eval): retrieval metrics — recall@k + NDCG@10 over gold-span overlap"
```

---

### Task 11: Eval — groundedness + refusal correctness

**Files:**
- Create: `core/src/eval/groundedness.ts`
- Test: `core/test/eval.groundedness.test.ts`

**Interfaces:**
- Consumes: `ClauseCard`/`Span` (Task 5), `EvalItem`.
- Produces:
  - `JudgeFn = (objective: string, answer: string, citations: Span[]) => Promise<boolean>`.
  - `computeGroundedness(entries: { card: ClauseCard; rawTextByDoc: Map<string, string> }[], judge: JudgeFn): Promise<{ faithfulnessRate: number; citationResolveRate: number; nCards: number }>`.
  - `computeRefusal(items: EvalItem[], cards: Map<string, ClauseCard>): { refusalAccuracy: number; falseRefusalRate: number; missedRefusalRate: number; nRefusalItems: number; nAnswerable: number }`.

- [ ] **Step 1: Write the failing test**

Create `core/test/eval.groundedness.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeGroundedness, computeRefusal } from "../src/eval/groundedness.js";
import type { ClauseCard } from "../src/schemas/clauseCard.js";
import type { EvalItem } from "../src/eval/evalItem.js";

const card = (over: Partial<ClauseCard>): ClauseCard => ({
  objective: "o", answer: "a", citations: [], refused: false, refusal_reason: null, ...over,
});
const evItem = (id: string, grader: EvalItem["grader"]): EvalItem => ({
  id, doc_id: "d", source: "cuad", contract_type: "nda", category: "clean",
  objective: "o", expected_fields: [], expected_flags: [], gold_spans: [], grader, notes: "",
});

describe("computeGroundedness", () => {
  it("reports faithfulness via the judge and citation-resolve rate", async () => {
    const raw = new Map([["d", "ABCDE"]]);
    const entries = [
      { card: card({ citations: [{ doc_id: "d", char_start: 0, char_end: 3, quote: "ABC" }] }), rawTextByDoc: raw },
    ];
    const yes = await computeGroundedness(entries, async () => true);
    expect(yes.faithfulnessRate).toBe(1);
    expect(yes.citationResolveRate).toBe(1);
    const no = await computeGroundedness(entries, async () => false);
    expect(no.faithfulnessRate).toBe(0);
  });
});

describe("computeRefusal", () => {
  it("scores refusal accuracy and false-refusal rate", () => {
    const items = [evItem("r1", "refusal"), evItem("a1", "span_match")];
    const cards = new Map<string, ClauseCard>([
      ["r1", card({ refused: true })],   // correct refusal
      ["a1", card({ refused: true })],   // false refusal
    ]);
    const r = computeRefusal(items, cards);
    expect(r.refusalAccuracy).toBe(1);
    expect(r.falseRefusalRate).toBe(1);
    expect(r.missedRefusalRate).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd core && npx vitest run test/eval.groundedness.test.ts`
Expected: FAIL — cannot import `groundedness.js`.

- [ ] **Step 3: Implement groundedness + refusal**

Create `core/src/eval/groundedness.ts`:

```ts
import type { ClauseCard, Span } from "../schemas/clauseCard.js";
import type { EvalItem } from "./evalItem.js";

export type JudgeFn = (objective: string, answer: string, citations: Span[]) => Promise<boolean>;

export interface GroundednessResult {
  faithfulnessRate: number;
  citationResolveRate: number;
  nCards: number;
}

/** Faithfulness via LLM judge + a guardrail that every citation resolves (≈1.0 by construction). */
export async function computeGroundedness(
  entries: { card: ClauseCard; rawTextByDoc: Map<string, string> }[],
  judge: JudgeFn,
): Promise<GroundednessResult> {
  const nonRefused = entries.filter((e) => !e.card.refused);
  let faithful = 0;
  let totalCites = 0;
  let okCites = 0;
  for (const { card, rawTextByDoc } of nonRefused) {
    if (await judge(card.objective, card.answer, card.citations)) faithful += 1;
    for (const c of card.citations) {
      totalCites += 1;
      const raw = rawTextByDoc.get(c.doc_id);
      if (raw != null && raw.slice(c.char_start, c.char_end) === c.quote) okCites += 1;
    }
  }
  return {
    faithfulnessRate: nonRefused.length ? faithful / nonRefused.length : 0,
    citationResolveRate: totalCites ? okCites / totalCites : 1,
    nCards: nonRefused.length,
  };
}

export interface RefusalResult {
  refusalAccuracy: number;
  falseRefusalRate: number;
  missedRefusalRate: number;
  nRefusalItems: number;
  nAnswerable: number;
}

/** Refusal items (grader==="refusal") should refuse; all others should answer. */
export function computeRefusal(items: EvalItem[], cards: Map<string, ClauseCard>): RefusalResult {
  let refItems = 0;
  let refCorrect = 0;
  let ansItems = 0;
  let falseRef = 0;
  for (const it of items) {
    const card = cards.get(it.id);
    if (!card) continue;
    if (it.grader === "refusal") {
      refItems += 1;
      if (card.refused) refCorrect += 1;
    } else {
      ansItems += 1;
      if (card.refused) falseRef += 1;
    }
  }
  return {
    refusalAccuracy: refItems ? refCorrect / refItems : 0,
    falseRefusalRate: ansItems ? falseRef / ansItems : 0,
    missedRefusalRate: refItems ? (refItems - refCorrect) / refItems : 0,
    nRefusalItems: refItems,
    nAnswerable: ansItems,
  };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd core && npx vitest run test/eval.groundedness.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `cd core && npm run typecheck`
Expected: clean.

```bash
git add core/src/eval/groundedness.ts core/test/eval.groundedness.test.ts
git commit -m "feat(eval): groundedness (faithfulness + citation-resolve) + refusal correctness"
```

---

### Task 12: Baseline orchestration + `eval -- baseline` CLI

**Files:**
- Create: `core/src/eval/baseline.ts`
- Modify: `core/src/eval/cli.ts`
- Test: `core/test/eval.baseline.test.ts`

**Interfaces:**
- Consumes: `reviewQuery` (Task 9), `retrieve` (Task 4), `computeRetrievalMetrics` (Task 10), `computeGroundedness`/`computeRefusal` (Task 11), `EvalItem`, `makeGenerator`, `Generator`, `JudgeFn`.
- Produces: `runBaseline(opts?: { items?: EvalItem[]; generator?: Generator; judge?: JudgeFn; withGeneration?: boolean }): Promise<BaselineReport>`; `formatBaselineReport(r: BaselineReport): string`; CLI subcommand `eval -- baseline`.

- [ ] **Step 1: Write the failing baseline test (DB-backed, fake generator)**

Create `core/test/eval.baseline.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withClient } from "../src/db/client.js";
import { indexAllClauses } from "../src/embed/indexClauses.js";
import { runBaseline } from "../src/eval/baseline.js";
import type { EvalItem } from "../src/eval/evalItem.js";
import type { Generator } from "../src/generate/index.js";

const DOC = "basetest_doc";
const T0 = "This Agreement is governed by the laws of the State of New York.";

async function seed() {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO documents (doc_id, source, title, contract_type, raw_text, char_length, raw_sha256)
       VALUES ($1,'cuad','t','nda',$2,$3,'x') ON CONFLICT (doc_id) DO NOTHING`,
      [DOC, T0, T0.length],
    );
    await c.query(
      `INSERT INTO clauses (node_id, doc_id, parent_id, type, number, heading, text, char_start, char_end, depth)
       VALUES ($1,$2,NULL,'section',NULL,NULL,$3,0,$4,0) ON CONFLICT (node_id) DO NOTHING`,
      [`${DOC}::n0`, DOC, T0, T0.length],
    );
  });
}
async function cleanup() {
  await withClient((c) => c.query("DELETE FROM documents WHERE doc_id=$1", [DOC]));
}

const items: EvalItem[] = [
  {
    id: "b1", doc_id: DOC, source: "cuad", contract_type: "nda", category: "clean",
    objective: "What law governs?", expected_fields: [], expected_flags: [],
    gold_spans: [{ doc_id: DOC, char_start: 0, char_end: T0.length, quote: T0 }],
    grader: "span_match", notes: "",
  },
];
const fakeGen: Generator = { async generate() { return { answer: "NY law.", supporting: [0], refused: false }; } };

describe("runBaseline", () => {
  beforeAll(async () => { await cleanup(); await seed(); await indexAllClauses({ docId: DOC }); });
  afterAll(cleanup);

  it("produces retrieval + generation metrics over the items", async () => {
    const r = await runBaseline({ items, generator: fakeGen, judge: async () => true, withGeneration: true });
    expect(r.retrieval.nItems).toBe(1);
    expect(r.retrieval.recallAt["10"]).toBe(1);
    expect(r.groundedness?.citationResolveRate).toBe(1);
    expect(r.refusal?.falseRefusalRate).toBe(0);
  }, 120_000);

  it("runs retrieval-only when generation is disabled", async () => {
    const r = await runBaseline({ items, withGeneration: false });
    expect(r.retrieval.nItems).toBe(1);
    expect(r.groundedness).toBeUndefined();
  }, 120_000);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd core && npx vitest run test/eval.baseline.test.ts`
Expected: FAIL — cannot import `baseline.js`.

- [ ] **Step 3: Implement the orchestration**

Create `core/src/eval/baseline.ts`:

```ts
import { retrieve } from "../retrieve/retrieve.js";
import { reviewQuery } from "../review/review.js";
import { withClient } from "../db/client.js";
import { computeRetrievalMetrics, type RetrievalMetrics, type RankedNode } from "./retrieval.js";
import {
  computeGroundedness, computeRefusal, type GroundednessResult, type RefusalResult, type JudgeFn,
} from "./groundedness.js";
import { makeGenerator, type Generator } from "../generate/index.js";
import type { EvalItem } from "./evalItem.js";
import type { ClauseCard } from "../schemas/clauseCard.js";

export interface BaselineReport {
  nItems: number;
  retrieval: RetrievalMetrics;
  groundedness?: GroundednessResult;
  refusal?: RefusalResult;
}

const retrieveRanked = async (objective: string, docId: string, kMax: number): Promise<RankedNode[]> =>
  (await retrieve(objective, docId, kMax)).map((c) => ({ doc_id: c.doc_id, char_start: c.char_start, char_end: c.char_end }));

async function rawText(docId: string): Promise<string> {
  const r = await withClient((c) => c.query("SELECT raw_text FROM documents WHERE doc_id=$1", [docId]));
  return r.rowCount ? (r.rows[0].raw_text as string) : "";
}

/** Default faithfulness judge: ask the same provider a yes/no support question. */
function makeDefaultJudge(generator: Generator): JudgeFn {
  return async (objective, answer, citations) => {
    const quotes = citations.map((c, i) => `[${i}] ${c.quote}`).join("\n");
    const raw = await generator.generate({
      objective: `Judge faithfulness. Question: "${objective}". Answer: "${answer}". Cited spans:\n${quotes}\n` +
        `Is every claim in the answer supported by a cited span? Set refused=false and answer "yes" or "no".`,
      candidates: [],
    });
    return /(^|\b)yes\b/i.test(raw.answer);
  };
}

export async function runBaseline(
  opts: { items?: EvalItem[]; generator?: Generator; judge?: JudgeFn; withGeneration?: boolean } = {},
): Promise<BaselineReport> {
  const items = opts.items ?? [];
  const withGeneration = opts.withGeneration ?? true;

  const retrieval = await computeRetrievalMetrics(items, retrieveRanked, { ks: [1, 5, 10] });
  if (!withGeneration) return { nItems: items.length, retrieval };

  const generator = opts.generator ?? makeGenerator();
  const judge = opts.judge ?? makeDefaultJudge(generator);

  const cards = new Map<string, ClauseCard>();
  const entries: { card: ClauseCard; rawTextByDoc: Map<string, string> }[] = [];
  for (const item of items) {
    const card = await reviewQuery(item.objective, item.doc_id, { generator });
    cards.set(item.id, card);
    const byDoc = new Map<string, string>();
    for (const c of card.citations) if (!byDoc.has(c.doc_id)) byDoc.set(c.doc_id, await rawText(c.doc_id));
    entries.push({ card, rawTextByDoc: byDoc });
  }

  const groundedness = await computeGroundedness(entries, judge);
  const refusal = computeRefusal(items, cards);
  return { nItems: items.length, retrieval, groundedness, refusal };
}

export function formatBaselineReport(r: BaselineReport): string {
  const lines = [
    `items: ${r.nItems} (retrieval-scored: ${r.retrieval.nItems})`,
    `recall@1=${r.retrieval.recallAt["1"]?.toFixed(3)} ` +
      `recall@5=${r.retrieval.recallAt["5"]?.toFixed(3)} ` +
      `recall@10=${r.retrieval.recallAt["10"]?.toFixed(3)} ` +
      `ndcg@10=${r.retrieval.ndcgAt10.toFixed(3)}`,
  ];
  if (r.groundedness) {
    lines.push(
      `faithfulness=${r.groundedness.faithfulnessRate.toFixed(3)} ` +
        `citation_resolve=${r.groundedness.citationResolveRate.toFixed(3)} (cards=${r.groundedness.nCards})`,
    );
  }
  if (r.refusal) {
    lines.push(
      `refusal_accuracy=${r.refusal.refusalAccuracy.toFixed(3)} ` +
        `false_refusal=${r.refusal.falseRefusalRate.toFixed(3)} ` +
        `missed_refusal=${r.refusal.missedRefusalRate.toFixed(3)} ` +
        `(refusal_items=${r.refusal.nRefusalItems}, answerable=${r.refusal.nAnswerable})`,
    );
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Wire the CLI subcommand**

Modify `core/src/eval/cli.ts` — add the `baseline` branch. Insert these imports near the top:

```ts
import { runBaseline, formatBaselineReport } from "./baseline.js";
import { EvalItemSchema, type EvalItem } from "./evalItem.js";
```

Add this branch before the final `else` (the `usage` branch):

```ts
} else if (cmd === "baseline") {
  const raw = JSON.parse(readFileSync(`${root}evals/data/eval-set-v1.json`, "utf-8")) as unknown[];
  const items: EvalItem[] = raw.map((r) => EvalItemSchema.parse(r));
  const withGeneration = !!process.env.LLM_API_KEY;
  if (!withGeneration) console.error("LLM_API_KEY not set — running retrieval metrics only.");
  const report = await runBaseline({ items, withGeneration });
  console.log(formatBaselineReport(report));
  console.log("\nJSON:\n" + JSON.stringify(report, null, 2));
  process.exit(0);
```

Also update the usage string to include `baseline`:

```ts
  console.error("usage: tsx src/eval/cli.ts <derive|validate|baseline>");
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd core && npx vitest run test/eval.baseline.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `cd core && npm run typecheck`
Expected: clean.

```bash
git add core/src/eval/baseline.ts core/src/eval/cli.ts core/test/eval.baseline.test.ts
git commit -m "feat(eval): baseline orchestration + 'eval -- baseline' (retrieval + groundedness + refusal)"
```

---

### Task 13: Next.js app scaffold + docs API + page shell

**Files:**
- Create: `app/package.json`, `app/next.config.mjs`, `app/tsconfig.json`, `app/next-env.d.ts`
- Create: `app/app/layout.tsx`, `app/app/page.tsx`, `app/app/globals.css`
- Create: `app/app/api/docs/route.ts`
- Modify: `.gitignore` (add `.next/`)

**Interfaces:**
- Consumes: `listDocs` from `@sift/core/review`.
- Produces: a Next.js app that builds, lists loaded documents at `GET /api/docs`, and renders a contract picker + objective input shell.

- [ ] **Step 1: Replace the placeholder `app/package.json`**

Overwrite `app/package.json`:

```json
{
  "name": "@sift/app",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start -p 3000",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@sift/core": "*",
    "next": "^14.2.5",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "typescript": "^5.4.5"
  }
}
```

- [ ] **Step 2: Add Next config (transpile the workspace package)**

Create `app/next.config.mjs`. The `extensionAlias` lets webpack resolve `@sift/core`'s ESM `.js` import specifiers (e.g. `./review.js`) to their `.ts` sources during transpilation — without it, `next build` fails to resolve core's internal imports:

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@sift/core"],
  // Keep native/heavy deps out of the webpack bundle; require them at runtime instead.
  experimental: {
    serverComponentsExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "sharp", "pg"],
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};
export default nextConfig;
```

Create `app/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

Create `app/next-env.d.ts`:

```ts
/// <reference types="next" />
/// <reference types="next/image-types/global" />
```

- [ ] **Step 3: Install Next + React at the workspace root**

Run: `cd /Users/koushik/Documents/GitHub/sift && npm install`
Expected: resolves `next`, `react`, `react-dom`, and the `@sift/core` workspace symlink.

- [ ] **Step 4: Ignore the Next build output**

Modify `.gitignore` — add under the `# Node` section:

```
.next/
```

- [ ] **Step 5: Add the docs API route**

Create `app/app/api/docs/route.ts`:

```ts
import { listDocs } from "@sift/core/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const docs = await listDocs();
  return Response.json({ docs });
}
```

- [ ] **Step 6: Add layout, page shell, and minimal styles**

Create `app/app/globals.css`:

```css
* { box-sizing: border-box; }
body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2rem; max-width: 880px; }
select, input, button { font: inherit; padding: 0.5rem; }
.card { border: 1px solid #ccc; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
.refused { border-color: #c0392b; background: #fdecea; }
mark { background: #fff3a3; }
.cite { color: #555; font-size: 0.85rem; }
```

Create `app/app/layout.tsx`:

```tsx
import "./globals.css";

export const metadata = { title: "sift — NDA review", description: "Grounded contract clause review" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

Create `app/app/page.tsx` (the shell; streaming is wired in Task 14):

```tsx
"use client";
import { useEffect, useState } from "react";

interface Doc { doc_id: string; title: string | null; source: string }

export default function Home() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [docId, setDocId] = useState("");
  const [objective, setObjective] = useState("What law governs this agreement?");

  useEffect(() => {
    fetch("/api/docs")
      .then((r) => r.json())
      .then((d) => {
        setDocs(d.docs);
        if (d.docs[0]) setDocId(d.docs[0].doc_id);
      });
  }, []);

  return (
    <main>
      <h1>sift — NDA clause review</h1>
      <p>Pick a contract and ask a clause question. Every answer cites its source span or refuses.</p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <select value={docId} onChange={(e) => setDocId(e.target.value)}>
          {docs.map((d) => (
            <option key={d.doc_id} value={d.doc_id}>{d.doc_id}</option>
          ))}
        </select>
        <input style={{ flex: 1, minWidth: 280 }} value={objective} onChange={(e) => setObjective(e.target.value)} />
        <button disabled>Review (wired in Task 14)</button>
      </div>
    </main>
  );
}
```

- [ ] **Step 6b: Verify the app builds**

Run: `cd /Users/koushik/Documents/GitHub/sift/app && npm run build`
Expected: `next build` succeeds (compiles the route + page; `@sift/core` transpiles).

- [ ] **Step 7: Commit**

```bash
git add app/package.json app/next.config.mjs app/tsconfig.json app/next-env.d.ts app/app/layout.tsx app/app/page.tsx app/app/globals.css app/app/api/docs/route.ts .gitignore package-lock.json
git commit -m "feat(app): Next.js scaffold + /api/docs + contract-picker shell"
```

---

### Task 14: SSE review route + streaming card rendering

**Files:**
- Create: `app/app/api/review/route.ts`
- Modify: `app/app/page.tsx`

**Interfaces:**
- Consumes: `reviewQuery`, `formatSseEvent` from `@sift/core/review`; `ClauseCard` type from `@sift/core/schemas`.
- Produces: `POST /api/review` streaming `status`/`card`/`done`/`error` SSE events; the page renders streamed cards with the cited quote highlighted, or an "insufficient context" card.

- [ ] **Step 1: Implement the SSE route**

Create `app/app/api/review/route.ts`:

```ts
import { reviewQuery, formatSseEvent } from "@sift/core/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { doc_id, objective } = (await req.json()) as { doc_id: string; objective: string };
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(formatSseEvent(event, data)));
      send("status", { phase: "retrieving" });
      try {
        send("status", { phase: "generating" });
        const card = await reviewQuery(objective, doc_id);
        send("card", card);
        send("done", {});
      } catch (e) {
        send("error", { message: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
```

- [ ] **Step 2: Wire streaming + rendering into the page**

Replace `app/app/page.tsx` with the streaming version:

```tsx
"use client";
import { useEffect, useState } from "react";

interface Doc { doc_id: string; title: string | null; source: string }
interface Span { doc_id: string; char_start: number; char_end: number; quote: string }
interface ClauseCard {
  objective: string;
  answer: string;
  citations: Span[];
  refused: boolean;
  refusal_reason?: string | null;
}

export default function Home() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [docId, setDocId] = useState("");
  const [objective, setObjective] = useState("What law governs this agreement?");
  const [status, setStatus] = useState("");
  const [card, setCard] = useState<ClauseCard | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/docs")
      .then((r) => r.json())
      .then((d) => {
        setDocs(d.docs);
        if (d.docs[0]) setDocId(d.docs[0].doc_id);
      });
  }, []);

  async function run() {
    setBusy(true);
    setCard(null);
    setStatus("starting…");
    const resp = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc_id: docId, objective }),
    });
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const ev = /event: (.*)/.exec(frame)?.[1];
        const data = /data: (.*)/.exec(frame)?.[1];
        if (!ev || !data) continue;
        const payload = JSON.parse(data);
        if (ev === "status") setStatus(payload.phase);
        else if (ev === "card") { setCard(payload); setStatus("done"); }
        else if (ev === "error") setStatus("error: " + payload.message);
      }
    }
    setBusy(false);
  }

  return (
    <main>
      <h1>sift — NDA clause review</h1>
      <p>Pick a contract and ask a clause question. Every answer cites its source span or refuses.</p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <select value={docId} onChange={(e) => setDocId(e.target.value)}>
          {docs.map((d) => (
            <option key={d.doc_id} value={d.doc_id}>{d.doc_id}</option>
          ))}
        </select>
        <input style={{ flex: 1, minWidth: 280 }} value={objective} onChange={(e) => setObjective(e.target.value)} />
        <button onClick={run} disabled={busy || !docId}>{busy ? "Reviewing…" : "Review"}</button>
      </div>
      {status && <p className="cite">status: {status}</p>}
      {card && (
        <div className={"card" + (card.refused ? " refused" : "")}>
          {card.refused ? (
            <>
              <strong>Insufficient context — refused.</strong>
              <p>{card.refusal_reason}</p>
            </>
          ) : (
            <>
              <p>{card.answer}</p>
              {card.citations.map((c, i) => (
                <p key={i} className="cite">
                  <mark>{c.quote}</mark>
                  <br />
                  {c.doc_id} [{c.char_start}–{c.char_end})
                </p>
              ))}
            </>
          )}
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 3: Verify the app builds**

Run: `cd /Users/koushik/Documents/GitHub/sift/app && npm run build`
Expected: `next build` succeeds with the `/api/review` route present.

- [ ] **Step 4: Commit**

```bash
git add app/app/api/review/route.ts app/app/page.tsx
git commit -m "feat(app): SSE review route + streaming clause-card rendering with citations"
```

---

### Task 15: Acceptance harness — Makefile, env, docs, manual smoke test, `verify-p1` gate, P1 report

**Files:**
- Create: `.env.example`
- Create: `docs/eval-reports/P1.md`
- Create: `docs/smoke-tests/P1-manual-smoke-test.md`
- Modify: `Makefile`, `README.md`, `CLAUDE.md`, `DECISIONS.md`

**Interfaces:**
- Consumes: every prior task.
- Produces: `make embed`, `make eval-baseline`, `make dev`, `make verify-p1`; `.env.example`; the P1 eval report; the manual smoke-test guide the user runs to independently verify the phase.

- [ ] **Step 1: Create `.env.example`**

Create `.env.example`:

```bash
# Postgres + pgvector (Phase 0 Docker Compose default)
DATABASE_URL=postgres://sift:sift@localhost:5433/sift

# Generation provider (Phase 1). Default = NVIDIA NIM (OpenAI-compatible, free tier).
LLM_PROVIDER=openai
LLM_BASE_URL=https://integrate.api.nvidia.com/v1
LLM_API_KEY=
LLM_MODEL=moonshotai/kimi-k2-instruct

# To use Claude instead:
# LLM_PROVIDER=anthropic
# LLM_API_KEY=sk-ant-...
# LLM_MODEL=claude-sonnet-4-6
```

- [ ] **Step 2: Add Makefile targets**

Modify `Makefile` — add to the `.PHONY` line and append the targets:

```makefile
.PHONY: embed eval-baseline dev verify-p1

embed:
	cd core && npm run embed

eval-baseline:
	cd core && npm run eval -- baseline

dev:
	cd app && npm run dev

# Phase 1 gate: corpus embedded + retrieval metrics recorded + grounded pipeline + app builds.
verify-p1: db-up migrate
	@echo "== 1/4 embed corpus =="
	cd core && npm run embed
	@echo "== 2/4 core tests (embed/retrieve/generate/review/eval) =="
	cd core && npm test
	@echo "== 3/4 baseline metrics (retrieval; generation if LLM_API_KEY set) =="
	cd core && npm run eval -- baseline
	@echo "== 4/4 app builds =="
	cd app && npm run build
	@echo "PHASE 1 GATE PASSED"
```

- [ ] **Step 3: Run the gate end-to-end**

Run: `cd /Users/koushik/Documents/GitHub/sift && make verify-p1`
Expected: embeds the full corpus, core tests pass, baseline metrics print (retrieval numbers always; generation numbers if `LLM_API_KEY` is set), `next build` succeeds, ending with `PHASE 1 GATE PASSED`.

- [ ] **Step 4: Record the P1 eval report**

Create `docs/eval-reports/P1.md` — fill the bracketed values from the Step 3 baseline output:

```markdown
# Phase 1 — Naive Baseline: Eval Report

**Date:** 2026-06-25
**Gate:** corpus embedded · retrieval metrics recorded · grounded clause-card pipeline · app builds. **Result: PASS.**

## Configuration
- Embedding: `bge-large-en-v1.5` (transformers.js, 1024-d), document-scoped cosine top-k (k=8), HNSW index.
- Generation: provider-abstracted; this run used [NVIDIA NIM `<model>` | Anthropic `<model>` | retrieval-only].
- Retrieval ground truth: `evals/data/eval-set-v1.json` (gold spans).

## Baseline metrics (the reference point for P2)
- recall@1 = [..], recall@5 = [..], recall@10 = [..]  (over [N] gold-span items)
- NDCG@10 = [..]
- Faithfulness = [..]; citation-resolve = [..]  (over [M] non-refusal cards) [or: generation skipped — no LLM key]
- Refusal accuracy = [..]; false-refusal = [..]; missed-refusal = [..]  (refusal items: [r], answerable: [a])

## Notes
- Naive baseline only: single embedding, fixed top-k, one-shot generation, document-scoped.
- Citations are index-referenced (model selects candidate indices; server resolves to known-good
  node spans), so the citation-resolve rate is ~1.0 by construction.
- Deferred to P2: hybrid BM25+RRF, cross-encoder rerank, embedder comparison, agentic loop,
  LegalBench-RAG subset, hosting/live URL.

## Next: Phase 2 (Retrieval upgrade)
Hybrid (BM25 + dense + RRF) + cross-encoder rerank + embedder comparison + agentic
retrieve-evaluate loop + refusal path; report the delta vs this baseline.
```

- [ ] **Step 5: Write the manual smoke-test guide**

Create `docs/smoke-tests/P1-manual-smoke-test.md`:

```markdown
# Phase 1 — Manual Smoke Test

Run these by hand to verify Phase 1 meets spec. Prerequisites:
`cp .env.example .env` (set `LLM_API_KEY` to your NVIDIA NIM key to exercise generation),
then `make db-up && make migrate && make load` (Phase 0 corpus) if not already loaded.

## 1. Embeddings populate (spec §2)
```bash
make embed
```
Expect: `embedded N clauses (model=bge-large-en-v1.5)` with N ≈ 5,792.
Verify in psql: `SELECT count(*) FROM embeddings;` equals `SELECT count(*) FROM clauses;`.
Dimension check: `SELECT vector_dims(embedding) FROM embeddings LIMIT 1;` → `1024`.

## 2. Retrieval works and is document-scoped (spec §3)
Start the app: `make dev`, open http://localhost:3000.
- The contract dropdown lists loaded `doc_id`s (served by `GET /api/docs`).
- Pick a ContractNLI NDA, ask "What law governs this agreement?", click **Review**.
- Expect a streamed clause card whose highlighted quote is a real clause from *that* document.

## 3. Citations resolve exactly (spec §5, citation invariant)
For the card shown, note a citation's `doc_id` and `[start–end)`. In psql:
`SELECT substring(raw_text from <start>+1 for <end>-<start>) FROM documents WHERE doc_id='<doc_id>';`
Expect: the returned text equals the highlighted quote, character-for-character.

## 4. Refusal on out-of-scope questions (spec §4)
Ask something the contract cannot answer, e.g. "What is the price of Bitcoin?".
Expect: an **"Insufficient context — refused."** card with no citations.

## 5. Baseline metrics are recorded (spec §7, the gate)
```bash
make eval-baseline
```
Expect: a metrics block — `recall@1/5/10`, `ndcg@10`, and (if `LLM_API_KEY` set)
`faithfulness`, `citation_resolve`, and refusal rates. These are the numbers in
`docs/eval-reports/P1.md`.

## 6. Provider swap (spec §4)
Set `LLM_PROVIDER=anthropic`, `LLM_MODEL=claude-sonnet-4-6`, `LLM_API_KEY=<claude key>` in `.env`,
restart `make dev`, and re-run a review. Expect the same grounded-card behavior via Claude.

## 7. Full gate
```bash
make verify-p1
```
Expect: ends with `PHASE 1 GATE PASSED`.
```

- [ ] **Step 6: Update README, CLAUDE.md commands, DECISIONS.md**

Modify `README.md` — add a "Phase 1 — run the baseline" section with: `cp .env.example .env`, `make db-up migrate load embed`, `make dev` (UI at localhost:3000), `make eval-baseline`, `make verify-p1`.

Modify `CLAUDE.md` — under `## Commands` add:
```
- Embed:     `make embed`        (clauses → pgvector embeddings, bge-large-en-v1.5)
- Baseline:  `make eval-baseline`(recall@k / NDCG@10 + groundedness + refusal)
- App (dev): `make dev`          (Next.js + SSE UI at localhost:3000)
- Phase gate: `make verify-p1`
```

Modify `DECISIONS.md` — add a `## 2026-06-25 — Phase 1 baseline` section recording:
- Embedding model `bge-large-en-v1.5` via transformers.js (local, 1024-d, no column migration); query instruction prefix on queries only.
- Generation provider-abstracted (OpenAI-compatible default → NVIDIA NIM free tier; Anthropic adapter) switchable by `LLM_PROVIDER`.
- Index-referenced citations (model cites candidate indices; server resolves to known-good node spans → citations resolve by construction; groundedness measured as faithfulness).
- Document-scoped retrieval (one contract at a time; matches the eval items' `doc_id`).
- Root npm workspaces so `app` depends on `@sift/core`.
- Live-URL deploy deferred; baseline recorded from a local run.

- [ ] **Step 7: Commit**

```bash
git add .env.example Makefile README.md CLAUDE.md DECISIONS.md docs/eval-reports/P1.md docs/smoke-tests/P1-manual-smoke-test.md
git commit -m "feat(P1): acceptance harness (make verify-p1) + P1 report + manual smoke-test guide"
```

---

## Phase 1 spec-coverage map

| Spec requirement (design doc) | Task(s) |
|---|---|
| §1 root npm workspaces; `app` depends on `@sift/core` | 1, 13 |
| §2 embedder `bge-large-en-v1.5` (1024-d, no migration); index CLI; HNSW migration | 2, 3 |
| §3 document-scoped single-embedding top-k retrieval | 4 |
| §4 provider-abstracted generation (NVIDIA NIM default + Anthropic adapter, env switch) | 6, 7, 8 |
| §5 typed `ClauseCard` (Zod + JSON Schema SOT) + citation integrity guard | 5 |
| §6 `reviewQuery` single end-to-end pipeline | 9 |
| §7 retrieval metrics (recall@k, NDCG@10) | 10 |
| §7 groundedness (faithfulness + resolve) + refusal correctness | 11 |
| §7 baseline orchestration + `eval -- baseline` + P1 report | 12, 15 |
| §8 Next.js + SSE shell (docs picker, streamed cards, refusal card) | 13, 14 |
| §9 `.env.example`, README, `make` targets, `verify-p1` gate | 15 |
| User request: manual smoke-test guide | 15 |
| §10 deferred items documented (no implementation) | 15 (DECISIONS.md, P1.md) |

**Out of Phase 1 scope (deferred to P2+):** hybrid BM25+RRF, cross-encoder rerank, embedder
comparison (voyage-law-2 / Legal-BERT), agentic retrieve-evaluate loop, LegalBench-RAG NDA subset,
actual hosting / live URL.
