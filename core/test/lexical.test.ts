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
