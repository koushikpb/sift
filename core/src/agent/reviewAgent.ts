import type { ClauseCard } from "../schemas/clauseCard.js";
import type { ClauseClassification, ReviewFlag, RedlineProposal, ReviewMemo, ToolDef } from "./tools/types.js";
import type { RetrieveClauseInput } from "./tools/retrieveClause.js";
import type { ClassifyInput } from "./tools/classifyClause.js";
import type { FlagRisksInput } from "./tools/flagRisks.js";
import type { DraftRedlineInput } from "./tools/draftRedline.js";
import type { ExportMemoInput, ExportMemoResult } from "./tools/exportMemo.js";

export interface ReviewDeps {
  retrieveClause: ToolDef<RetrieveClauseInput, ClauseCard>;
  classifyClause: ToolDef<ClassifyInput, ClauseClassification>;
  flagRisks: ToolDef<FlagRisksInput, ReviewFlag | null>;
  draftRedline: ToolDef<DraftRedlineInput, RedlineProposal>;
  exportMemo: ToolDef<ExportMemoInput, ExportMemoResult>;
}

export interface ReviewResult {
  card: ClauseCard;
  classification: ClauseClassification | null;
  flags: ReviewFlag[];
  redlines: RedlineProposal[];
  memo: ExportMemoResult;
  trajectory: string[];
  refused: boolean;
}

/**
 * The action agent: a deterministic tool trajectory. Retrieve the clause; if ungrounded, refuse and
 * stop (no downstream claims). Otherwise classify it, flag it against the playbook, draft a redline
 * for any deviation, and render a memo PREVIEW (never confirmed here — the human confirms an export
 * out-of-band). Deterministic so the agent-eval trajectory is reproducible.
 */
export async function reviewContract(
  objective: string,
  docId: string,
  deps: ReviewDeps,
  opts?: { generatedAt: string },
): Promise<ReviewResult> {
  const trajectory: string[] = [];
  const generatedAt = opts?.generatedAt ?? "unknown";

  trajectory.push(deps.retrieveClause.name);
  const card = await deps.retrieveClause.run({ objective, doc_id: docId });

  if (card.refused || card.citations.length === 0) {
    const memo = await deps.exportMemo.run({
      memo: { doc_id: docId, objective, fields: [], flags: [], redlines: [], generated_at: generatedAt },
    });
    return { card, classification: null, flags: [], redlines: [], memo, trajectory, refused: true };
  }

  const citation = card.citations[0];
  const clauseText = citation.quote;

  trajectory.push(deps.classifyClause.name);
  const classification = await deps.classifyClause.run({ text: clauseText });

  trajectory.push(deps.flagRisks.name);
  const flag = await deps.flagRisks.run({ clause_text: clauseText, clause_type: classification.clause_type, citation });
  const flags = flag ? [flag] : [];

  const redlines: RedlineProposal[] = [];
  for (const f of flags.filter((x) => x.deviation)) {
    trajectory.push(deps.draftRedline.name);
    redlines.push(await deps.draftRedline.run({ flag: f, clause_text: clauseText }));
  }

  const memoDoc: ReviewMemo = {
    doc_id: docId, objective,
    fields: [{ name: objective, value: card.answer, citation }],
    flags, redlines, generated_at: generatedAt,
  };
  trajectory.push(deps.exportMemo.name);
  const memo = await deps.exportMemo.run({ memo: memoDoc });   // preview only — no confirm

  return { card, classification, flags, redlines, memo, trajectory, refused: false };
}
