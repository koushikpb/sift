import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.js";
import { withClient, pool } from "../src/db/client.js";
import { loadDocsFile, assertOffsetIntegrity } from "../src/load/loadDocs.js";

const raw = "ARTICLE I TERM\nThis lasts.";
const goodDoc = {
  doc_id: "loadtest_1", source: "cuad", title: "T", contract_type: "unknown",
  raw_text: raw, char_length: raw.length,
  raw_sha256: "a".repeat(64),
  nodes: [{
    node_id: "loadtest_1/article-i", parent_id: null, type: "article",
    number: "I", heading: "TERM", text: raw, char_start: 0, char_end: raw.length, depth: 0,
  }],
};

function writeJsonl(docs: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "sift-load-"));
  const p = join(dir, "docs.jsonl");
  writeFileSync(p, docs.map((d) => JSON.stringify(d)).join("\n") + "\n");
  return p;
}

describe("loader", () => {
  beforeAll(async () => {
    await migrate();
    await withClient((c) => c.query("DELETE FROM documents WHERE doc_id LIKE 'loadtest_%'"));
  });

  afterAll(async () => {
    await pool.end();
  });

  it("rejects a node whose quote does not match its slice", () => {
    const bad = structuredClone(goodDoc);
    bad.nodes[0].text = "WRONG";
    expect(() => assertOffsetIntegrity(bad as never)).toThrow(/offset integrity/i);
  });

  it("loads documents + clauses and is idempotent", async () => {
    const p = writeJsonl([goodDoc]);
    const first = await loadDocsFile(p);
    expect(first).toEqual({ documents: 1, clauses: 1 });
    await loadDocsFile(p); // second run must not duplicate
    const counts = await withClient(async (c) => ({
      d: Number((await c.query("SELECT count(*) FROM documents WHERE doc_id='loadtest_1'")).rows[0].count),
      n: Number((await c.query("SELECT count(*) FROM clauses WHERE doc_id='loadtest_1'")).rows[0].count),
    }));
    expect(counts).toEqual({ d: 1, n: 1 });
  });
});
