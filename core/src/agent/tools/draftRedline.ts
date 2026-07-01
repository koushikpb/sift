import { z } from "zod";
import OpenAI from "openai";
import type { Citation, ReviewFlag, RedlineProposal, ToolDef } from "./types.js";
import { reserveSlot, resolveMinIntervalMs } from "../../llm/throttle.js";

export interface RedlineWriter {
  suggest: (flag: ReviewFlag, clauseText: string) => Promise<string>;
}

export interface DraftRedlineInput {
  flag: ReviewFlag & { citation: Citation };
  clause_text: string;
}

const inputShape = {
  flag: z.object({
    playbook_id: z.string(), clause_type: z.string(),
    severity: z.enum(["low", "medium", "high"]), deviation: z.boolean(), rationale: z.string(),
    citation: z.object({ doc_id: z.string(), char_start: z.number(), char_end: z.number(), quote: z.string() }),
  }),
  clause_text: z.string().min(1),
};

/**
 * draft_redline: propose playbook-compliant replacement text for a flagged clause. The proposal is
 * anchored to the original span (flag.citation) so the change is grounded and reviewable; a human
 * still decides whether to accept it (redlines only enter the world via a confirmed export_memo).
 */
export function makeDraftRedlineTool(deps: RedlineWriter): ToolDef<DraftRedlineInput, RedlineProposal> {
  return {
    name: "draft_redline",
    title: "Draft a playbook-compliant redline",
    description: "Propose replacement text bringing a flagged clause in line with the playbook, citing the original span.",
    sideEffect: "read",
    inputShape,
    async run(input: DraftRedlineInput): Promise<RedlineProposal> {
      const suggested = await deps.suggest(input.flag, input.clause_text);
      return {
        playbook_id: input.flag.playbook_id,
        original: input.flag.citation,
        suggested_text: suggested,
        rationale: input.flag.rationale,
      };
    },
  };
}

/** Default LLM redline writer. Degrades to a safe generic instruction on failure (never throws). */
export function defaultRedlineWriter(): RedlineWriter {
  const model = process.env.LLM_MODEL ?? "meta/llama-3.3-70b-instruct";
  const client = new OpenAI({
    baseURL: process.env.LLM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
    apiKey: process.env.LLM_API_KEY ?? "",
  });
  const minIntervalMs = resolveMinIntervalMs();
  return {
    async suggest(flag, clauseText) {
      await reserveSlot(minIntervalMs);
      try {
        const resp = await client.chat.completions.create({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: "You are a contract-redlining assistant. Reply with ONLY the replacement clause text — no preamble." },
            { role: "user", content: `Rewrite this clause to satisfy the playbook (${flag.rationale}). Original:\n${clauseText}` },
          ],
        });
        return (resp.choices[0]?.message?.content ?? "").trim() || `Revise to satisfy: ${flag.rationale}`;
      } catch (e) {
        process.stderr.write(`draft_redline: LLM writer failed, using fallback text: ${e instanceof Error ? e.message : String(e)}\n`);
        return `Revise to satisfy playbook position ${flag.playbook_id}: ${flag.rationale}`;
      }
    },
  };
}
