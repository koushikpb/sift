import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createReadStream, existsSync } from "node:fs";
import { GoldLabelSchema, type GoldLabel } from "../schemas/goldLabel.js";
import { loadPlaybook, playbookIds } from "./playbook.js";
import { deriveCandidates } from "./derive.js";
import { validateEvalSet } from "./validate.js";

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
} else {
  console.error("usage: tsx src/eval/cli.ts <derive|validate>");
  process.exit(2);
}
