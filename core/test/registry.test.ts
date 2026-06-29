import { describe, it, expect } from "vitest";
import { resolveEmbedConfig, EMBED_REGISTRY } from "../src/embed/registry.js";

describe("resolveEmbedConfig", () => {
  it("returns the bge-large config (mean pooling)", () => {
    const cfg = resolveEmbedConfig("bge-large-en-v1.5");
    expect(cfg.repo).toBe("Xenova/bge-large-en-v1.5");
    expect(cfg.pooling).toBe("mean");
    expect(cfg.dim).toBe(1024);
  });

  it("returns the mxbai config (cls pooling)", () => {
    const cfg = resolveEmbedConfig("mxbai-embed-large-v1");
    expect(cfg.repo).toBe("mixedbread-ai/mxbai-embed-large-v1");
    expect(cfg.pooling).toBe("cls");
    expect(cfg.dim).toBe(1024);
  });

  it("throws naming known models on an unknown name", () => {
    expect(() => resolveEmbedConfig("nope")).toThrow(/unknown EMBED_MODEL/);
    expect(() => resolveEmbedConfig("nope")).toThrow(/bge-large-en-v1\.5/);
  });

  it("every registry entry is 1024-dim (matches the vector(1024) column)", () => {
    for (const cfg of Object.values(EMBED_REGISTRY)) expect(cfg.dim).toBe(1024);
  });
});
