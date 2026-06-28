-- Lexical half of hybrid retrieval (P2a). Generated STORED tsvector auto-backfills existing
-- rows on ALTER and self-maintains on future loads. Heading weighted 'A' (objectives often
-- name the clause title), body text 'B'. Two-arg to_tsvector('english', ...) is IMMUTABLE,
-- which a generated column requires.
ALTER TABLE clauses ADD COLUMN IF NOT EXISTS text_search tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(heading, '')), 'A') ||
    setweight(to_tsvector('english', text), 'B')
  ) STORED;
CREATE INDEX IF NOT EXISTS clauses_fts_idx ON clauses USING GIN (text_search);
