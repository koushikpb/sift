import OpenAI from "openai";
import { z } from "zod";
import { extractJsonObject } from "../generate/prompt.js";
import type { ChatClient } from "../generate/openaiCompat.js";
import { reserveSlot, resolveMinIntervalMs } from "../llm/throttle.js";
import type { Candidate } from "../retrieve/types.js";

export interface JudgeVerdict {
  sufficient: boolean;
  reformulations: string[];
}

export interface JudgeDeps {
  client?: ChatClient;
  model?: string;
  minIntervalMs?: number;
}

const SYSTEM = [
  "You are the retrieval-sufficiency judge for a contract-review system.",
  "Given an objective and a set of numbered candidate clauses, decide whether the candidates",
  "contain enough information to answer the objective.",
  "If they are sufficient, set `sufficient` to true and `reformulations` to [].",
  "If they are NOT sufficient, set `sufficient` to false and propose 1-3 alternative search",
  "queries in `reformulations` (synonyms, legal-term variants, or narrower sub-aspects of the",
  "objective) that might retrieve the missing clause. Do not invent clause content.",
  'Reply with ONLY a JSON object: {"sufficient": boolean, "reformulations": string[]}.',
].join(" ");

function buildUser(objective: string, candidates: Candidate[]): string {
  const lines = candidates.map(
    (c, i) => `[${i}] (${c.doc_id}, chars ${c.char_start}-${c.char_end}) ${c.text}`,
  );
  return `Objective: ${objective}\n\nCandidate clauses:\n${lines.join("\n")}`;
}

const VerdictSchema = z.object({
  sufficient: z.boolean().catch(false),
  reformulations: z.array(z.string()).catch([]),
});

/**
 * LLM sufficiency judge. Returns whether the candidates can answer the objective and,
 * if not, up to 3 reformulated queries. Degrades to {sufficient:true, reformulations:[]}
 * on any call failure OR unparseable output, so a broken judge stops the loop rather than
 * crashing retrieval. Shares the process rpm budget via reserveSlot.
 */
export async function judgeSufficiency(
  objective: string,
  candidates: Candidate[],
  deps: JudgeDeps = {},
): Promise<JudgeVerdict> {
  const model = deps.model ?? process.env.LLM_MODEL ?? "moonshotai/kimi-k2-instruct";
  const client: ChatClient =
    deps.client ??
    (new OpenAI({
      baseURL: process.env.LLM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
      apiKey: process.env.LLM_API_KEY ?? "",
    }) as unknown as ChatClient);
  const minIntervalMs = deps.minIntervalMs ?? resolveMinIntervalMs();

  await reserveSlot(minIntervalMs);

  let content: string;
  try {
    const resp = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildUser(objective, candidates) },
      ],
    });
    content = resp.choices[0]?.message?.content ?? "";
  } catch {
    return { sufficient: true, reformulations: [] };
  }

  try {
    const obj = VerdictSchema.parse(extractJsonObject(content));
    const reformulations = obj.reformulations
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 3);
    return { sufficient: obj.sufficient, reformulations };
  } catch {
    return { sufficient: true, reformulations: [] };
  }
}
