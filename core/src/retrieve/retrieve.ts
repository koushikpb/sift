import { denseRetrieve } from "./dense.js";
import { hybridRetrieve } from "./hybrid.js";
import { agenticRetrieve } from "../agent/loop.js";
import type { Candidate } from "./types.js";

export type { Candidate } from "./types.js";

export type RetrieveFn = (query: string, docId: string, k?: number) => Promise<Candidate[]>;

/** Select a retrieval strategy. naive = dense cosine top-k (P1); hybrid = P2a; agentic = P2c. */
export function makeRetriever(mode: string | undefined): RetrieveFn {
  if (mode === "hybrid") return (q, d, k = 8) => hybridRetrieve(q, d, k);
  if (mode === "agentic") return (q, d, k = 8) => agenticRetrieve(q, d, k);
  return (q, d, k = 8) => denseRetrieve(q, d, k); // default: naive
}

/** Back-compat entry point: resolves the mode from RETRIEVE_MODE (default naive). */
export function retrieve(query: string, docId: string, k = 8): Promise<Candidate[]> {
  return makeRetriever(process.env.RETRIEVE_MODE)(query, docId, k);
}
