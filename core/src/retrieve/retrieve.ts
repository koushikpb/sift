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
