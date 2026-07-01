import type { Candidate } from "../retrieve/retrieve.js";
import type { GenInput, RawGen } from "../generate/types.js";
import type { PlaybookEntry } from "../eval/playbook.js";
import { loadPlaybook } from "../eval/playbook.js";
import { fileURLToPath } from "node:url";
import type { ReviewFlag, ToolDef } from "../agent/tools/types.js";
import { makeRetrieveClauseTool } from "../agent/tools/retrieveClause.js";
import { makeExtractFieldsTool } from "../agent/tools/extractFields.js";
import { makeClassifyClauseTool, type Prediction } from "../agent/tools/classifyClause.js";
import { makeFlagRisksTool } from "../agent/tools/flagRisks.js";
import { makeDraftRedlineTool } from "../agent/tools/draftRedline.js";
import { makeExportMemoTool } from "../agent/tools/exportMemo.js";

export interface BuildDeps {
  retrieve: (objective: string, docId: string, k: number) => Promise<Candidate[]>;
  generate: (input: GenInput) => Promise<RawGen>;
  runPredict: (texts: string[]) => Promise<Prediction[]>;
  judge: (clauseText: string, entry: PlaybookEntry) => Promise<{ deviation: boolean; rationale: string }>;
  suggest: (flag: ReviewFlag, clauseText: string) => Promise<string>;
  writeFile: (path: string, contents: string) => Promise<void>;
}

const playbookPath = fileURLToPath(new URL("../../../evals/playbook/nda.yaml", import.meta.url));

/**
 * Assemble the P4 toolset with real (or injected) deps: the retrieve_clause RAG wrapper plus the
 * five SPEC-list tools (extract_fields, classify_clause, flag_risks incl. check_playbook,
 * draft_redline, export_memo). extract_fields shares retrieve/generate with retrieve_clause.
 */
export function buildTools(deps: BuildDeps): ToolDef<any, any>[] {
  const entries = loadPlaybook(playbookPath);
  return [
    makeRetrieveClauseTool({ retrieve: deps.retrieve, generate: deps.generate }),
    makeExtractFieldsTool({ retrieve: deps.retrieve, generate: deps.generate }),
    makeClassifyClauseTool({ runPredict: deps.runPredict }),
    makeFlagRisksTool({ judge: deps.judge }, entries),
    makeDraftRedlineTool({ suggest: deps.suggest }),
    makeExportMemoTool({ writeFile: deps.writeFile }),
  ];
}
