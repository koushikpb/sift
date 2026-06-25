import { z } from "zod";

export const SpanSchema = z.object({
  char_start: z.number().int().nonnegative(),
  char_end: z.number().int().nonnegative(),
  quote: z.string(),
}).strict();

export const GoldLabelSchema = z.object({
  label_id: z.string().min(1),
  doc_id: z.string().min(1),
  source: z.enum(["cuad", "contractnli"]),
  kind: z.enum(["clause_span", "nli"]),
  clause_type: z.string().nullish(),
  hypothesis: z.string().nullish(),
  nli_label: z.enum(["entailment", "contradiction", "not_mentioned"]).nullish(),
  spans: z.array(SpanSchema),
}).strict();

export type Span = z.infer<typeof SpanSchema>;
export type GoldLabel = z.infer<typeof GoldLabelSchema>;
