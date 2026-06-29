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
