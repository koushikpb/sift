import { z } from "zod";
import type { Candidate } from "../../retrieve/retrieve.js";
import type { GenInput, RawGen } from "../../generate/types.js";
import type { ClauseCard } from "../../schemas/clauseCard.js";
import { toClauseCard } from "../../generate/toClauseCard.js";
import type { ToolDef } from "./types.js";

export interface RetrieveClauseDeps {
  retrieve: (objective: string, docId: string, k: number) => Promise<Candidate[]>;
  generate: (input: GenInput) => Promise<RawGen>;
}

export interface RetrieveClauseInput {
  objective: string;
  doc_id: string;
}

const inputShape = {
  objective: z.string().min(1),
  doc_id: z.string().min(1),
};

/**
 * retrieve_clause: the Layer 1 RAG wrapped as a tool. Retrieves top-k candidates, generates a
 * grounded answer, and returns a ClauseCard whose citations resolve by construction (toClauseCard
 * derives every citation from a candidate's known-good span). Refuses instead of inventing.
 */
export function makeRetrieveClauseTool(deps: RetrieveClauseDeps, k = 8): ToolDef<RetrieveClauseInput, ClauseCard> {
  return {
    name: "retrieve_clause",
    title: "Retrieve & ground a clause",
    description: "Find the clause answering an objective in a contract and return a cited, grounded answer (or refuse).",
    sideEffect: "read",
    inputShape,
    async run(input: RetrieveClauseInput): Promise<ClauseCard> {
      const candidates = await deps.retrieve(input.objective, input.doc_id, k);
      const raw = await deps.generate({ objective: input.objective, candidates });
      return toClauseCard(input.objective, raw, candidates);
    },
  };
}
