import { makeOpenAICompatGenerator } from "./openaiCompat.js";
import type { Generator } from "./types.js";

/** Select the generation provider from env. `anthropic` is added in Task 8. */
export function makeGenerator(): Generator {
  const provider = process.env.LLM_PROVIDER ?? "openai";
  if (provider === "openai") return makeOpenAICompatGenerator();
  throw new Error(`unknown LLM_PROVIDER: ${provider}`);
}

export type { Generator, GenInput, RawGen } from "./types.js";
export { buildPrompt, parseRawGen, extractJsonObject } from "./prompt.js";
export { toClauseCard } from "./toClauseCard.js";
export { makeOpenAICompatGenerator } from "./openaiCompat.js";
