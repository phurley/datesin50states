import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { randomSlug } from './slugs.js';

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

-- Photo chosen to fill a state on the map (falls back to the newest entry's cover).
CREATE TABLE IF NOT EXISTS state_photos (
  state TEXT PRIMARY KEY,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE
);
`);

// --- Additive migrations ------------------------------------------------------
const colsOf = (t) => db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((c) => c.name);
if (!colsOf('entries').includes('album_title')) db.exec('ALTER TABLE entries ADD COLUMN album_title TEXT');

// Multi-user: every person (authors row) belongs to one map; a map can have several members.
// The root map (Patrick & Susan's) shows at / and also at its slug.
db.exec(`
CREATE TABLE IF NOT EXISTS maps (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  is_root INTEGER NOT NULL DEFAULT 0,
  title_script TEXT NOT NULL DEFAULT 'Dates in',
  title TEXT NOT NULL DEFAULT '50 States',
  tagline TEXT NOT NULL DEFAULT '',
  footer TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Old slugs keep redirecting after a rename.
CREATE TABLE IF NOT EXISTS slug_history (
  slug TEXT PRIMARY KEY,
  map_id INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE
);
-- New users need one of these to sign up (unless they arrive via a map's QR invite).
CREATE TABLE IF NOT EXISTS join_codes (
  code TEXT PRIMARY KEY COLLATE NOCASE,
  max_uses INTEGER,            -- NULL = unlimited
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,             -- NULL = never
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- QR invites to join an existing map; valid for 30 minutes.
CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY,
  map_id INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES authors(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL
);
-- A sign-in we don't recognize yet, waiting for a join code (short-lived).
CREATE TABLE IF NOT EXISTS pending_signups (
  token TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  sub TEXT NOT NULL,
  email TEXT,
  name TEXT,
  expires_at TEXT NOT NULL
);
`);

const acols = colsOf('authors');
if (!acols.includes('google_sub')) {
  db.exec('ALTER TABLE authors ADD COLUMN google_sub TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS authors_google_sub ON authors(google_sub)');
}
if (!acols.includes('role')) db.exec("ALTER TABLE authors ADD COLUMN role TEXT NOT NULL DEFAULT 'free'"); // 'admin' | 'free'
if (!acols.includes('blocked_at')) {
  db.exec('ALTER TABLE authors ADD COLUMN blocked_at TEXT');
  db.exec('ALTER TABLE authors ADD COLUMN block_reason TEXT');
}
db.exec(`CREATE TABLE IF NOT EXISTS moderation_events (
  id INTEGER PRIMARY KEY,
  author_id INTEGER REFERENCES authors(id) ON DELETE CASCADE,
  map_id INTEGER REFERENCES maps(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,          -- 'photo' | 'text'
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
if (!acols.includes('map_id')) db.exec('ALTER TABLE authors ADD COLUMN map_id INTEGER REFERENCES maps(id) ON DELETE SET NULL');
if (!colsOf('entries').includes('map_id')) {
  db.exec('ALTER TABLE entries ADD COLUMN map_id INTEGER REFERENCES maps(id) ON DELETE CASCADE');
}
db.exec('CREATE INDEX IF NOT EXISTS entries_map_state ON entries(map_id, state, date)');

// The root map, holding everything written before maps existed.
let root = db.prepare('SELECT id FROM maps WHERE is_root = 1').get();
if (!root) {
  let slug;
  do slug = randomSlug(); while (db.prepare('SELECT 1 FROM maps WHERE slug = ?').get(slug));
  const r = db.prepare(`INSERT INTO maps (slug, is_root, tagline, footer) VALUES (?, 1, ?, ?)`)
    .run(slug, 'Patrick & Susan’s travelogue — dates in every state in the union.', 'Patrick & Susan · dates in every state');
  root = { id: Number(r.lastInsertRowid) };
}
export const ROOT_MAP_ID = root.id;

// state_photos was keyed by state alone; it's per map now.
if (!colsOf('state_photos').includes('map_id')) {
  db.exec(`
    CREATE TABLE state_photos_new (
      map_id INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      PRIMARY KEY (map_id, state)
    );
    INSERT INTO state_photos_new (map_id, state, photo_id)
      SELECT (SELECT id FROM maps WHERE is_root = 1), state, photo_id FROM state_photos
      WHERE (SELECT id FROM maps WHERE is_root = 1) IS NOT NULL;
    DROP TABLE state_photos;
    ALTER TABLE state_photos_new RENAME TO state_photos;
  `);
}

// Seed author rows from the allow-list so names are stable. They're admins (no limits).
const upsert = db.prepare(`INSERT INTO authors (name, email, role) VALUES (?, ?, 'admin')
  ON CONFLICT(email) DO UPDATE SET role = 'admin'`);
for (const a of config.authorEmails) upsert.run(a.name, a.email);


db.prepare('UPDATE entries SET map_id = ? WHERE map_id IS NULL').run(root.id);
db.prepare("UPDATE authors SET map_id = ? WHERE map_id IS NULL AND role = 'admin'").run(root.id);
db.prepare('UPDATE state_photos SET map_id = ? WHERE map_id IS NULL').run(root.id);

// Starter join code.
db.prepare(`INSERT OR IGNORE INTO join_codes (code, max_uses, note) VALUES ('BlueWave2026', 100, 'Launch code')`).run();

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
