import { withClient } from "../db/client.js";
import { toVectorLiteral } from "../db/vector.js";
import { embedTexts, EMBED_MODEL } from "./model.js";

export async function indexAllClauses(
  opts: { batchSize?: number; docId?: string } = {},
): Promise<{ embedded: number }> {
  const batchSize = opts.batchSize ?? 32;
  const where = opts.docId ? "WHERE doc_id = $1" : "";
  const params = opts.docId ? [opts.docId] : [];
  const rows = (
    await withClient((c) =>
      c.query<{ node_id: string; text: string }>(
        `SELECT node_id, text FROM clauses ${where} ORDER BY node_id`,
        params,
      ),
    )
  ).rows;

  let embedded = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const vecs = await embedTexts(batch.map((r) => r.text), { kind: "passage" });
    await withClient(async (c) => {
      for (let j = 0; j < batch.length; j++) {
        await c.query(
          `INSERT INTO embeddings (node_id, model, embedding)
           VALUES ($1, $2, $3::vector)
           ON CONFLICT (node_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding`,
          [batch[j].node_id, EMBED_MODEL, toVectorLiteral(vecs[j])],
        );
        embedded += 1;
      }
    });
  }
  return { embedded };
}
