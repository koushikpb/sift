import { z } from "zod";
import type { ExtractedField } from "./types.js";
import type { ToolDef } from "./types.js";
import { makeRetrieveClauseTool, type RetrieveClauseDeps } from "./retrieveClause.js";

export interface ExtractFieldsInput {
  objective: string;
  doc_id: string;
  field_name: string;
}

const inputShape = {
  objective: z.string().min(1),
  doc_id: z.string().min(1),
  field_name: z.string().min(1),
};

/**
 * extract_fields: extract one named field for an objective, grounded in a citation. Delegates to
 * retrieve_clause; the grounded answer becomes the field value and its first citation backs it.
 * A refusal yields { value: "", citation: null } — an honest "not found", never a guess.
 */
export function makeExtractFieldsTool(deps: RetrieveClauseDeps, k = 8): ToolDef<ExtractFieldsInput, ExtractedField> {
  const retrieveClause = makeRetrieveClauseTool(deps, k);
  return {
    name: "extract_fields",
    title: "Extract a grounded field",
    description: "Extract a named field (e.g. Governing Law, Term) with a citation, or report it as not found.",
    sideEffect: "read",
    inputShape,
    async run(input: ExtractFieldsInput): Promise<ExtractedField> {
      const card = await retrieveClause.run({ objective: input.objective, doc_id: input.doc_id });
      if (card.refused || card.citations.length === 0) {
        return { name: input.field_name, value: "", citation: null };
      }
      return { name: input.field_name, value: card.answer, citation: card.citations[0] };
    },
  };
}
