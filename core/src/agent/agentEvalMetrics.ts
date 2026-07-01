import { overlaps } from "../eval/metrics.js";
import type { EvalItem } from "../eval/evalItem.js";
import type { ReviewResult } from "./reviewAgent.js";

/** Fraction of expected playbook_ids that appear among produced flags. null when none expected. */
export function flagCoverage(
  expected: { playbook_id: string }[],
  produced: { playbook_id: string }[],
): number | null {
  if (expected.length === 0) return null;
  const have = new Set(produced.map((p) => p.playbook_id));
  const hit = expected.filter((e) => have.has(e.playbook_id)).length;
  return hit / expected.length;
}

/** Grader-specific end-to-end success for one item. */
export function taskSuccess(item: EvalItem, result: ReviewResult): boolean {
  switch (item.grader) {
    case "refusal":
      return result.refused;
    case "span_match":
      return result.card.citations.some((c) => item.gold_spans.some((g) => overlaps(c, g)));
    case "flag_match":
      return (flagCoverage(item.expected_flags, result.flags) ?? 0) >= 1;
    case "field_match":
      return result.card.citations.length > 0 && !result.refused;
    default:
      return false;
  }
}

/** Refusal items should stop after retrieval; answerable items should reach flag_risks. */
export function trajectoryValid(item: EvalItem, result: ReviewResult): boolean {
  if (item.grader === "refusal") return result.refused && result.trajectory[0] === "retrieve_clause" && !result.trajectory.includes("flag_risks");
  if (result.refused) return true; // an answerable item that legitimately refused still has a valid (short) trajectory
  return result.trajectory.includes("retrieve_clause") && result.trajectory.includes("flag_risks");
}
