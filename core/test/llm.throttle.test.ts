import { describe, it, expect, beforeEach } from "vitest";
import { reserveSlot, resolveMinIntervalMs, resolveMaxTokens, __resetThrottle } from "../src/llm/throttle.js";

describe("reserveSlot", () => {
  beforeEach(() => __resetThrottle());

  it("does not wait when minIntervalMs <= 0", async () => {
    const t0 = Date.now();
    await reserveSlot(0);
    await reserveSlot(0);
    expect(Date.now() - t0).toBeLessThan(20);
  });

  it("paces successive calls by at least minIntervalMs", async () => {
    const times: number[] = [];
    await reserveSlot(40); times.push(Date.now());
    await reserveSlot(40); times.push(Date.now());
    await reserveSlot(40); times.push(Date.now());
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(35);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(35);
  });

  it("shares one budget across independent callers", async () => {
    // Three callers reserving from the same module clock must serialize: slots at
    // 0, 50, 100 → the last resolves ~100ms after the first.
    const start = Date.now();
    await Promise.all([reserveSlot(50), reserveSlot(50), reserveSlot(50)]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });
});

describe("resolveMaxTokens", () => {
  it("returns fallback when LLM_MAX_TOKENS is unset", () => {
    expect(resolveMaxTokens(2048, {})).toBe(2048);
  });

  it("returns 1024 default when no fallback and LLM_MAX_TOKENS unset", () => {
    expect(resolveMaxTokens(undefined, {})).toBe(1024);
  });

  it("reads LLM_MAX_TOKENS over fallback", () => {
    expect(resolveMaxTokens(2048, { LLM_MAX_TOKENS: "512" })).toBe(512);
  });

  it("falls back when LLM_MAX_TOKENS is non-numeric", () => {
    expect(resolveMaxTokens(2048, { LLM_MAX_TOKENS: "bad" })).toBe(2048);
  });

  it("falls back when LLM_MAX_TOKENS is zero or negative", () => {
    expect(resolveMaxTokens(2048, { LLM_MAX_TOKENS: "0" })).toBe(2048);
    expect(resolveMaxTokens(2048, { LLM_MAX_TOKENS: "-100" })).toBe(2048);
  });
});

describe("resolveMinIntervalMs", () => {
  it("derives the inter-request interval from LLM_RPM", () => {
    expect(resolveMinIntervalMs({ LLM_RPM: "40" } as NodeJS.ProcessEnv)).toBe(1500);
  });
  it("lets LLM_MIN_INTERVAL_MS override LLM_RPM", () => {
    expect(resolveMinIntervalMs({ LLM_RPM: "40", LLM_MIN_INTERVAL_MS: "250" } as NodeJS.ProcessEnv)).toBe(250);
  });
  it("returns 0 (no throttle) when unset or invalid", () => {
    expect(resolveMinIntervalMs({} as NodeJS.ProcessEnv)).toBe(0);
    expect(resolveMinIntervalMs({ LLM_RPM: "abc" } as NodeJS.ProcessEnv)).toBe(0);
    expect(resolveMinIntervalMs({ LLM_RPM: "0" } as NodeJS.ProcessEnv)).toBe(0);
  });
});
