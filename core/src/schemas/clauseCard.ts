import { z } from "zod";

export const SpanSchema = z
  .object({
    doc_id: z.string().min(1),
    char_start: z.number().int().nonnegative(),
    char_end: z.number().int().nonnegative(),
    quote: z.string(),
  })
  .strict();

export const ClauseCardSchema = z
  .object({
    objective: z.string().min(1),
    answer: z.string(),
    citations: z.array(SpanSchema),
    refused: z.boolean(),
    refusal_reason: z.string().nullish(),
  })
  .strict();

export type Span = z.infer<typeof SpanSchema>;
export type ClauseCard = z.infer<typeof ClauseCardSchema>;

/** Throw unless every citation's quote equals its slice of the document's raw_text. */
export function assertCardCitations(card: ClauseCard, rawTextByDoc: Map<string, string>): void {
  for (const c of card.citations) {
    const raw = rawTextByDoc.get(c.doc_id);
    if (raw == null) throw new Error(`citation integrity: unknown doc ${c.doc_id}`);
    if (raw.slice(c.char_start, c.char_end) !== c.quote) {
      throw new Error(`citation integrity violation in ${c.doc_id} [${c.char_start},${c.char_end})`);
    }
  }
}
