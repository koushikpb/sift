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
  }, 120_000);
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
