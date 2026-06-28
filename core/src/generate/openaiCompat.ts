import OpenAI from "openai";
import { buildPrompt, parseRawGen } from "./prompt.js";
import type { GenInput, Generator, RawGen } from "./types.js";

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

/**
 * Minimum spacing (ms) between outgoing requests, to stay under a provider's
 * requests-per-minute cap (NIM free tier is 40 rpm). `LLM_MIN_INTERVAL_MS` is an
 * explicit override; otherwise it's derived from `LLM_RPM` (60000 / rpm). Unset or
 * invalid → 0 (no throttle), preserving existing behavior.
 */
export function resolveMinIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = env.LLM_MIN_INTERVAL_MS;
  if (explicit != null && explicit !== "") {
    const ms = Number(explicit);
    if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms);
  }
  const rpm = env.LLM_RPM;
  if (rpm != null && rpm !== "") {
    const n = Number(rpm);
    if (Number.isFinite(n) && n > 0) return Math.ceil(60000 / n);
  }
  return 0;
}

export function makeOpenAICompatGenerator(
  opts: { client?: ChatClient; model?: string; minIntervalMs?: number } = {},
): Generator {
  const model = opts.model ?? process.env.LLM_MODEL ?? "moonshotai/kimi-k2-instruct";
  const client: ChatClient =
    opts.client ??
    (new OpenAI({
      baseURL: process.env.LLM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
      apiKey: process.env.LLM_API_KEY ?? "",
    }) as unknown as ChatClient);

  // Client-side rate limit: reserve a time slot per request so a fast serial loop
  // (e.g. the eval runner) cannot exceed the provider's rpm cap and get 429'd.
  const minIntervalMs = opts.minIntervalMs ?? resolveMinIntervalMs();
  let nextAllowedAt = 0;

  return {
    async generate(input: GenInput): Promise<RawGen> {
      if (minIntervalMs > 0) {
        const slot = Math.max(Date.now(), nextAllowedAt);
        nextAllowedAt = slot + minIntervalMs;
        const wait = slot - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
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
