import { reviewContract } from "../agent/reviewAgent.js";
import type { ReviewDeps, ReviewResult } from "../agent/reviewAgent.js";
import type { Citation, ClauseClassification, ReviewFlag, RedlineProposal } from "../agent/tools/types.js";

/**
 * SSE events for a single contract review. Mirrors AnswerEvent (see answerStream.ts): a run of
 * `status` events, then one or more `clause` events, then `done` — or `status` → `error` → `done`
 * on a system failure. Each `clause` is one reviewed position: its playbook flag (severity,
 * deviation, rationale), the LoRA clause-type classification, the grounding citation, and a
 * redline proposal when the position deviates. `refused: true` means the objective could not be
 * grounded at all (out of scope) — a correct outcome, not a system error.
 */
export type ReviewEvent =
  | { type: "status"; phase: string; message: string }
  | {
      type: "clause";
      citation: Citation | null;
      classification: ClauseClassification | null;
      flag: ReviewFlag | null;
      redline: RedlineProposal | null;
      refused: boolean;
      refusal_reason: string | null;
    }
  | { type: "error"; message: string }
  | { type: "done" };

/** Human-readable narration for each reviewContract trajectory step. */
const STEP_MESSAGES: Record<string, string> = {
  retrieve_clause: "Retrieving the clause…",
  check_playbook: "Checking the playbook position…",
  classify_clause: "Classifying the clause…",
  flag_risks: "Flagging deviations…",
  draft_redline: "Drafting a redline…",
  export_memo: "Rendering the review memo (preview only)…",
};

/**
 * Translate a completed ReviewResult into its `clause` event(s).
 * - Out-of-scope refusal (no playbook position identified, nothing grounded): one refusal clause.
 * - Grounded with playbook flags (0..n — currently 0 or 1): one clause event per flag, carrying
 *   its citation (null only for a missing-required-clause finding), the shared classification,
 *   and its matching redline if the position deviates.
 * - Grounded with no playbook position matched: one clause event describing the found clause.
 */
function clauseEventsFor(result: ReviewResult): ReviewEvent[] {
  if (result.refused) {
    return [
      {
        type: "clause",
        citation: null,
        classification: null,
        flag: null,
        redline: null,
        refused: true,
        refusal_reason: result.card.refusal_reason ?? "insufficient context",
      },
    ];
  }

  if (result.flags.length === 0) {
    return [
      {
        type: "clause",
        citation: result.card.citations[0] ?? null,
        classification: result.classification,
        flag: null,
        redline: null,
        refused: false,
        refusal_reason: null,
      },
    ];
  }

  return result.flags.map((flag) => ({
    type: "clause",
    citation: flag.citation,
    classification: result.classification,
    flag,
    redline: result.redlines.find((r) => r.playbook_id === flag.playbook_id) ?? null,
    refused: false,
    refusal_reason: null,
  }));
}

/**
 * Ordered async stream of typed events for a single contract review. Runs `reviewContract` to
 * completion, narrates its trajectory as `status` events, then emits the resulting `clause`
 * event(s). Always terminates with `done`, including on error. `export_memo` is invoked by
 * `reviewContract` itself only in preview mode (confirm left unset) — this stream never confirms
 * a write (HITL gate); inject `deps` — no DB/network coupling here.
 */
export async function* streamReview(
  objective: string,
  docId: string,
  deps: ReviewDeps,
  opts?: { generatedAt?: string },
): AsyncGenerator<ReviewEvent> {
  yield { type: "status", phase: "reviewing", message: "Starting review…" };

  try {
    const generatedAt = opts?.generatedAt ?? new Date().toISOString();
    const result = await reviewContract(objective, docId, deps, { generatedAt });

    for (const step of result.trajectory) {
      yield { type: "status", phase: step, message: STEP_MESSAGES[step] ?? step };
    }

    for (const event of clauseEventsFor(result)) {
      yield event;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", message };
  }

  yield { type: "done" };
}

/**
 * Encode a single ReviewEvent as an SSE frame.
 * Format: `event: <type>\ndata: <JSON>\n\n`
 * The whole event object is the JSON payload (discriminant included in `data`).
 */
export function sseEncode(event: ReviewEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
