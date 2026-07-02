/**
 * CLI: read clause-label JSONL rows from stdin and upsert into clause_labels.
 * Each line: {"doc_id":..., "char_start":..., "char_end":..., "label":..., "score":...}
 *
 * Usage (via make clf-precompute):
 *   python -m pipeline.classify.precompute_demo | tsx src/db/loadClauseLabels.ts
 */
import * as readline from "node:readline";
// mirrors schemas/clause-label.schema.json
import { ClauseLabelRowSchema } from "./clauseLabelRow.js";
import { withClient, pool } from "./client.js";
import { upsertClauseLabel } from "./clauseLabels.js";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const rows: Awaited<ReturnType<typeof ClauseLabelRowSchema.parseAsync>>[] = [];

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  rows.push(ClauseLabelRowSchema.parse(JSON.parse(trimmed)));
}

await withClient(async (client) => {
  for (const row of rows) {
    await upsertClauseLabel(
      client,
      row.doc_id,
      row.char_start,
      row.char_end,
      row.label,
      row.score,
    );
  }
});

console.log(`loadClauseLabels: upserted ${rows.length} rows`);
await pool.end();
