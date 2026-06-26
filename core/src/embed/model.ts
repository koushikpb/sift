import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBED_MODEL = "bge-large-en-v1.5";
export const EMBED_DIM = 1024;

// bge models recommend a query instruction prefix for retrieval; passages are embedded raw.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

let _extractor: Promise<FeatureExtractionPipeline> | null = null;
function extractor(): Promise<FeatureExtractionPipeline> {
  // Cast needed: `pipeline()` v3 returns a union too complex for tsc (TS2590).
  // The runtime value is always a FeatureExtractionPipeline; the contract is unchanged.
  return (_extractor ??= pipeline("feature-extraction", "Xenova/bge-large-en-v1.5", { dtype: "fp32" }) as unknown as Promise<FeatureExtractionPipeline>);
}

export async function embedTexts(
  texts: string[],
  opts: { kind: "query" | "passage" },
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const inputs = opts.kind === "query" ? texts.map((t) => QUERY_PREFIX + t) : texts;
  const out = await (await extractor())(inputs, { pooling: "mean", normalize: true });
  return out.tolist() as number[][];
}
