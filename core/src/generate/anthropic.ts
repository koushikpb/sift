import Anthropic from "@anthropic-ai/sdk";
import { buildPrompt, parseRawGen } from "./prompt.js";
import type { GenInput, Generator, RawGen } from "./types.js";

/** Minimal surface of the Anthropic Messages client, so tests can inject a fake. */
export interface AnthropicClient {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: "user"; content: string }[];
    }): Promise<{ content: { type: string; text?: string }[] }>;
  };
}

export function makeAnthropicGenerator(opts: { client?: AnthropicClient; model?: string } = {}): Generator {
  const model = opts.model ?? process.env.LLM_MODEL ?? "claude-sonnet-4-6";
  const client: AnthropicClient =
    opts.client ?? (new Anthropic({ apiKey: process.env.LLM_API_KEY ?? "" }) as unknown as AnthropicClient);

  return {
    async generate(input: GenInput): Promise<RawGen> {
      const { system, user } = buildPrompt(input);
      const resp = await client.messages.create({
        model,
        max_tokens: 2048,
        system,
        messages: [{ role: "user", content: user }],
      });
      const text = resp.content.find((b) => b.type === "text")?.text ?? "";
      return parseRawGen(text);
    },
  };
}
