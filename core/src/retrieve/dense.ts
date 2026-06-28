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
