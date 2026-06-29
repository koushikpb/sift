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
