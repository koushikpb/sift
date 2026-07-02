/**
 * Zod schema for one clause-label JSONL row.
 *
 * // mirrors schemas/clause-label.schema.json
 *
 * Extracted here (not inlined in the CLI) so it can be imported by tests
 * without triggering the top-level stdin reader in loadClauseLabels.ts.
 */
import { z } from "zod";

export const ClauseLabelRowSchema = z
  .object({
    doc_id: z.string().min(1),
    char_start: z.number().int().min(0),
    char_end: z.number().int().min(1),
    label: z.string().min(1),
    score: z.number().min(0).max(1),
  })
  .strict()
  .refine((r) => r.char_end > r.char_start, {
    message: "char_end must be greater than char_start",
    path: ["char_end"],
  });

export type ClauseLabelRow = z.infer<typeof ClauseLabelRowSchema>;
