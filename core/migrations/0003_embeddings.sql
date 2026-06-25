-- Embedding dimension default = 1024. Embeddings are populated in P1, where the embedder
-- is chosen as a measured experiment; if that model's dimension differs, change it here and
-- add the matching migration. The vector index is also deferred to P1 (added after vectors
-- exist). Phase 0 only needs the table to exist + the extension to work (proven below).
CREATE TABLE IF NOT EXISTS embeddings (
  node_id   text PRIMARY KEY REFERENCES clauses(node_id) ON DELETE CASCADE,
  model     text NOT NULL,
  embedding vector(1024)
);
