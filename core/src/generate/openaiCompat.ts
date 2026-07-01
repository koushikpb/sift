import OpenAI from "openai";
import { buildPrompt, parseRawGen } from "./prompt.js";
import type { GenInput, Generator, RawGen } from "./types.js";
import { reserveSlot, resolveMinIntervalMs, resolveTimeoutMs } from "../llm/throttle.js";

/** Minimal surface of the OpenAI chat client, so tests can inject a fake. */
export interface ChatClient {
  chat: {
    completions: {
      create(args: {
        model: string;
        messages: { role: "system" | "user"; content: string }[];
        temperature?: number;
      }): Promise<{ choices: { message: { content: string | null } }[] }>;
    };
  };
}

// Re-exported for back-compat: callers/tests still import this from openaiCompat.
export { resolveMinIntervalMs } from "../llm/throttle.js";

export function makeOpenAICompatGenerator(
  opts: { client?: ChatClient; model?: string; minIntervalMs?: number } = {},
): Generator {
  const model = opts.model ?? process.env.LLM_MODEL ?? "moonshotai/kimi-k2-instruct";
  const client: ChatClient =
    opts.client ??
    (new OpenAI({
      baseURL: process.env.LLM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
      apiKey: process.env.LLM_API_KEY ?? "",
      timeout: resolveTimeoutMs(),
      maxRetries: 1,
    }) as unknown as ChatClient);

  // Client-side rate limit shared across all LLM callers via llm/throttle.
  const minIntervalMs = opts.minIntervalMs ?? resolveMinIntervalMs();

  return {
    async generate(input: GenInput): Promise<RawGen> {
      await reserveSlot(minIntervalMs);
      const { system, user } = buildPrompt(input);
      const resp = await client.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      return parseRawGen(resp.choices[0]?.message?.content ?? "");
    },
  };
}
