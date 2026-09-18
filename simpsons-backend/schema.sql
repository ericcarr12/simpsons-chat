-- D1 schema: durable store of every dataset entry.
-- Vectorize holds the embeddings for search; D1 is the source of truth
-- (lets you inspect/edit/re-embed everything without touching the vector index directly).

CREATE TABLE IF NOT EXISTS entries (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  keys       TEXT,              -- comma-separated search aliases, optional
  text       TEXT NOT NULL,
  source     TEXT,              -- e.g. "curated", "Simpsons Wiki (Fandom)", "Wikipedia"
  url        TEXT,              -- link back to the original source, if any
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entries_title ON entries(title);
