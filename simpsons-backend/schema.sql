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

-- Structured producer credits and character appearances, per episode.
-- These power the deterministic lookups in src/index.js (tryProducerLookup,
-- tryCharacterEpisodesLookup) and are populated directly via D1 execute /
-- the ingestion scripts under scripts/, not through /api/ingest.

CREATE TABLE IF NOT EXISTS episode_producers (
  episode_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  person     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_episode_producers_episode ON episode_producers(episode_id);

CREATE TABLE IF NOT EXISTS episode_characters (
  episode_id      TEXT NOT NULL,
  character       TEXT NOT NULL,
  appearance_type TEXT
);

CREATE INDEX IF NOT EXISTS idx_episode_characters_episode ON episode_characters(episode_id);
CREATE INDEX IF NOT EXISTS idx_episode_characters_character ON episode_characters(character);

-- User feedback and contact submissions (Beta 1.2). Written by
-- handleFeedback / handleContact in src/index.js via /api/feedback and
-- /api/contact -- query these directly in D1 to review submissions.

CREATE TABLE IF NOT EXISTS chat_feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message    TEXT,
  answer     TEXT,
  rating     TEXT CHECK(rating IN ('up','down')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  reason     TEXT NOT NULL,
  message    TEXT NOT NULL,
  email      TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
