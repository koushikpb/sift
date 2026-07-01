import type { ClauseCard } from "../schemas/clauseCard.js";
import type { PlaybookEntry } from "../eval/playbook.js";
import type { Citation, ClauseClassification, ReviewFlag, RedlineProposal, ReviewMemo, ToolDef } from "./tools/types.js";
import type { RetrieveClauseInput } from "./tools/retrieveClause.js";
import type { ClassifyInput } from "./tools/classifyClause.js";
import type { FlagRisksInput } from "./tools/flagRisks.js";
import type { DraftRedlineInput } from "./tools/draftRedline.js";
import type { ExportMemoInput, ExportMemoResult } from "./tools/exportMemo.js";
import { playbookForObjective } from "./tools/playbookMatch.js";

export interface ReviewDeps {
  playbook: PlaybookEntry[];
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
 * The action agent: a deterministic tool trajectory. Selects the playbook position from the
 * objective (the review request); retrieves the clause; if it is absent, flags it as a MISSING
 * required clause (when a position was identified) or refuses (out of scope). Otherwise classifies
 * it (metadata), judges deviation against the position, drafts a redline for any deviation, and
 * renders a memo PREVIEW (never confirmed here — a human confirms an export out-of-band).
 * Deterministic so the agent-eval trajectory is reproducible.
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

  // check_playbook: which playbook position does this objective concern? (from the request)
  trajectory.push("check_playbook");
  const entry = playbookForObjective(objective, deps.playbook);

  // Ungrounded clause. If a required position was identified, this is a MISSING required clause
  // (a real risk grounded in absence → citation:null); otherwise a genuine refusal (out of scope).
  if (card.refused || card.citations.length === 0) {
    const flags: ReviewFlag[] = entry
      ? [{
          playbook_id: entry.playbook_id, clause_type: entry.clause_type, severity: entry.severity,
          deviation: true, rationale: "required clause appears absent (not found in contract)", citation: null,
        }]
      : [];
    const memoDoc: ReviewMemo = { doc_id: docId, objective, fields: [], flags, redlines: [], generated_at: generatedAt };
    trajectory.push(deps.exportMemo.name);
    const memo = await deps.exportMemo.run({ memo: memoDoc });
    return { card, classification: null, flags, redlines: [], memo, trajectory, refused: flags.length === 0 };
  }

  const citation = card.citations[0];
  const clauseText = citation.quote;

  trajectory.push(deps.classifyClause.name);
  const classification = await deps.classifyClause.run({ text: clauseText });

  const flags: ReviewFlag[] = [];
  if (entry) {
    trajectory.push(deps.flagRisks.name);
    const flag = await deps.flagRisks.run({ clause_text: clauseText, clause_type: entry.clause_type, citation });
    if (flag) flags.push(flag);
  }

  const redlines: RedlineProposal[] = [];
  for (const f of flags.filter((x): x is ReviewFlag & { citation: Citation } => x.deviation && x.citation !== null)) {
    trajectory.push(deps.draftRedline.name);
    redlines.push(await deps.draftRedline.run({ flag: f, clause_text: clauseText }));
  }

  const memoDoc: ReviewMemo = {
    doc_id: docId, objective,
    fields: [{ name: objective, value: card.answer, citation }],
    flags, redlines, generated_at: generatedAt,
  };
  trajectory.push(deps.exportMemo.name);
  const memo = await deps.exportMemo.run({ memo: memoDoc });

  return { card, classification, flags, redlines, memo, trajectory, refused: false };
}
