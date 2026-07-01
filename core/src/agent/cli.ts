import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { EvalItemSchema } from "../eval/evalItem.js";
import { withClient } from "../db/client.js";
import { makeRetriever } from "../retrieve/retrieve.js";
import { makeGenerator } from "../generate/index.js";
import { loadPlaybook } from "../eval/playbook.js";
import { makeRetrieveClauseTool } from "./tools/retrieveClause.js";
import { makeClassifyClauseTool, defaultRunPredict } from "./tools/classifyClause.js";
import { makeFlagRisksTool, defaultDeviationJudge } from "./tools/flagRisks.js";
import { makeDraftRedlineTool, defaultRedlineWriter } from "./tools/draftRedline.js";
import { makeExportMemoTool } from "./tools/exportMemo.js";
import { runAgentEval } from "./agentEval.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

async function main(): Promise<void> {
  const rawItems = JSON.parse(readFileSync(`${root}evals/data/eval-set-v1.json`, "utf-8")) as unknown[];
  const items = rawItems.map((e) => EvalItemSchema.parse(e));

  const rawTextCache = new Map<string, string | null>();
  async function rawText(docId: string): Promise<string | null> {
    if (!rawTextCache.has(docId)) {
      const row = await withClient((c) => c.query("SELECT raw_text FROM documents WHERE doc_id=$1", [docId]));
      rawTextCache.set(docId, row.rowCount ? row.rows[0].raw_text : null);
    }
    return rawTextCache.get(docId)!;
  }

  const retrieve = makeRetriever(process.env.RETRIEVE_MODE ?? "agentic");
  const gen = makeGenerator();
  const entries = loadPlaybook(`${root}evals/playbook/nda.yaml`);
  const judge = defaultDeviationJudge();
  const redline = defaultRedlineWriter();

  const reviewDeps = {
    retrieveClause: makeRetrieveClauseTool({ retrieve, generate: gen.generate.bind(gen) }),
    classifyClause: makeClassifyClauseTool({ runPredict: defaultRunPredict }),
    flagRisks: makeFlagRisksTool({ judge: judge.judge }, entries),
    draftRedline: makeDraftRedlineTool({ suggest: redline.suggest }),
    exportMemo: makeExportMemoTool({ writeFile: async (p, c) => { await mkdir(dirname(p), { recursive: true }); await fsWriteFile(p, c); } }),
  };

  const generatedAt = new Date().toISOString();
  const report = await runAgentEval(items, reviewDeps, { rawText, generatedAt });

  mkdirSync(`${root}evals/reports`, { recursive: true });
  writeFileSync(`${root}evals/reports/p4_agent.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report.aggregates, null, 2));
  process.exit(0);
}

main().catch((e) => { process.stderr.write(String(e) + "\n"); process.exit(1); });
