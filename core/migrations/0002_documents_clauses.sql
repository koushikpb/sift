CREATE TABLE IF NOT EXISTS documents (
  doc_id        text PRIMARY KEY,
  source        text NOT NULL,
  title         text,
  contract_type text NOT NULL,
  raw_text      text NOT NULL,
  char_length   integer NOT NULL,
  raw_sha256    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clauses (
  node_id    text PRIMARY KEY,
  doc_id     text NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  parent_id  text,
  type       text NOT NULL,
  number     text,
  heading    text,
  text       text NOT NULL,
  char_start integer NOT NULL,
  char_end   integer NOT NULL,
  depth      integer NOT NULL
);

CREATE INDEX IF NOT EXISTS clauses_doc_idx ON clauses(doc_id);
CREATE INDEX IF NOT EXISTS clauses_parent_idx ON clauses(parent_id);
