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
