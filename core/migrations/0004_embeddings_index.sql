-- Vectors now exist (populated by `npm run embed` in P1), so add the ANN index the 0003
-- comment deferred. HNSW with cosine ops matches the `<=>` retrieval operator.
CREATE INDEX IF NOT EXISTS embeddings_hnsw_idx
  ON embeddings USING hnsw (embedding vector_cosine_ops);
