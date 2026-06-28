import { z } from "zod";
import type { GenInput, RawGen } from "./types.js";

const SYSTEM = [
  "You are a contract-review assistant. Answer ONLY from the numbered candidate clauses provided.",
  "Cite support by listing the candidate indices in `supporting`. Do not invent clauses or facts.",
  "If the candidates do not contain enough information to answer, set `refused` to true and explain in",
  "`refusal_reason` — replying \"insufficient context\" is correct and expected.",
  'Reply with ONLY a JSON object: {"answer": string, "supporting": number[], "refused": boolean, "refusal_reason": string|null}.',
].join(" ");

export function buildPrompt(input: GenInput): { system: string; user: string } {
  const lines = input.candidates.map(
    (c, i) => `[${i}] (${c.doc_id}, chars ${c.char_start}-${c.char_end}) ${c.text}`,
  );
  const user = `Objective: ${input.objective}\n\nCandidate clauses:\n${lines.join("\n")}`;
  return { system: SYSTEM, user };
}

/** Extract the first balanced JSON object from a model response (tolerates fences/preamble). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON object found");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error("unbalanced JSON object");
}

const RawGenSchema = z.object({
  answer: z.string().catch(""),
  supporting: z.array(z.number()).catch([]),
  refused: z.boolean().catch(false),
  refusal_reason: z.string().nullish().catch(null),
});

/** Parse a model response into RawGen; any failure becomes a safe refusal. */
export function parseRawGen(text: string): RawGen {
  try {
    const obj = RawGenSchema.parse(extractJsonObject(text));
    return {
      answer: obj.answer,
      supporting: obj.supporting.filter((n) => Number.isInteger(n)),
      refused: obj.refused,
      refusal_reason: obj.refusal_reason ?? null,
    };
  } catch {
    return { answer: "", supporting: [], refused: true, refusal_reason: "could not parse model output" };
  }
}
