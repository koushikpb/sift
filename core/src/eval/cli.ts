import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createReadStream, existsSync } from "node:fs";
import { GoldLabelSchema, type GoldLabel } from "../schemas/goldLabel.js";
import { loadPlaybook, playbookIds } from "./playbook.js";
import { deriveCandidates } from "./derive.js";
import { validateEvalSet } from "./validate.js";
import { EvalItemSchema } from "./evalItem.js";
import { runEval } from "./runEval.js";
import { compareReports, formatDelta } from "./compare.js";
import { retrieve } from "../retrieve/retrieve.js";
import { makeGenerator } from "../generate/index.js";
import { withClient } from "../db/client.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cmd = process.argv[2];

async function readGold(): Promise<GoldLabel[]> {
  const out: GoldLabel[] = [];
  for (const s of ["cuad", "contractnli"]) {
    const p = `${root}data/processed/${s}/gold.jsonl`;
    if (!existsSync(p)) continue;
    const rl = createInterface({ input: createReadStream(p, "utf-8"), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim()) out.push(GoldLabelSchema.parse(JSON.parse(line)));
    }
  }
  return out;
}

if (cmd === "derive") {
  const pb = playbookIds(loadPlaybook(`${root}evals/playbook/nda.yaml`));
  const candidates = deriveCandidates(await readGold(), pb);
  const out = `${root}evals/data/candidates.jsonl`;
  writeFileSync(out, candidates.map((c) => JSON.stringify(c)).join("\n") + "\n");
  console.log(`wrote ${candidates.length} candidates -> ${out}`);
  process.exit(0);
} else if (cmd === "validate") {
  const items = JSON.parse(readFileSync(`${root}evals/data/eval-set-v1.json`, "utf-8"));
  const r = await validateEvalSet(items);
  console.log(JSON.stringify(r.stats, null, 2));
  if (!r.ok) {
    console.error("VALIDATION FAILED:\n" + r.errors.map((e) => " - " + e).join("\n"));
    process.exit(1);
  }
  console.log("eval set v1 OK");
  process.exit(0);
} else if (cmd === "run") {
  const rawItems = JSON.parse(readFileSync(`${root}evals/data/eval-set-v1.json`, "utf-8")) as unknown[];
  const items = rawItems.map((entry) => EvalItemSchema.parse(entry));
  const k = Number(process.env.EVAL_K ?? 8);
  if (!Number.isFinite(k) || k <= 0 || !Number.isInteger(k)) {
    process.stderr.write(
      `error: EVAL_K="${process.env.EVAL_K}" is not a valid positive integer — ` +
        `got ${k}. Set EVAL_K to a positive integer (e.g. EVAL_K=8) or leave it unset to use the default of 8.\n`,
    );
    process.exit(2);
  }

  const rawTextCache = new Map<string, string | null>();
  async function rawText(docId: string): Promise<string | null> {
    if (!rawTextCache.has(docId)) {
      const row = await withClient((c) =>
        c.query("SELECT raw_text FROM documents WHERE doc_id=$1", [docId]),
      );
      rawTextCache.set(docId, row.rowCount ? row.rows[0].raw_text : null);
    }
    return rawTextCache.get(docId)!;
  }

  const gen = makeGenerator();
  const deps = {
    retrieve,
    generate: gen.generate.bind(gen),
    rawText,
    onProgress: (done: number, total: number, item: { id: string }) =>
      process.stderr.write(`item ${done}/${total} ${item.id}\n`),
  };

  const report = await runEval(items, deps, k);

  // Provenance: record which provider/model produced this report (env-resolved,
  // matching how makeGenerator() picks them) so a committed baseline is reproducible.
  const provider = process.env.LLM_PROVIDER ?? "openai";
  const model = process.env.LLM_MODEL ?? null;

  mkdirSync(`${root}evals/reports`, { recursive: true });
  writeFileSync(
    `${root}evals/reports/baseline.json`,
    JSON.stringify({ provider, model, ...report }, null, 2) + "\n",
  );

  console.log(JSON.stringify({
    k: report.k,
    total: report.total,
    aggregates: report.aggregates,
  }, null, 2));
  process.exit(0);
} else if (cmd === "compare") {
  const [aArg, bArg] = process.argv.slice(3);
  if (!aArg || !bArg) {
    console.error("usage: tsx src/eval/cli.ts compare <baselineFile> <candidateFile>  (files under evals/reports/)");
    process.exit(2);
  }
  const a = JSON.parse(readFileSync(`${root}evals/reports/${aArg}`, "utf-8"));
  const b = JSON.parse(readFileSync(`${root}evals/reports/${bArg}`, "utf-8"));
  console.log(formatDelta(compareReports(a, b)));
  process.exit(0);
} else {
  console.error("usage: tsx src/eval/cli.ts <derive|validate|run|compare>");
  process.exit(2);
}
