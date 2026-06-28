import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
  type PreTrainedTokenizer,
  type PreTrainedModel,
} from "@huggingface/transformers";
import type { Candidate } from "../retrieve/types.js";

export const RERANK_MODEL = process.env.RERANK_MODEL ?? "Xenova/ms-marco-MiniLM-L-6-v2";

let _rr: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> | null = null;
function reranker() {
  return (_rr ??= (async () => {
    const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL);
    const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, {
      dtype: "fp32",
    });
    return { tokenizer, model };
  })());
}

/** Relevance score per passage for the query (higher = more relevant). */
export async function rerankScores(query: string, passages: string[]): Promise<number[]> {
  if (passages.length === 0) return [];
  const { tokenizer, model } = await reranker();
  // ms-marco / bge cross-encoders take (query, passage) pairs and emit a single
  // relevance logit per pair: logits shape [N, 1]. Tokenizer→model types in v3 are
  // loose; cast like embed/model.ts does for the pipeline.
  const inputs = tokenizer(new Array(passages.length).fill(query), {
    text_pair: passages,
    padding: true,
    truncation: true,
  });
  const { logits } = (await model(inputs as never)) as unknown as {
    logits: { sigmoid(): { tolist(): number[][] } };
  };
  return logits.sigmoid().tolist().map((row) => row[0]);
}

/** Rerank candidates by cross-encoder relevance; returns the top-K, score = relevance. */
export async function rerank(
  query: string,
  candidates: Candidate[],
  topK: number,
): Promise<Candidate[]> {
  if (candidates.length === 0) return [];
  const scores = await rerankScores(query, candidates.map((c) => c.text));
  return candidates
    .map((c, i) => ({ ...c, score: scores[i] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
