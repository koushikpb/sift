import { z } from "zod";

export const EvalItemSchema = z.object({
  id: z.string().min(1),
  doc_id: z.string().min(1),
  source: z.enum(["cuad", "contractnli"]),
  contract_type: z.string(),
  category: z.enum(["clean", "deviated", "missing"]),
  objective: z.string().min(1),
  expected_fields: z.array(z.object({ name: z.string(), value: z.string().nullable() }).strict()),
  expected_flags: z.array(z.object({
    playbook_id: z.string(), severity: z.enum(["low", "medium", "high"]),
  }).strict()),
  gold_spans: z.array(z.object({
    doc_id: z.string(), char_start: z.number().int().nonnegative(),
    char_end: z.number().int().nonnegative(), quote: z.string(),
  }).strict()),
  grader: z.enum(["span_match", "field_match", "flag_match", "refusal"]),
  notes: z.string(),
}).strict();

export type EvalItem = z.infer<typeof EvalItemSchema>;
