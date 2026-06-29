-- Hold multiple embedders' vectors per clause: PK (node_id) -> (node_id, model).
-- Existing rows already carry model='bge-large-en-v1.5', so this is non-destructive.
-- The vector(1024) column and HNSW index are unchanged (both registry models are 1024-dim).
ALTER TABLE embeddings DROP CONSTRAINT IF EXISTS embeddings_pkey;
ALTER TABLE embeddings ADD PRIMARY KEY (node_id, model);
