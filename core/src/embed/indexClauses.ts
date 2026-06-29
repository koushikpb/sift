import { withClient } from "../db/client.js";
import { toVectorLiteral } from "../db/vector.js";
import { embedTexts, EMBED_MODEL } from "./model.js";

export async function indexAllClauses(
  opts: { batchSize?: number; docId?: string } = {},
): Promise<{ embedded: number }> {
  const batchSize = opts.batchSize ?? 32;
  // Skip clauses already embedded WITH THE ACTIVE MODEL (the join is model-scoped),
  // so switching EMBED_MODEL re-embeds rather than no-ops.
  const where = opts.docId
    ? "WHERE e.node_id IS NULL AND c.doc_id = $2"
    : "WHERE e.node_id IS NULL";
  const params = opts.docId ? [EMBED_MODEL, opts.docId] : [EMBED_MODEL];
  const rows = (
    await withClient((c) =>
      c.query<{ node_id: string; text: string }>(
        `SELECT c.node_id, c.text
         FROM clauses c
         LEFT JOIN embeddings e ON e.node_id = c.node_id AND e.model = $1
         ${where}
         ORDER BY c.node_id`,
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
           ON CONFLICT (node_id, model) DO UPDATE SET embedding = EXCLUDED.embedding`,
          [batch[j].node_id, EMBED_MODEL, toVectorLiteral(vecs[j])],
        );
        embedded += 1;
      }
    });
    process.stderr.write(`embedded ${Math.min(i + batchSize, rows.length)}/${rows.length}\n`);
  }
  return { embedded };
}
