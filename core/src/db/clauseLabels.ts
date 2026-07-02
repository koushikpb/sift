/**
 * DB helpers for the clause_labels table (migration 0007).
 *
 * Precomputed LoRA labels for the curated demo corpus are stored here so
 * the Task-5 Vercel API can serve classify results without spawning Python.
 *
 * Curated demo doc_ids: contractnli_4, contractnli_6, contractnli_1
 */
import type { PoolClient } from "pg";

export interface ClauseLabel {
  label: string;
  score: number;
}

/**
 * Return the precomputed label+score for a clause span, or null if not found.
 * Used by the Task-5 API's classify dependency.
 */
export async function getClauseLabel(
  client: PoolClient,
  docId: string,
  charStart: number,
  charEnd: number,
): Promise<ClauseLabel | null> {
  const result = await client.query<{ label: string; score: number }>(
    `SELECT label, score
       FROM clause_labels
      WHERE doc_id = $1
        AND char_start = $2
        AND char_end = $3`,
    [docId, charStart, charEnd],
  );
  if (result.rows.length === 0) return null;
  const { label, score } = result.rows[0];
  return { label, score };
}

/**
 * Insert or update a clause label. Used by the clf-precompute Makefile target.
 */
export async function upsertClauseLabel(
  client: PoolClient,
  docId: string,
  charStart: number,
  charEnd: number,
  label: string,
  score: number,
): Promise<void> {
  await client.query(
    `INSERT INTO clause_labels (doc_id, char_start, char_end, label, score)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (doc_id, char_start, char_end)
     DO UPDATE SET label = EXCLUDED.label, score = EXCLUDED.score`,
    [docId, charStart, charEnd, label, score],
  );
}
