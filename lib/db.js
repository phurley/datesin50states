import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbPath);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS authors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  apple_sub TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  title TEXT NOT NULL,
  date TEXT,                 -- YYYY-MM-DD of the date/visit
  place TEXT,                -- city / park / campground
  body TEXT NOT NULL DEFAULT '',
  album_url TEXT,            -- iCloud shared album link
  album_synced_at TEXT,
  album_error TEXT,
  cover_photo_id INTEGER,
  author_id INTEGER REFERENCES authors(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS entries_state ON entries(state, date);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  source TEXT NOT NULL,      -- 'upload' | 'icloud'
  source_key TEXT,           -- iCloud photoGuid, for dedupe on re-sync
  file TEXT NOT NULL,        -- large image, relative to media dir
  thumb TEXT NOT NULL,
  width INTEGER, height INTEGER,
  caption TEXT,
  taken_at TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entry_id, source, source_key)
);
CREATE INDEX IF NOT EXISTS photos_entry ON photos(entry_id, position);
`);

// Seed author rows from the allow-list so names are stable.
const upsert = db.prepare(`INSERT INTO authors (name, email) VALUES (?, ?)
  ON CONFLICT(email) DO UPDATE SET name = excluded.name`);
for (const a of config.authorEmails) upsert.run(a.name, a.email);

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
