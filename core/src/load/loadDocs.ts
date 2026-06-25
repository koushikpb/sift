import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { ParsedDocumentSchema, type ParsedDocument } from "../schemas/parsedDocument.js";
import { withClient } from "../db/client.js";

/** Throw unless every node's text equals its slice of raw_text (the citation invariant). */
export function assertOffsetIntegrity(doc: ParsedDocument): void {
  for (const n of doc.nodes) {
    if (doc.raw_text.slice(n.char_start, n.char_end) !== n.text) {
      throw new Error(`offset integrity violation in ${doc.doc_id} node ${n.node_id}`);
    }
  }
}

export async function loadDocsFile(path: string): Promise<{ documents: number; clauses: number }> {
  let documents = 0;
  let clauses = 0;
  const rl = createInterface({ input: createReadStream(path, "utf-8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const doc = ParsedDocumentSchema.parse(JSON.parse(trimmed));
    assertOffsetIntegrity(doc);
    await withClient(async (c) => {
      await c.query("BEGIN");
      try {
        await c.query(
          `INSERT INTO documents (doc_id, source, title, contract_type, raw_text, char_length, raw_sha256)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (doc_id) DO UPDATE SET
             source=EXCLUDED.source, title=EXCLUDED.title, contract_type=EXCLUDED.contract_type,
             raw_text=EXCLUDED.raw_text, char_length=EXCLUDED.char_length, raw_sha256=EXCLUDED.raw_sha256`,
          [doc.doc_id, doc.source, doc.title, doc.contract_type, doc.raw_text, doc.char_length, doc.raw_sha256],
        );
        // Replace this doc's clauses so re-loads stay idempotent.
        await c.query("DELETE FROM clauses WHERE doc_id=$1", [doc.doc_id]);
        for (const n of doc.nodes) {
          await c.query(
            `INSERT INTO clauses (node_id, doc_id, parent_id, type, number, heading, text, char_start, char_end, depth)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [n.node_id, doc.doc_id, n.parent_id, n.type, n.number, n.heading, n.text, n.char_start, n.char_end, n.depth],
          );
          clauses += 1;
        }
        await c.query("COMMIT");
        documents += 1;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    });
  }
  return { documents, clauses };
}
