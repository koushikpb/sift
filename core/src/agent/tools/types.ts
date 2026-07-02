import { z } from "zod";
import { SpanSchema } from "../../schemas/clauseCard.js";

/** A grounded citation: quote === raw_text.slice(char_start, char_end). Reuses the clause-card span. */
export const CitationSchema = SpanSchema;
export type Citation = z.infer<typeof CitationSchema>;

const Severity = z.enum(["low", "medium", "high"]);

/** A named field extracted from the contract; citation is null when the field was not grounded. */
export const ExtractedFieldSchema = z
  .object({ name: z.string().min(1), value: z.string(), citation: CitationSchema.nullable() })
  .strict();
export type ExtractedField = z.infer<typeof ExtractedFieldSchema>;

/** Output of the P3 LoRA classifier for one clause. */
export const ClauseClassificationSchema = z
  .object({ clause_type: z.string().min(1), score: z.number() })
  .strict();
export type ClauseClassification = z.infer<typeof ClauseClassificationSchema>;

/**
 * A playbook position surfaced against a clause. deviation=true means a red-flag / non-standard
 * term. citation is null only for a missing-required-clause finding (grounded in absence).
 */
export const ReviewFlagSchema = z
  .object({
    playbook_id: z.string().min(1),
    clause_type: z.string().min(1),
    severity: Severity,
    deviation: z.boolean(),
    rationale: z.string(),
    citation: CitationSchema.nullable(),
  })
  .strict();
export type ReviewFlag = z.infer<typeof ReviewFlagSchema>;

/** A grounded, playbook-compliant redline proposal for a flagged clause. */
export const RedlineProposalSchema = z
  .object({
    playbook_id: z.string().min(1),
    original: CitationSchema,
    suggested_text: z.string().min(1),
    rationale: z.string(),
  })
  .strict();
export type RedlineProposal = z.infer<typeof RedlineProposalSchema>;

/** The assembled review memo (the export_memo artifact). generated_at is injected by the caller. */
export const ReviewMemoSchema = z
  .object({
    doc_id: z.string().min(1),
    objective: z.string(),
    fields: z.array(ExtractedFieldSchema),
    flags: z.array(ReviewFlagSchema),
    redlines: z.array(RedlineProposalSchema),
    generated_at: z.string(),
  })
  .strict();
export type ReviewMemo = z.infer<typeof ReviewMemoSchema>;

export type SideEffect = "read" | "write";

/**
 * A tool the agent and the MCP server both consume. `inputShape` is a Zod raw shape so it can be
 * passed straight to MCP `registerTool` AND wrapped with `z.object(inputShape)` for validation.
 * `run` receives already-validated input. `sideEffect: "write"` marks a tool that must be HITL-gated.
 */
export interface ToolDef<I, O> {
  name: string;
  title: string;
  description: string;
  sideEffect: SideEffect;
  inputShape: z.ZodRawShape;
  run(input: I): Promise<O>;
}
