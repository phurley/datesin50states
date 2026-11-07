import path from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import multer from 'multer';
import { config } from './lib/config.js';
import { db, tx } from './lib/db.js';
import { loadAuthor, requireAuthor, startSession, endSession, appleRedirect, appleCallback, clearSiwa } from './lib/auth.js';
import { storeImage, removeImage } from './lib/media.js';
import { albumToken, syncAlbum, isSyncing } from './lib/icloud.js';
import * as views from './lib/views.js';

const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

const staticOpts = { maxAge: config.prod ? '7d' : 0 };
app.use(express.static(path.resolve('public'), staticOpts));
// nginx serves /media directly in production; this is the fallback for dev.
app.use('/media', express.static(config.mediaDir, { maxAge: '365d', immutable: true }));
app.get('/.well-known/apple-developer-domain-association.txt', (_req, res) => {
  const f = path.join(config.dataDir, 'apple-developer-domain-association.txt');
  existsSync(f) ? res.type('text/plain').sendFile(f) : res.sendStatus(404);
});

app.get('/healthz', (_req, res) => { db.prepare('SELECT 1').get(); res.type('text').send('ok'); });

app.use(loadAuthor);

// --- Data helpers ------------------------------------------------------------

const VALID_STATE = (code) => Boolean(views.STATE_BY_CODE[String(code || '').toUpperCase()]);

function stateCounts() {
  const out = {};
  for (const r of db.prepare('SELECT state, COUNT(*) AS n FROM entries GROUP BY state').all()) out[r.state] = r.n;
  return out;
}

function photosFor(entryIds) {
  if (!entryIds.length) return {};
  const rows = db.prepare(`SELECT id, entry_id, source, file, thumb, width, height, caption, taken_at, position
    FROM photos WHERE entry_id IN (${entryIds.map(() => '?').join(',')}) ORDER BY position, id`).all(...entryIds);
  const by = {};
  for (const r of rows) (by[r.entry_id] ||= []).push({ ...r });
  return by;
}

function entriesFor(state) {
  const entries = db.prepare(`SELECT e.*, a.name AS author_name FROM entries e LEFT JOIN authors a ON a.id = e.author_id
    WHERE e.state = ? ORDER BY COALESCE(e.date, e.created_at) DESC, e.id DESC`).all(state).map((e) => ({ ...e }));
  const photos = photosFor(entries.map((e) => e.id));
  for (const e of entries) {
    e.photos = photos[e.id] || [];
    // cover photo first
    if (e.cover_photo_id) e.photos.sort((a, b) => (b.id === e.cover_photo_id) - (a.id === e.cover_photo_id));
    e.syncing = isSyncing(e.id);
  }
  return entries;
}

function getEntry(id) {
  const e = db.prepare('SELECT * FROM entries WHERE id = ?').get(Number(id));
  if (!e) return null;
  return { ...e, photos: photosFor([e.id])[e.id] || [], syncing: isSyncing(e.id) };
}

function cleanEntry(body) {
  const s = (v, max) => String(v ?? '').trim().slice(0, max);
  const out = {
    title: s(body.title, 200),
    date: s(body.date, 10) || null,
    place: s(body.place, 200) || null,
    body: s(body.body, 100_000),
    album_url: s(body.album_url, 500) || null,
  };
  if (!out.title) return { error: 'Give the entry a title.' };
  if (out.date && !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) return { error: 'Date should be YYYY-MM-DD.' };
  if (out.album_url && !albumToken(out.album_url)) {
    return { error: 'That doesn’t look like an iCloud shared album link (https://www.icloud.com/sharedalbum/#…).' };
  }
  return { entry: out };
}

// --- Pages -------------------------------------------------------------------

app.get('/', (req, res) => {
  const recent = db.prepare(`SELECT e.id, e.state, e.title, e.date,
      (SELECT thumb FROM photos p WHERE p.id = e.cover_photo_id) AS thumb
    FROM entries e ORDER BY COALESCE(e.date, e.created_at) DESC, e.id DESC LIMIT 6`).all();
  res.send(views.mapPage({ author: req.author, counts: stateCounts(), recent }));
});

app.get('/state/:code', (req, res) => {
  const state = views.STATE_BY_CODE[req.params.code.toUpperCase()];
  if (!state) return res.status(404).send(views.notFoundPage({ author: req.author }));
  const entries = entriesFor(state.code);
  // States without entries are not public.
  if (!entries.length && !req.author) return res.redirect('/');
  res.send(views.statePage({ author: req.author, state, entries }));
});

// --- Auth --------------------------------------------------------------------

app.get('/login', (req, res) => {
  if (req.author) return res.redirect('/');
  res.send(views.loginPage({ error: req.query.error, devLogin: config.devLogin, appleReady: Boolean(config.appleClientId) }));
});

app.get('/auth/apple', appleRedirect);

app.post('/auth/apple/callback', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
  const result = await appleCallback(req);
  clearSiwa(res);
  if (result.author) {
    startSession(res, result.author.id);
    return res.redirect(303, '/');
  }
  if (result.error === 'not-on-list') return res.status(403).send(views.notOnListPage(result));
  res.redirect(303, `/login?error=${encodeURIComponent(result.error)}`);
});

app.post('/auth/logout', (req, res) => {
  endSession(req, res);
  res.redirect(303, '/');
});

if (config.devLogin) {
  app.post('/auth/dev', express.urlencoded({ extended: false }), (req, res) => {
    const a = db.prepare('SELECT id FROM authors WHERE name = ?').get(String(req.body.author));
    if (!a) return res.redirect('/login?error=unknown');
    startSession(res, a.id);
    res.redirect(303, '/');
  });
}

// --- Author API --------------------------------------------------------------

const api = express.Router();
api.use(requireAuthor);
api.use(express.json({ limit: '1mb' }));

api.get('/states/:code/entries', (req, res) => {
  const code = req.params.code.toUpperCase();
  if (!VALID_STATE(code)) return res.status(404).json({ error: 'Unknown state.' });
  res.json({ entries: entriesFor(code) });
});

api.get('/entries/:id', (req, res) => {
  const e = getEntry(req.params.id);
  e ? res.json({ entry: e }) : res.status(404).json({ error: 'Not found.' });
});

function kickSync(id) {
  syncAlbum(id).catch((e) => console.error('[icloud]', e));
}

api.post('/entries', (req, res) => {
  const state = String(req.body.state || '').toUpperCase();
  if (!VALID_STATE(state)) return res.status(400).json({ error: 'Unknown state.' });
  const { entry, error } = cleanEntry(req.body);
  if (error) return res.status(400).json({ error });
  const { lastInsertRowid } = db.prepare(`INSERT INTO entries (state, title, date, place, body, album_url, author_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(state, entry.title, entry.date, entry.place, entry.body, entry.album_url, req.author.id);
  const id = Number(lastInsertRowid);
  if (entry.album_url) kickSync(id);
  res.status(201).json({ entry: getEntry(id) });
});

api.put('/entries/:id', (req, res) => {
  const existing = getEntry(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  const { entry, error } = cleanEntry(req.body);
  if (error) return res.status(400).json({ error });
  db.prepare(`UPDATE entries SET title = ?, date = ?, place = ?, body = ?, album_url = ?, updated_at = datetime('now')
    WHERE id = ?`).run(entry.title, entry.date, entry.place, entry.body, entry.album_url, existing.id);
  if (entry.album_url && entry.album_url !== existing.album_url) kickSync(existing.id);
  res.json({ entry: getEntry(existing.id) });
});

api.delete('/entries/:id', (req, res) => {
  const e = getEntry(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found.' });
  tx(() => db.prepare('DELETE FROM entries WHERE id = ?').run(e.id));
  e.photos.forEach(removeImage);
  res.json({ ok: true });
});

api.post('/entries/:id/sync', (req, res) => {
  const e = getEntry(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found.' });
  if (!e.album_url) return res.status(400).json({ error: 'No album link on this entry.' });
  kickSync(e.id);
  res.json({ ok: true, syncing: true });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 30 },
});

api.post('/entries/:id/photos', upload.array('photos', 30), async (req, res) => {
  const e = getEntry(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found.' });
  const failed = [];
  let pos = e.photos.reduce((m, p) => Math.max(m, p.position), 0);
  for (const f of req.files || []) {
    try {
      const img = await storeImage(f.buffer);
      db.prepare(`INSERT INTO photos (entry_id, source, source_key, file, thumb, width, height, taken_at, position)
        VALUES (?, 'upload', ?, ?, ?, ?, ?, ?, ?)`)
        .run(e.id, img.file, img.file, img.thumb, img.width, img.height, img.takenAt, ++pos);
    } catch (err) {
      console.error('[upload]', f.originalname, err.message);
      failed.push(f.originalname);
    }
  }
  db.prepare(`UPDATE entries SET cover_photo_id = COALESCE(cover_photo_id,
    (SELECT id FROM photos WHERE entry_id = ? ORDER BY position LIMIT 1)) WHERE id = ?`).run(e.id, e.id);
  res.json({ entry: getEntry(e.id), failed });
});

api.put('/photos/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Not found.' });
  if ('caption' in req.body) db.prepare('UPDATE photos SET caption = ? WHERE id = ?').run(String(req.body.caption).slice(0, 500), p.id);
  if (req.body.cover) db.prepare('UPDATE entries SET cover_photo_id = ? WHERE id = ?').run(p.id, p.entry_id);
  res.json({ entry: getEntry(p.entry_id) });
});

api.delete('/photos/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Not found.' });
  db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
  db.prepare('UPDATE entries SET cover_photo_id = NULL WHERE cover_photo_id = ?').run(p.id);
  removeImage(p);
  res.json({ entry: getEntry(p.entry_id) });
});

app.use('/api', api);

app.use((req, res) => res.status(404).send(views.notFoundPage({ author: req.author })));
app.use((err, req, res, _next) => {
  console.error(err);
  if (req.path.startsWith('/api')) return res.status(err.status || 500).json({ error: err.message || 'Server error' });
  res.status(500).send('Something broke. Try again in a minute.');
});

app.listen(config.port, config.host, () => {
  console.log(`datesin50states on http://${config.host}:${config.port} (${config.prod ? 'production' : 'development'})`);
});
