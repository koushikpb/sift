import { z } from "zod";

export const NodeType = z.enum([
  "preamble", "recital", "article", "section",
  "subsection", "definition", "exhibit", "clause",
]);

export const NodeSchema = z.object({
  node_id: z.string().min(1),
  parent_id: z.string().nullable(),
  type: NodeType,
  number: z.string().nullable(),
  heading: z.string().nullable(),
  text: z.string(),
  char_start: z.number().int().nonnegative(),
  char_end: z.number().int().nonnegative(),
  depth: z.number().int().nonnegative(),
}).strict();

export const ParsedDocumentSchema = z.object({
  doc_id: z.string().min(1),
  source: z.enum(["cuad", "contractnli"]),
  title: z.string().nullable(),
  contract_type: z.string(),
  raw_text: z.string(),
  char_length: z.number().int().nonnegative(),
  raw_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  nodes: z.array(NodeSchema),
}).strict();

export type Node = z.infer<typeof NodeSchema>;
export type ParsedDocument = z.infer<typeof ParsedDocumentSchema>;
