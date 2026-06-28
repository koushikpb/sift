import type { EvalReport, ItemResult } from "./runEval.js";

export interface MetricRow {
  metric: string;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
}

const ANSWERABLE = new Set(["clean", "deviated"]);

/**
 * False-negative rate: of the answerable items (category clean | deviated), the fraction
 * where the required clause was missed — the item refused, or the gold span was never
 * retrieved into the top-k (recall_at_k === 0), so the answer could not cite it.
 */
export function falseNegativeRate(items: ItemResult[]): number | null {
  const answerable = items.filter((i) => ANSWERABLE.has(i.category));
  if (answerable.length === 0) return null;
  const missed = answerable.filter((i) => i.refused || i.recall_at_k === 0).length;
  return missed / answerable.length;
}

export function compareReports(baseline: EvalReport, candidate: EvalReport): MetricRow[] {
  const rows: [string, number | null, number | null][] = [
    ["recall@k", baseline.aggregates.mean_recall_at_k, candidate.aggregates.mean_recall_at_k],
    ["ndcg@k", baseline.aggregates.mean_ndcg_at_k, candidate.aggregates.mean_ndcg_at_k],
    ["groundedness", baseline.aggregates.mean_groundedness, candidate.aggregates.mean_groundedness],
    ["refusal_rate", baseline.aggregates.refusal_rate, candidate.aggregates.refusal_rate],
    ["false_negative_rate", falseNegativeRate(baseline.items), falseNegativeRate(candidate.items)],
  ];
  return rows.map(([metric, b, c]) => ({
    metric,
    baseline: b,
    candidate: c,
    delta: b === null || c === null ? null : c - b,
  }));
}

export function formatDelta(rows: MetricRow[]): string {
  const fmt = (x: number | null) => (x === null ? " n/a  " : x.toFixed(4));
  const header = `${"metric".padEnd(20)} ${"baseline".padEnd(8)}    ${"candidate".padEnd(9)}  delta`;
  const lines = rows.map((r) => {
    const d = r.delta === null ? " n/a" : (r.delta >= 0 ? "+" : "") + r.delta.toFixed(4);
    return `${r.metric.padEnd(20)} ${fmt(r.baseline)}  →  ${fmt(r.candidate)}   ${d}`;
  });
  return [header, ...lines].join("\n");
}
