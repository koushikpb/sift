import { z } from "zod";
import OpenAI from "openai";
import type { PlaybookEntry } from "../../eval/playbook.js";
import type { Citation, ReviewFlag, ToolDef } from "./types.js";
import { matchPlaybookEntry } from "./playbookMatch.js";
import { reserveSlot, resolveMinIntervalMs } from "../../llm/throttle.js";

export interface DeviationJudge {
  judge: (clauseText: string, entry: PlaybookEntry) => Promise<{ deviation: boolean; rationale: string }>;
}

export interface FlagRisksInput {
  clause_text: string;
  clause_type: string;
  citation: Citation;
}

const inputShape = {
  clause_text: z.string().min(1),
  clause_type: z.string().min(1),
  citation: z.object({
    doc_id: z.string().min(1),
    char_start: z.number().int().nonnegative(),
    char_end: z.number().int().nonnegative(),
    quote: z.string(),
  }),
};

/**
 * flag_risks (check_playbook + deviation judgement). Resolves the clause type to a playbook
 * position; if none, returns null (nothing to review). Otherwise asks the judge whether the clause
 * deviates from the standard and emits a ReviewFlag — severity from the playbook (deterministic),
 * citation from the clause. Emitting even non-deviating matches makes "did we review the required
 * position" measurable as coverage / false-negative rate.
 */
export function makeFlagRisksTool(deps: DeviationJudge, entries: PlaybookEntry[]): ToolDef<FlagRisksInput, ReviewFlag | null> {
  return {
    name: "flag_risks",
    title: "Flag playbook deviations",
    description: "Match a clause to its playbook position and flag whether it deviates from the standard.",
    sideEffect: "read",
    inputShape,
    async run(input: FlagRisksInput): Promise<ReviewFlag | null> {
      const entry = matchPlaybookEntry(input.clause_type, entries);
      if (!entry) return null;
      const { deviation, rationale } = await deps.judge(input.clause_text, entry);
      return {
        playbook_id: entry.playbook_id,
        clause_type: entry.clause_type,
        severity: entry.severity,
        deviation,
        rationale,
        citation: input.citation,
      };
    },
  };
}

const VerdictSchema = z.object({
  deviation: z.boolean().catch(false),
  rationale: z.string().catch(""),
});

/**
 * Default LLM deviation judge. Grounds the decision on the clause text + the playbook's standard
 * position and red flags. Tolerant parse; any failure degrades to { deviation: false } (never
 * crashes the review — an unreadable verdict is treated as "not a deviation", surfaced in rationale).
 */
export function defaultDeviationJudge(): DeviationJudge {
  const model = process.env.LLM_MODEL ?? "meta/llama-3.3-70b-instruct";
  const client = new OpenAI({
    baseURL: process.env.LLM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
    apiKey: process.env.LLM_API_KEY ?? "",
  });
  const minIntervalMs = resolveMinIntervalMs();
  return {
    async judge(clauseText, entry) {
      const system =
        "You are a contract-review assistant. Decide ONLY from the clause text whether it deviates from the standard position. " +
        'Reply with ONLY JSON: {"deviation": boolean, "rationale": string}. If uncertain, deviation=false.';
      const user =
        `Playbook position: ${entry.standard_position}\nRed flags: ${entry.red_flags.join("; ")}\n\nClause:\n${clauseText}`;
      try {
        await reserveSlot(minIntervalMs);
        const resp = await client.chat.completions.create({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        });
        const text = resp.choices[0]?.message?.content ?? "";
        const start = text.indexOf("{");
        const parsed = VerdictSchema.parse(JSON.parse(text.slice(start, text.lastIndexOf("}") + 1)));
        return { deviation: parsed.deviation, rationale: parsed.rationale };
      } catch {
        return { deviation: false, rationale: "deviation judge unavailable (degraded to no-deviation)" };
      }
    },
  };
}
