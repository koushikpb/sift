/**
 * Shared client-side request pacing for all LLM callers in the process
 * (the generator and the agentic sufficiency judge), so their COMBINED request
 * rate stays under the provider's rpm cap. A single module-level slot clock means
 * two callers cannot each independently burst to the limit.
 */

let nextAllowedAt = 0;

/**
 * Minimum spacing (ms) between outgoing requests. `LLM_MIN_INTERVAL_MS` is an
 * explicit override; otherwise derived from `LLM_RPM` (60000 / rpm). Unset or
 * invalid → 0 (no throttle), preserving the original behavior.
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

/**
 * Per-request timeout (ms) for LLM HTTP clients. `LLM_TIMEOUT_MS` overrides; default 45000.
 * Without a bounded timeout the OpenAI SDK waits ~10 min on a stalled connection (a known NIM
 * stall mode), which hangs eval runs — a finite timeout lets a stalled call fail fast so the
 * per-item degrade path can continue. Non-positive/invalid → the default.
 */
export function resolveTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = env.LLM_TIMEOUT_MS;
  if (explicit != null && explicit !== "") {
    const ms = Number(explicit);
    if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms);
  }
  return 45000;
}

/**
 * Maximum tokens for LLM completions. `LLM_MAX_TOKENS` overrides; `fallback` (default 1024)
 * is used when the env var is absent or invalid. Required by Anthropic's OpenAI-compatible
 * endpoint; safe to send to NIM/OpenAI as well.
 */
export function resolveMaxTokens(
  fallback = 1024,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.LLM_MAX_TOKENS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Reserve the next outgoing-request time slot; resolves after waiting if needed.
 * Shared across all callers in the process. `minIntervalMs <= 0` returns immediately
 * WITHOUT advancing the clock, so the no-throttle path is byte-for-byte unchanged.
 */
export async function reserveSlot(minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;
  const slot = Math.max(Date.now(), nextAllowedAt);
  nextAllowedAt = slot + minIntervalMs;
  const wait = slot - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/** Test-only: reset the shared slot clock so pacing tests are deterministic. */
export function __resetThrottle(): void {
  nextAllowedAt = 0;
}
