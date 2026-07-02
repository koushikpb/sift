import { z } from "zod";
import { fileURLToPath } from "node:url";
import type { ClauseCard } from "../schemas/clauseCard.js";
import { loadPlaybook } from "../eval/playbook.js";
import { withClient } from "../db/client.js";
import { getClauseLabel } from "../db/clauseLabels.js";
import { reviewContract } from "./reviewAgent.js";
import type { ReviewDeps, ReviewResult } from "./reviewAgent.js";
import { makeRetrieveClauseTool } from "./tools/retrieveClause.js";
import type { RetrieveClauseDeps, RetrieveClauseInput } from "./tools/retrieveClause.js";
import type { ClassifyInput } from "./tools/classifyClause.js";
import { makeFlagRisksTool, defaultDeviationJudge } from "./tools/flagRisks.js";
import { makeDraftRedlineTool, defaultRedlineWriter } from "./tools/draftRedline.js";
import { makeExportMemoTool } from "./tools/exportMemo.js";
import type { Citation, ClauseClassification, ToolDef } from "./tools/types.js";

export { reviewContract };
export type { ReviewDeps, ReviewResult };

const playbookPath = fileURLToPath(new URL("../../../evals/playbook/nda.yaml", import.meta.url));

/**
 * Assemble a real ReviewDeps for the hosted demo (Task 5's /api/review). Mirrors
 * mcp/tools.ts's buildTools, but the classify dep reads the precomputed clause_labels table
 * (Task 4) instead of spawning Python — required for Vercel serverless (no Python runtime).
 *
 * classify_clause's ToolDef input is `{text}` only (no span — see tools/classifyClause.ts), so
 * the precomputed lookup needs the citation span from another source: we capture it from the
 * immediately-preceding retrieve_clause call via a closure. This is safe because reviewContract's
 * trajectory always classifies the clause it just retrieved (see reviewAgent.ts) — never a
 * different one.
 *
 * export_memo's writer throws if ever invoked: reviewContract never sets confirm:true, so normal
 * operation never reaches it. Throwing (rather than silently writing or no-op'ing) makes the HITL
 * gate a hard backstop at the dependency boundary, not just a convention callers must uphold.
 */
export function buildReviewDeps(docId: string, io: RetrieveClauseDeps, k = 8): ReviewDeps {
  const entries = loadPlaybook(playbookPath);

  let lastCitation: Citation | null = null;
  const baseRetrieveClause = makeRetrieveClauseTool(io, k);
  const retrieveClause: ToolDef<RetrieveClauseInput, ClauseCard> = {
    ...baseRetrieveClause,
    async run(input: RetrieveClauseInput): Promise<ClauseCard> {
      const card = await baseRetrieveClause.run(input);
      lastCitation = card.citations[0] ?? null;
      return card;
    },
  };

  const classifyClause: ToolDef<ClassifyInput, ClauseClassification> = {
    name: "classify_clause",
    title: "Classify a clause (precomputed LoRA label)",
    description:
      "Look up the precomputed LoRA clause-type label for the most recently retrieved citation (Task 4 clause_labels table). No Python subprocess.",
    sideEffect: "read",
    inputShape: { text: z.string().min(1) },
    async run(): Promise<ClauseClassification> {
      if (!lastCitation) return { clause_type: "unclassified", score: 0 };
      const { char_start, char_end } = lastCitation;
      const row = await withClient((client) => getClauseLabel(client, docId, char_start, char_end));
      return row ? { clause_type: row.label, score: row.score } : { clause_type: "unclassified", score: 0 };
    },
  };

  const judge = defaultDeviationJudge();
  const redline = defaultRedlineWriter();

  return {
    playbook: entries,
    retrieveClause,
    classifyClause,
    flagRisks: makeFlagRisksTool({ judge: judge.judge }, entries),
    draftRedline: makeDraftRedlineTool({ suggest: redline.suggest }),
    exportMemo: makeExportMemoTool({
      writeFile: async () => {
        throw new Error("export_memo: filesystem writes are disabled in the serve path (HITL gate — confirm is never set)");
      },
    }),
  };
}
