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
