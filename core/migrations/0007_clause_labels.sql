-- Precomputed LoRA clause labels for the curated demo corpus.
-- Vercel serverless cannot spawn the Python LoRA subprocess, so labels are
-- computed offline and served from this table by the Task-5 API's getClauseLabel.
CREATE TABLE IF NOT EXISTS clause_labels (
  doc_id     TEXT    NOT NULL,
  char_start INTEGER NOT NULL,
  char_end   INTEGER NOT NULL,
  label      TEXT    NOT NULL,
  score      REAL    NOT NULL,
  PRIMARY KEY (doc_id, char_start, char_end)
);
