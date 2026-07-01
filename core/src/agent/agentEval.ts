import { reviewContract, type ReviewDeps, type ReviewResult } from "./reviewAgent.js";
import { flagCoverage, taskSuccess, trajectoryValid } from "./agentEvalMetrics.js";
import { groundedness } from "../eval/metrics.js";
import type { EvalItem } from "../eval/evalItem.js";

export interface AgentItemResult {
  id: string;
  grader: string;
  success: boolean;
  flag_coverage: number | null;
  groundedness: number | null;
  trajectory_valid: boolean;
  wrote_without_confirm: boolean;
  error: string | null;
}

export interface AgentEvalReport {
  total: number;
  aggregates: {
    task_success_rate: number;
    flag_false_negative_rate: number | null;
    mean_groundedness: number | null;
    refusal_correctness: number | null;
    trajectory_valid_rate: number;
    unconfirmed_writes: number;
  };
  items: AgentItemResult[];
}

export interface AgentEvalDeps {
  rawText: (docId: string) => Promise<string | null>;
  generatedAt: string;
}

function mean(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null);
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
}

/** Run the review agent over eval items and score it. Deps are injected so unit tests use fakes. */
export async function runAgentEval(
  items: readonly EvalItem[],
  reviewDeps: ReviewDeps,
  deps: AgentEvalDeps,
): Promise<AgentEvalReport> {
  const results: AgentItemResult[] = [];

  for (const item of items) {
    let success = false, tvalid = false, wrote = false;
    let cov: number | null = null, grounded: number | null = null, error: string | null = null;
    try {
      const r: ReviewResult = await reviewContract(item.objective, item.doc_id, reviewDeps, { generatedAt: deps.generatedAt });
      success = taskSuccess(item, r);
      tvalid = trajectoryValid(item, r);
      wrote = r.memo.written;                            // must be false — HITL gate
      cov = flagCoverage(item.expected_flags, r.flags);
      if (r.card.citations.length > 0) {
        const raw = await deps.rawText(item.doc_id);
        grounded = groundedness(r.card.citations, () => raw);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    results.push({ id: item.id, grader: item.grader, success, flag_coverage: cov, groundedness: grounded, trajectory_valid: tvalid, wrote_without_confirm: wrote, error });
  }

  // Flag false-negative rate: over items with expected flags, the fraction of expected flags missed.
  const flagItems = results.filter((r) => r.flag_coverage !== null);
  const fnRate = flagItems.length === 0 ? null : mean(flagItems.map((r) => 1 - (r.flag_coverage ?? 0)));

  const refusalItems = results.filter((r) => r.grader === "refusal");
  const refusalCorrectness = refusalItems.length === 0 ? null : refusalItems.filter((r) => r.success).length / refusalItems.length;

  return {
    total: results.length,
    aggregates: {
      task_success_rate: results.length === 0 ? 0 : results.filter((r) => r.success).length / results.length,
      flag_false_negative_rate: fnRate,
      mean_groundedness: mean(results.map((r) => r.groundedness)),
      refusal_correctness: refusalCorrectness,
      trajectory_valid_rate: results.length === 0 ? 0 : results.filter((r) => r.trajectory_valid).length / results.length,
      unconfirmed_writes: results.filter((r) => r.wrote_without_confirm).length,
    },
    items: results,
  };
}
