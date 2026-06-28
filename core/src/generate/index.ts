import { makeOpenAICompatGenerator } from "./openaiCompat.js";
import { makeAnthropicGenerator } from "./anthropic.js";
import type { Generator } from "./types.js";

/** Select the generation provider from env. */
export function makeGenerator(): Generator {
  const provider = process.env.LLM_PROVIDER ?? "openai";
  if (provider === "openai") return makeOpenAICompatGenerator();
  if (provider === "anthropic") return makeAnthropicGenerator();
  throw new Error(`unknown LLM_PROVIDER: "${provider}" (expected "openai" or "anthropic")`);
}

export type { Generator, GenInput, RawGen } from "./types.js";
export { buildPrompt, parseRawGen, extractJsonObject } from "./prompt.js";
export { toClauseCard } from "./toClauseCard.js";
export { makeOpenAICompatGenerator } from "./openaiCompat.js";
export { makeAnthropicGenerator } from "./anthropic.js";
