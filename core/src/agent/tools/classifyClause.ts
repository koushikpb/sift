import { z } from "zod";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ClauseClassification, ToolDef } from "./types.js";

/** The Python→TS classifier prediction (mirrors schemas/clf-prediction.schema.json). */
export const PredictionSchema = z.object({ text: z.string(), label: z.string(), score: z.number() }).strict();
export type Prediction = z.infer<typeof PredictionSchema>;

export interface ClassifyDeps {
  runPredict: (texts: string[]) => Promise<Prediction[]>;
}

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Default bridge: spawn the Python inference CLI, stream JSONL in, parse validated JSONL out.
 * Each stdout line is validated with PredictionSchema — no unvalidated data crosses the boundary.
 */
export async function defaultRunPredict(texts: string[]): Promise<Prediction[]> {
  const py = `${repoRoot}pipeline/.venv/bin/python`;
  const child = spawn(py, ["-m", "pipeline.classify.predict"], { cwd: `${repoRoot}pipeline` });
  child.stdin.write(texts.map((t) => JSON.stringify({ text: t })).join("\n") + "\n");
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  const code: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) throw new Error(`clf predict exited ${code}: ${stderr.slice(0, 500)}`);

  return stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => PredictionSchema.parse(JSON.parse(l)));
}

const inputShape = { text: z.string().min(1) };
export interface ClassifyInput {
  text: string;
}

/**
 * classify_clause: the P3 LoRA clause classifier as a tool. Delegates inference to the Python
 * bridge (injected as deps.runPredict; defaults to the subprocess CLI) and returns a typed label.
 */
export function makeClassifyClauseTool(deps: ClassifyDeps): ToolDef<ClassifyInput, ClauseClassification> {
  return {
    name: "classify_clause",
    title: "Classify a clause (LoRA)",
    description: "Classify a clause into one of the 37 CUAD clause types using the fine-tuned Legal-BERT LoRA model.",
    sideEffect: "read",
    inputShape,
    async run(input: ClassifyInput): Promise<ClauseClassification> {
      const preds = await deps.runPredict([input.text]);
      if (preds.length === 0) throw new Error("classify_clause: no prediction returned for input");
      return { clause_type: preds[0].label, score: preds[0].score };
    },
  };
}
