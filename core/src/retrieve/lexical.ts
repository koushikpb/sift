import { withClient } from "../db/client.js";
import type { Candidate } from "./types.js";

/** Document-scoped lexical retrieval via Postgres full-text search (ts_rank_cd). */
export async function lexicalRetrieve(query: string, docId: string, n: number): Promise<Candidate[]> {
  const rows = (
    await withClient((c) =>
      c.query(
        `SELECT c.node_id, c.doc_id, c.type, c.number, c.heading, c.text,
                c.char_start, c.char_end,
                ts_rank_cd(c.text_search, websearch_to_tsquery('english', $1)) AS score
         FROM clauses c
         WHERE c.doc_id = $2
           AND c.text_search @@ websearch_to_tsquery('english', $1)
         ORDER BY score DESC
         LIMIT $3`,
        [query, docId, n],
      ),
    )
  ).rows;
  return rows.map((r) => ({
    node_id: r.node_id, doc_id: r.doc_id, type: r.type, number: r.number,
    heading: r.heading, text: r.text, char_start: r.char_start, char_end: r.char_end,
    score: Number(r.score),
  }));
}
