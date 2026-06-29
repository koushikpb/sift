import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { resolveEmbedConfig } from "./registry.js";

/** Active embedder, env-selectable. Default keeps the P1/P2a baseline reproducible. */
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "bge-large-en-v1.5";
export const EMBED_DIM = 1024;

// One lazy singleton pipeline per model name (a model swap must not reuse another's weights).
const _extractors = new Map<string, Promise<FeatureExtractionPipeline>>();
function extractor(model: string): Promise<FeatureExtractionPipeline> {
  let p = _extractors.get(model);
  if (!p) {
    const cfg = resolveEmbedConfig(model);
    // Cast needed: `pipeline()` v3 returns a union too complex for tsc (TS2590).
    p = pipeline("feature-extraction", cfg.repo, { dtype: "fp32" }) as unknown as Promise<FeatureExtractionPipeline>;
    _extractors.set(model, p);
  }
  return p;
}

export async function embedTexts(
  texts: string[],
  opts: { kind: "query" | "passage"; model?: string },
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const name = opts.model ?? EMBED_MODEL;
  const cfg = resolveEmbedConfig(name);
  const inputs = opts.kind === "query" ? texts.map((t) => cfg.queryPrefix + t) : texts;
  const out = await (await extractor(name))(inputs, { pooling: cfg.pooling, normalize: true });
  return out.tolist() as number[][];
}
