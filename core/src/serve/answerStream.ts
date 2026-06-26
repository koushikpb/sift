import type { Candidate } from "../retrieve/retrieve.js";
import type { GenInput, RawGen } from "../generate/types.js";
import type { ClauseCard } from "../schemas/clauseCard.js";
import { toClauseCard } from "../generate/toClauseCard.js";

export type AnswerEvent =
  | { type: "status"; phase: "retrieving" | "generating"; message: string }
  | { type: "card"; card: ClauseCard }
  | { type: "error"; message: string }
  | { type: "done" };

export interface AnswerDeps {
  retrieve: (objective: string, docId: string, k: number) => Promise<Candidate[]>;
  generate: (input: GenInput) => Promise<RawGen>;
}

/**
 * Ordered async stream of typed events for a single clause-review query.
 * Always terminates with a `done` event, including on error.
 * Inject `retrieve` and `generate` via `deps` — no DB/network coupling here.
 */
export async function* streamAnswer(
  objective: string,
  docId: string,
  deps: AnswerDeps,
  k = 8,
): AsyncGenerator<AnswerEvent> {
  yield { type: "status", phase: "retrieving", message: "Retrieving clauses…" };

  try {
    const candidates = await deps.retrieve(objective, docId, k);

    yield { type: "status", phase: "generating", message: "Generating answer…" };

    const raw = await deps.generate({ objective, candidates });
    const card = toClauseCard(objective, raw, candidates);

    yield { type: "card", card };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", message };
  }

  yield { type: "done" };
}

/**
 * Encode a single AnswerEvent as an SSE frame.
 * Format: `event: <type>\ndata: <JSON>\n\n`
 * The whole event object is the JSON payload (discriminant included in `data`).
 */
export function sseEncode(event: AnswerEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
