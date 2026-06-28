import { denseRetrieve } from "./dense.js";
import type { Candidate } from "./types.js";

export type { Candidate } from "./types.js";

/** Naive baseline: single-embedding, document-scoped cosine top-k over pgvector. */
export function retrieve(query: string, docId: string, k = 8): Promise<Candidate[]> {
  return denseRetrieve(query, docId, k);
}
