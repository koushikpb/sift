export interface EmbedConfig {
  repo: string;
  pooling: "mean" | "cls";
  queryPrefix: string;
  dim: number;
}

// bge query prefix is the retrieval instruction bge recommends; mxbai's model card uses the
// same prefix for queries. Passages are embedded raw (no prefix). Pooling differs per model.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export const EMBED_REGISTRY: Record<string, EmbedConfig> = {
  "bge-large-en-v1.5": {
    repo: "Xenova/bge-large-en-v1.5",
    pooling: "mean",
    queryPrefix: QUERY_PREFIX,
    dim: 1024,
  },
  "mxbai-embed-large-v1": {
    repo: "mixedbread-ai/mxbai-embed-large-v1",
    pooling: "cls",
    queryPrefix: QUERY_PREFIX,
    dim: 1024,
  },
};

export function resolveEmbedConfig(name: string): EmbedConfig {
  const cfg: EmbedConfig | undefined = EMBED_REGISTRY[name];
  if (!cfg) {
    throw new Error(
      `unknown EMBED_MODEL: "${name}" (known: ${Object.keys(EMBED_REGISTRY).join(", ")})`,
    );
  }
  return cfg;
}
