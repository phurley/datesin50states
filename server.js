import path from 'node:path';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { config } from './lib/config.js';
import { db, tx, ROOT_MAP_ID } from './lib/db.js';
import {
  loadAuthor, requireAuthor, formGuard, startSession, endSession, parseCookies, cookie, appendCookie,
  appleRedirect, appleCallback, googleReady, googleRedirect, googleCallback, INVITE_COOKIE, PENDING_COOKIE,
} from './lib/auth.js';
import { storeImage, removeImage } from './lib/media.js';
import { albumKind, collectionTitle, syncAlbum, isSyncing } from './lib/icloud.js';
import { randomSlug, cleanSlug } from './lib/slugs.js';
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
const form = express.urlencoded({ extended: false, limit: '64kb' });
const now = () => new Date().toISOString();

// --- Maps ----------------------------------------------------------------------

const getMap = (id) => db.prepare('SELECT * FROM maps WHERE id = ?').get(id);
const mapBase = (m) => (m.is_root ? '' : `/${m.slug}`);
const mapUrl = (m) => `${mapBase(m)}/`;
const canEdit = (req, m) => Boolean(req.author && req.author.map_id === m.id);

// Admin-backed maps have no limits; everyone else is on the free tier.
function mapLimits(mapId) {
  const admin = db.prepare("SELECT 1 FROM authors WHERE map_id = ? AND role = 'admin'").get(mapId);
  const used = db.prepare('SELECT COUNT(*) AS n FROM photos p JOIN entries e ON e.id = p.entry_id WHERE e.map_id = ?').get(mapId).n;
  return admin
    ? { tier: 'admin', used, limit: null, remaining: Infinity, maxBytes: Infinity }
    : { tier: 'free', used, limit: config.freePhotoLimit, remaining: Math.max(0, config.freePhotoLimit - used), maxBytes: config.freePhotoBytes };
}

function createMap(name) {
  let slug;
  do slug = randomSlug(); while (db.prepare('SELECT 1 FROM maps WHERE slug = ? UNION SELECT 1 FROM slug_history WHERE slug = ?').get(slug, slug));
  const who = name || 'Our';
  const r = db.prepare('INSERT INTO maps (slug, tagline, footer) VALUES (?, ?, ?)')
    .run(slug, `${who}’s travelogue — dates in every state in the union.`, `${who} · dates in every state`);
  return getMap(Number(r.lastInsertRowid));
}

// Delete a map with everything in it, including photo files.
function deleteMap(mapId) {
  const photos = db.prepare('SELECT p.file, p.thumb FROM photos p JOIN entries e ON e.id = p.entry_id WHERE e.map_id = ?').all(mapId);
  tx(() => {
    db.prepare('DELETE FROM entries WHERE map_id = ?').run(mapId);
    db.prepare('DELETE FROM maps WHERE id = ? AND is_root = 0').run(mapId);
  });
  photos.forEach(removeImage);
}

// --- Data helpers (all scoped to one map) ------------------------------------

const VALID_STATE = (code) => Boolean(views.STATE_BY_CODE[String(code || '').toUpperCase()]);

// One photo per visited state for the map: the chosen one, else the newest entry's cover, else any photo.
function mapPhotos(mapId) {
  const rows = db.prepare(`
    SELECT e.state,
      COALESCE(
        (SELECT p.thumb FROM state_photos sp JOIN photos p ON p.id = sp.photo_id WHERE sp.map_id = e.map_id AND sp.state = e.state),
        (SELECT p.thumb FROM entries e2 JOIN photos p ON p.id = e2.cover_photo_id
           WHERE e2.map_id = e.map_id AND e2.state = e.state ORDER BY COALESCE(e2.date, e2.created_at) DESC, e2.id DESC LIMIT 1),
        (SELECT p.thumb FROM entries e3 JOIN photos p ON p.entry_id = e3.id
           WHERE e3.map_id = e.map_id AND e3.state = e.state ORDER BY COALESCE(e3.date, e3.created_at) DESC, p.position LIMIT 1)
      ) AS thumb
    FROM entries e WHERE e.map_id = ? GROUP BY e.state`).all(mapId);
  const out = {};
  for (const r of rows) out[r.state] = r.thumb ? `/media/${r.thumb}` : views.stateArt(r.state);
  return out;
}

function stateCounts(mapId) {
  const out = {};
  for (const r of db.prepare('SELECT state, COUNT(*) AS n FROM entries WHERE map_id = ? GROUP BY state').all(mapId)) out[r.state] = r.n;
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

function entriesFor(mapId, state) {
  const entries = db.prepare(`SELECT e.*, a.name AS author_name FROM entries e LEFT JOIN authors a ON a.id = e.author_id
    WHERE e.map_id = ? AND e.state = ? ORDER BY COALESCE(e.date, e.created_at) DESC, e.id DESC`).all(mapId, state).map((e) => ({ ...e }));
  const photos = photosFor(entries.map((e) => e.id));
  for (const e of entries) {
    e.photos = photos[e.id] || [];
    if (e.cover_photo_id) e.photos.sort((a, b) => (b.id === e.cover_photo_id) - (a.id === e.cover_photo_id));
    e.syncing = isSyncing(e.id);
    e.album_kind = albumKind(e.album_url);
  }
  return entries;
}

function getEntry(id) {
  const e = db.prepare('SELECT * FROM entries WHERE id = ?').get(Number(id));
  if (!e) return null;
  const map = db.prepare('SELECT photo_id FROM state_photos WHERE map_id = ? AND state = ?').get(e.map_id, e.state);
  return { ...e, photos: photosFor([e.id])[e.id] || [], syncing: isSyncing(e.id), album_kind: albumKind(e.album_url),
    map_photo_id: map?.photo_id ?? null };
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
  if (out.album_url && !albumKind(out.album_url)) {
    return { error: 'That doesn’t look like an iCloud shared album link (photos.icloud.com/shared/album/… or icloud.com/sharedalbum/#…).' };
  }
  return { entry: out };
}

// --- Map pages -----------------------------------------------------------------

function renderMap(req, res, map) {
  const recent = db.prepare(`SELECT e.id, e.state, e.title, e.date, e.cover_photo_id
    FROM entries e WHERE e.map_id = ? ORDER BY COALESCE(e.date, e.created_at) DESC, e.id DESC LIMIT 6`).all(map.id).map((e) => ({ ...e }));
  // Postcard slideshows: cover first, then the rest in order, capped to keep the page light.
  const photos = photosFor(recent.map((e) => e.id));
  for (const e of recent) {
    const list = photos[e.id] || [];
    list.sort((a, b) => (b.id === e.cover_photo_id) - (a.id === e.cover_photo_id));
    e.thumbs = list.slice(0, 10).map((p) => `/media/${p.thumb}`);
    if (!e.thumbs.length) e.thumbs = [views.stateArt(e.state)];
  }
  // The map's "play" tour: every entry, oldest date first (undated last).
  const tour = db.prepare('SELECT id, state, title, date FROM entries WHERE map_id = ? ORDER BY date IS NULL, date, id').all(map.id);
  res.send(views.mapPage({
    author: req.author, map, base: mapBase(map), canEdit: canEdit(req, map), welcome: 'welcome' in req.query,
    counts: stateCounts(map.id), photos: mapPhotos(map.id), recent, tour,
  }));
}

function renderState(req, res, map) {
  const state = views.STATE_BY_CODE[req.params.code.toUpperCase()];
  if (!state) return res.status(404).send(views.notFoundPage({ author: req.author }));
  const entries = entriesFor(map.id, state.code);
  // States without entries are only open to the map's own authors.
  if (!entries.length && !canEdit(req, map)) return res.redirect(mapUrl(map));
  res.send(views.statePage({ author: req.author, map, base: mapBase(map), canEdit: canEdit(req, map), state, entries }));
}

app.get('/', (req, res) => renderMap(req, res, getMap(ROOT_MAP_ID)));
app.get('/state/:code', (req, res) => renderState(req, res, getMap(ROOT_MAP_ID)));

// --- Sign-in -------------------------------------------------------------------

app.get('/login', (req, res) => {
  if (req.author) return res.redirect(req.author.map_id ? mapUrl(getMap(req.author.map_id)) : '/profile');
  res.send(views.loginPage({ error: req.query.error, devLogin: config.devLogin, appleReady: Boolean(config.appleClientId), googleReady: googleReady() }));
});

app.get('/auth/apple', appleRedirect);
// Apple posts back cross-site, so our SameSite=Lax cookies (session, invite, pending) aren't
// sent with that POST. Hand the verified result to a same-site GET and finish there.
const handoffs = new Map();
app.post('/auth/apple/callback', form, async (req, res) => {
  const result = await appleCallback(req, res);
  const t = crypto.randomBytes(18).toString('base64url');
  for (const [k, v] of handoffs) if (v.exp < Date.now()) handoffs.delete(k);
  handoffs.set(t, { result, exp: Date.now() + 120e3 });
  res.redirect(303, `/auth/finish/${t}`);
});
app.get('/auth/finish/:t', (req, res) => {
  const h = handoffs.get(req.params.t);
  handoffs.delete(req.params.t);
  if (!h || h.exp < Date.now()) return res.redirect('/login?error=Sign-in+expired.+Try+again.');
  finishSignIn(req, res, h.result);
});
app.get('/auth/google', googleRedirect);
app.get('/auth/google/callback', async (req, res) => finishSignIn(req, res, await googleCallback(req, res)));

app.post('/auth/logout', formGuard, (req, res) => {
  endSession(req, res);
  res.redirect(303, '/');
});

if (config.devLogin) {
  // Dev only: sign in as an existing author, or as a brand-new "Google" identity to test sign-up.
  app.post('/auth/dev', form, (req, res) => {
    const name = String(req.body.author || '');
    const a = db.prepare('SELECT id FROM authors WHERE name = ?').get(name);
    if (a && !req.body.fresh) { startSession(res, a.id); return res.redirect(303, '/'); }
    finishSignIn(req, res, { intent: 'signin', identity: { provider: 'google', sub: `dev-${name || crypto.randomUUID()}`, email: null, emailVerified: false, name } });
  });
}

const validInvite = (token) => (token
  ? db.prepare('SELECT * FROM invites WHERE token = ? AND expires_at > ?').get(String(token), now())
  : null);

// Every provider ends here: link to the signed-in account, sign in a known person,
// add someone arriving by QR invite, or park a new person until they enter a join code.
function finishSignIn(req, res, result) {
  if (!result.identity) return res.redirect(303, `/login?error=${encodeURIComponent(result.error || 'Sign-in failed.')}`);
  const { provider, sub, email, emailVerified, name } = result.identity;
  const col = provider === 'apple' ? 'apple_sub' : 'google_sub';
  const label = provider === 'apple' ? 'Apple ID' : 'Google account';

  if (result.intent === 'link' && req.author) {
    const other = db.prepare(`SELECT id FROM authors WHERE ${col} = ?`).get(sub);
    if (other && other.id !== req.author.id) return res.redirect(303, `/profile?error=${encodeURIComponent(`That ${label} already signs in to another account.`)}`);
    db.prepare(`UPDATE authors SET ${col} = ? WHERE id = ?`).run(sub, req.author.id);
    return res.redirect(303, `/profile?msg=${encodeURIComponent(`${label} connected.`)}`);
  }

  let author = db.prepare(`SELECT * FROM authors WHERE ${col} = ?`).get(sub);
  // Patrick & Susan: bind on first sign-in by their verified email (never for anyone else).
  if (!author && email && emailVerified) {
    author = db.prepare(`SELECT * FROM authors WHERE email = ? AND role = 'admin' AND ${col} IS NULL`).get(email);
    if (author) db.prepare(`UPDATE authors SET ${col} = ? WHERE id = ?`).run(sub, author.id);
  }
  const inviteToken = parseCookies(req)[INVITE_COOKIE];
  const invite = validInvite(inviteToken);

  if (author) {
    startSession(res, author.id);
    if (invite && invite.map_id !== author.map_id) return res.redirect(303, `/join/${invite.token}`);
    return res.redirect(303, author.map_id ? mapUrl(getMap(author.map_id)) : '/profile');
  }

  if (invite) {
    const r = db.prepare(`INSERT INTO authors (name, ${col}, role, map_id) VALUES (?, ?, 'free', ?)`)
      .run(name || 'Traveler', sub, invite.map_id);
    startSession(res, Number(r.lastInsertRowid));
    appendCookie(res, cookie(INVITE_COOKIE, '', { maxAge: 0 }));
    return res.redirect(303, `${mapUrl(getMap(invite.map_id))}?welcome`);
  }

  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('DELETE FROM pending_signups WHERE expires_at < ?').run(now());
  db.prepare('INSERT INTO pending_signups (token, provider, sub, email, name, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(token, provider, sub, email, name, new Date(Date.now() + 30 * 60e3).toISOString());
  appendCookie(res, cookie(PENDING_COOKIE, token, { maxAge: 30 * 60 }));
  res.redirect(303, '/join');
}

// --- Join: new person with a join code ----------------------------------------

const pendingFor = (req) => {
  const t = parseCookies(req)[PENDING_COOKIE];
  return t ? db.prepare('SELECT * FROM pending_signups WHERE token = ? AND expires_at > ?').get(t, now()) : null;
};

app.get('/join', (req, res) => {
  if (req.author) return res.redirect('/profile');
  const pending = pendingFor(req);
  if (!pending) return res.redirect('/login');
  res.send(views.joinCodePage({ name: pending.name, error: req.query.error }));
});

app.post('/join', form, formGuard, (req, res) => {
  const pending = pendingFor(req);
  if (!pending) return res.redirect(303, '/login?error=Your+sign-in+expired.+Try+again.');
  const name = String(req.body.name || '').trim().slice(0, 60) || 'Traveler';
  const code = String(req.body.code || '').trim();
  const col = pending.provider === 'apple' ? 'apple_sub' : 'google_sub';
  let map;
  try {
    map = tx(() => {
      const c = db.prepare(`SELECT * FROM join_codes WHERE code = ? AND active = 1
        AND (max_uses IS NULL OR uses < max_uses) AND (expires_at IS NULL OR expires_at > ?)`).get(code, now());
      if (!c) throw new Error('That join code isn’t valid (or it’s used up).');
      if (db.prepare(`SELECT 1 FROM authors WHERE ${col} = ?`).get(pending.sub)) throw new Error('You already have an account. Sign in again.');
      db.prepare('UPDATE join_codes SET uses = uses + 1 WHERE code = ?').run(c.code);
      const m = createMap(name);
      const r = db.prepare(`INSERT INTO authors (name, ${col}, role, map_id) VALUES (?, ?, 'free', ?)`).run(name, pending.sub, m.id);
      db.prepare('DELETE FROM pending_signups WHERE token = ?').run(pending.token);
      return { ...m, authorId: Number(r.lastInsertRowid) };
    });
  } catch (e) {
    return res.redirect(303, `/join?error=${encodeURIComponent(e.message)}`);
  }
  appendCookie(res, cookie(PENDING_COOKIE, '', { maxAge: 0 }));
  startSession(res, map.authorId);
  res.redirect(303, `${mapUrl(map)}?welcome`);
});

// --- Join: QR invite to an existing map ----------------------------------------

app.get('/join/:token', (req, res) => {
  const invite = validInvite(req.params.token);
  if (!invite) return res.status(410).send(views.messagePage({ author: req.author, script: 'Missed the bus', title: 'Invite expired', body: 'This invite has expired (they last 30 minutes). Ask for a fresh QR code.' }));
  const map = getMap(invite.map_id);
  if (req.author?.map_id === map.id) return res.redirect(mapUrl(map));
  const members = db.prepare('SELECT name FROM authors WHERE map_id = ? ORDER BY id').all(map.id).map((a) => a.name);
  if (!req.author) {
    const left = Math.max(60, Math.floor((Date.parse(invite.expires_at) - Date.now()) / 1000));
    appendCookie(res, cookie(INVITE_COOKIE, invite.token, { maxAge: left }));
  }
  const mine = req.author?.map_id ? db.prepare('SELECT (SELECT COUNT(*) FROM entries WHERE map_id = ?) AS entries, (SELECT COUNT(*) FROM authors WHERE map_id = ?) AS members').get(req.author.map_id, req.author.map_id) : null;
  res.send(views.invitePage({ author: req.author, map, members, token: invite.token, mine, appleReady: Boolean(config.appleClientId), googleReady: googleReady(), devLogin: config.devLogin }));
});

app.post('/join/:token/accept', form, formGuard, (req, res) => {
  if (!req.author) return res.redirect(303, `/join/${req.params.token}`);
  const invite = validInvite(req.params.token);
  if (!invite) return res.redirect(303, `/join/${req.params.token}`);
  const old = req.author.map_id;
  if (req.author.map_is_root) return res.redirect(303, '/profile?error=The+root+map%E2%80%99s+admins+can%E2%80%99t+move+to+another+map.');
  if (old) {
    const { entries, members } = db.prepare('SELECT (SELECT COUNT(*) FROM entries WHERE map_id = ?) AS entries, (SELECT COUNT(*) FROM authors WHERE map_id = ?) AS members').get(old, old);
    if (members === 1 && entries > 0) return res.redirect(303, `/join/${invite.token}`); // page explains
    db.prepare('UPDATE authors SET map_id = ? WHERE id = ?').run(invite.map_id, req.author.id);
    if (members === 1) deleteMap(old);
  } else {
    db.prepare('UPDATE authors SET map_id = ? WHERE id = ?').run(invite.map_id, req.author.id);
  }
  res.redirect(303, `${mapUrl(getMap(invite.map_id))}?welcome`);
});

// --- Profile -------------------------------------------------------------------

function requireSignedIn(req, res, next) {
  if (!req.author) return res.redirect('/login');
  next();
}

function profileData(req) {
  const map = req.author.map_id ? getMap(req.author.map_id) : null;
  return {
    author: req.author,
    map,
    base: map ? mapBase(map) : '',
    members: map ? db.prepare('SELECT id, name, role FROM authors WHERE map_id = ? ORDER BY id').all(map.id) : [],
    limits: map ? mapLimits(map.id) : null,
    appleReady: Boolean(config.appleClientId),
    googleReady: googleReady(),
    msg: req.query.msg,
    error: req.query.error,
  };
}

app.get('/profile', requireSignedIn, (req, res) => res.send(views.profilePage(profileData(req))));

app.post('/profile', requireSignedIn, form, formGuard, (req, res) => {
  const s = (k, max) => String(req.body[k] ?? '').trim().slice(0, max);
  const back = (q) => res.redirect(303, `/profile?${q}`);
  const name = s('name', 60);
  if (!name) return back('error=Your+name+can%E2%80%99t+be+empty.');
  db.prepare('UPDATE authors SET name = ? WHERE id = ?').run(name, req.author.id);
  const map = req.author.map_id ? getMap(req.author.map_id) : null;
  if (map) {
    const { slug, error } = cleanSlug(req.body.slug);
    if (error) return back(`error=${encodeURIComponent(error)}`);
    if (slug !== map.slug) {
      const taken = db.prepare('SELECT 1 FROM maps WHERE slug = ? UNION SELECT 1 FROM slug_history WHERE slug = ? AND map_id != ?').get(slug, slug, map.id);
      if (taken) return back(`error=${encodeURIComponent('That address is taken. Try another.')}`);
      tx(() => {
        db.prepare('DELETE FROM slug_history WHERE slug = ?').run(slug);
        db.prepare('INSERT OR REPLACE INTO slug_history (slug, map_id) VALUES (?, ?)').run(map.slug, map.id);
        db.prepare('UPDATE maps SET slug = ? WHERE id = ?').run(slug, map.id);
      });
    }
    db.prepare('UPDATE maps SET title_script = ?, title = ?, tagline = ?, footer = ? WHERE id = ?')
      .run(s('title_script', 40) || 'Dates in', s('title', 40) || '50 States', s('tagline', 200), s('footer', 200), map.id);
  }
  back('msg=Saved.');
});

// A QR invite to this map, good for 30 minutes.
app.post('/profile/invite', requireSignedIn, form, formGuard, (req, res) => {
  if (!req.author.map_id) return res.redirect(303, '/profile');
  const token = crypto.randomBytes(18).toString('base64url');
  db.prepare('DELETE FROM invites WHERE expires_at < ?').run(now());
  db.prepare('INSERT INTO invites (token, map_id, created_by, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, req.author.map_id, req.author.id, new Date(Date.now() + 30 * 60e3).toISOString());
  res.redirect(303, `/profile/invite/${token}`);
});

app.get('/profile/invite/:token', requireSignedIn, async (req, res) => {
  const invite = validInvite(req.params.token);
  if (!invite || invite.map_id !== req.author.map_id) return res.redirect('/profile?error=That+invite+has+expired.');
  const url = `${config.baseUrl}/join/${invite.token}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#2b2118', light: '#fbf6ea' } });
  res.send(views.qrPage({ author: req.author, url, svg, expiresAt: invite.expires_at }));
});

app.post('/profile/members/:id/remove', requireSignedIn, form, formGuard, (req, res) => {
  const id = Number(req.params.id);
  const m = db.prepare('SELECT id, role FROM authors WHERE id = ? AND map_id = ?').get(id, req.author.map_id);
  if (!m || m.id === req.author.id || m.role === 'admin') return res.redirect(303, '/profile');
  // They keep their account but no map; their profile offers to start a new one.
  db.prepare('UPDATE authors SET map_id = NULL WHERE id = ?').run(id);
  db.prepare('DELETE FROM sessions WHERE author_id = ?').run(id);
  res.redirect(303, '/profile?msg=Removed.');
});

app.post('/profile/delete', requireSignedIn, form, formGuard, (req, res) => {
  if (req.author.admin) return res.redirect(303, '/profile?error=Admin+accounts+can%E2%80%99t+be+deleted+here.');
  if (String(req.body.confirm || '').trim().toLowerCase() !== 'delete') {
    return res.redirect(303, '/profile?error=Type+DELETE+to+confirm.');
  }
  const mapId = req.author.map_id;
  const others = mapId ? db.prepare('SELECT COUNT(*) AS n FROM authors WHERE map_id = ? AND id != ?').get(mapId, req.author.id).n : 0;
  endSession(req, res);
  db.prepare('DELETE FROM authors WHERE id = ?').run(req.author.id);
  if (mapId && !others) deleteMap(mapId);
  res.redirect(303, '/');
});

// Someone removed from a map (or whose map went away) can start a new one.
app.post('/profile/new-map', requireSignedIn, form, formGuard, (req, res) => {
  if (req.author.map_id) return res.redirect(303, '/profile');
  const m = createMap(req.author.name);
  db.prepare('UPDATE authors SET map_id = ? WHERE id = ?').run(m.id, req.author.id);
  res.redirect(303, `${mapUrl(m)}?welcome`);
});

// --- Admin ---------------------------------------------------------------------

function requireAdmin(req, res, next) {
  if (!req.author?.admin) return res.status(404).send(views.notFoundPage({ author: req.author }));
  next();
}

app.get('/admin', requireAdmin, (req, res) => {
  const codes = db.prepare('SELECT * FROM join_codes ORDER BY created_at DESC').all();
  const maps = db.prepare(`SELECT m.*,
      (SELECT GROUP_CONCAT(name, ', ') FROM authors WHERE map_id = m.id) AS members,
      (SELECT COUNT(*) FROM entries WHERE map_id = m.id) AS entries,
      (SELECT COUNT(*) FROM photos p JOIN entries e ON e.id = p.entry_id WHERE e.map_id = m.id) AS photos
    FROM maps m ORDER BY m.is_root DESC, m.created_at DESC`).all();
  res.send(views.adminPage({ author: req.author, codes, maps, msg: req.query.msg, error: req.query.error }));
});

app.post('/admin/codes', requireAdmin, form, formGuard, (req, res) => {
  const code = String(req.body.code || '').trim();
  const orig = String(req.body.orig || '').trim();
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(code)) return res.redirect(303, '/admin?error=Codes+are+4-40+letters%2C+numbers%2C+dashes.');
  const max = req.body.max_uses === '' ? null : Math.max(0, Number(req.body.max_uses) || 0);
  const exp = req.body.expires_at ? new Date(`${req.body.expires_at}T23:59:59Z`).toISOString() : null;
  const active = req.body.active === '0' ? 0 : 1;
  const note = String(req.body.note || '').trim().slice(0, 200) || null;
  try {
    if (orig) {
      db.prepare('UPDATE join_codes SET code = ?, max_uses = ?, expires_at = ?, active = ?, note = ? WHERE code = ?').run(code, max, exp, active, note, orig);
    } else {
      db.prepare('INSERT INTO join_codes (code, max_uses, expires_at, active, note) VALUES (?, ?, ?, ?, ?)').run(code, max, exp, active, note);
    }
  } catch {
    return res.redirect(303, '/admin?error=That+code+already+exists.');
  }
  res.redirect(303, '/admin?msg=Saved.');
});

// --- Author API (scoped to the signed-in person's map) ------------------------

const api = express.Router();
api.use(requireAuthor);
api.use(express.json({ limit: '1mb' }));

// Load an entry and make sure it's on the caller's map.
function ownEntry(req, id) {
  const e = getEntry(id);
  return e && e.map_id === req.author.map_id ? e : null;
}
function ownPhoto(req, id) {
  const p = db.prepare('SELECT p.*, e.map_id, e.state FROM photos p JOIN entries e ON e.id = p.entry_id WHERE p.id = ?').get(Number(id));
  return p && p.map_id === req.author.map_id ? p : null;
}

api.get('/states/:code/entries', (req, res) => {
  const code = req.params.code.toUpperCase();
  if (!VALID_STATE(code)) return res.status(404).json({ error: 'Unknown state.' });
  res.json({ entries: entriesFor(req.author.map_id, code) });
});

api.get('/entries/:id', (req, res) => {
  const e = ownEntry(req, req.params.id);
  e ? res.json({ entry: e }) : res.status(404).json({ error: 'Not found.' });
});

// Legacy shared albums get imported; newer shared collections just get their title for the link.
function kickSync(id) {
  const e = db.prepare('SELECT album_url, map_id FROM entries WHERE id = ?').get(id);
  const kind = albumKind(e?.album_url);
  if (kind === 'legacy') syncAlbum(id, mapLimits(e.map_id)).catch((err) => console.error('[icloud]', err));
  if (kind === 'collection') {
    collectionTitle(e.album_url).then((t) => db.prepare('UPDATE entries SET album_title = ?, album_error = NULL WHERE id = ?').run(t, id));
  }
}

api.post('/entries', (req, res) => {
  const state = String(req.body.state || '').toUpperCase();
  if (!VALID_STATE(state)) return res.status(400).json({ error: 'Unknown state.' });
  const { entry, error } = cleanEntry(req.body);
  if (error) return res.status(400).json({ error });
  const { lastInsertRowid } = db.prepare(`INSERT INTO entries (map_id, state, title, date, place, body, album_url, author_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(req.author.map_id, state, entry.title, entry.date, entry.place, entry.body, entry.album_url, req.author.id);
  const id = Number(lastInsertRowid);
  if (entry.album_url) kickSync(id);
  res.status(201).json({ entry: getEntry(id) });
});

api.put('/entries/:id', (req, res) => {
  const existing = ownEntry(req, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  const { entry, error } = cleanEntry(req.body);
  if (error) return res.status(400).json({ error });
  db.prepare(`UPDATE entries SET title = ?, date = ?, place = ?, body = ?, album_url = ?, updated_at = datetime('now')
    WHERE id = ?`).run(entry.title, entry.date, entry.place, entry.body, entry.album_url, existing.id);
  if (entry.album_url !== existing.album_url) {
    db.prepare('UPDATE entries SET album_title = NULL WHERE id = ?').run(existing.id);
    if (entry.album_url) kickSync(existing.id);
  }
  res.json({ entry: getEntry(existing.id) });
});

api.delete('/entries/:id', (req, res) => {
  const e = ownEntry(req, req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found.' });
  tx(() => db.prepare('DELETE FROM entries WHERE id = ?').run(e.id));
  e.photos.forEach(removeImage);
  res.json({ ok: true });
});

api.post('/entries/:id/sync', (req, res) => {
  const e = ownEntry(req, req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found.' });
  if (!e.album_url) return res.status(400).json({ error: 'No album link on this entry.' });
  if (e.album_kind !== 'legacy') return res.status(400).json({ error: 'This kind of iCloud album can only be linked, not imported.' });
  kickSync(e.id);
  res.json({ ok: true, syncing: true });
});

api.get('/limits', (req, res) => res.json(mapLimits(req.author.map_id)));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 30 },
});

api.post('/entries/:id/photos', upload.array('photos', 30), async (req, res) => {
  const e = ownEntry(req, req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found.' });
  const limits = mapLimits(e.map_id);
  const failed = [];
  let skipped = 0;
  let room = limits.remaining;
  let pos = e.photos.reduce((m, p) => Math.max(m, p.position), 0);
  for (const f of req.files || []) {
    if (room <= 0) { skipped++; continue; }
    try {
      const img = await storeImage(f.buffer, { maxBytes: limits.maxBytes });
      db.prepare(`INSERT INTO photos (entry_id, source, source_key, file, thumb, width, height, taken_at, position)
        VALUES (?, 'upload', ?, ?, ?, ?, ?, ?, ?)`)
        .run(e.id, img.file, img.file, img.thumb, img.width, img.height, img.takenAt, ++pos);
      room--;
    } catch (err) {
      console.error('[upload]', f.originalname, err.message);
      failed.push(f.originalname);
    }
  }
  db.prepare(`UPDATE entries SET cover_photo_id = COALESCE(cover_photo_id,
    (SELECT id FROM photos WHERE entry_id = ? ORDER BY position LIMIT 1)) WHERE id = ?`).run(e.id, e.id);
  const limitNote = skipped ? `Photo limit reached: ${skipped} not added (free maps hold ${limits.limit} photos).` : null;
  res.json({ entry: getEntry(e.id), failed, limitNote, limits: mapLimits(e.map_id) });
});

api.put('/photos/:id', (req, res) => {
  const p = ownPhoto(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  if ('caption' in req.body) db.prepare('UPDATE photos SET caption = ? WHERE id = ?').run(String(req.body.caption).slice(0, 500), p.id);
  if (req.body.cover) db.prepare('UPDATE entries SET cover_photo_id = ? WHERE id = ?').run(p.id, p.entry_id);
  if ('map' in req.body) {
    if (req.body.map) {
      db.prepare(`INSERT INTO state_photos (map_id, state, photo_id) VALUES (?, ?, ?)
        ON CONFLICT(map_id, state) DO UPDATE SET photo_id = excluded.photo_id`).run(p.map_id, p.state, p.id);
    } else {
      db.prepare('DELETE FROM state_photos WHERE map_id = ? AND state = ? AND photo_id = ?').run(p.map_id, p.state, p.id);
    }
  }
  res.json({ entry: getEntry(p.entry_id) });
});

api.delete('/photos/:id', (req, res) => {
  const p = ownPhoto(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
  db.prepare('UPDATE entries SET cover_photo_id = NULL WHERE cover_photo_id = ?').run(p.id);
  removeImage(p);
  res.json({ entry: getEntry(p.entry_id) });
});

app.use('/api', api);

// --- Map slugs (last, so they never shadow the app's own paths) --------------

// Light brake on guessing slugs: 40 misses per IP per 10 minutes.
const misses = new Map();
function slugMiss(req) {
  const t = Date.now();
  const rec = misses.get(req.ip);
  const r = rec && t - rec.t < 10 * 60e3 ? rec : { t, n: 0 };
  r.n++;
  misses.set(req.ip, r);
  if (misses.size > 5000) misses.clear();
  return r.n > 40;
}

function bySlug(req, res, next) {
  const slug = String(req.params.slug || '').toLowerCase();
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) return next();
  const map = db.prepare('SELECT * FROM maps WHERE slug = ?').get(slug);
  if (map) { req.slugMap = map; return next(); }
  const old = db.prepare('SELECT m.slug FROM slug_history h JOIN maps m ON m.id = h.map_id WHERE h.slug = ?').get(slug);
  if (old) return res.redirect(301, req.originalUrl.replace(`/${req.params.slug}`, `/${old.slug}`));
  if (slugMiss(req)) return res.status(429).send('Slow down a little.');
  next();
}

// Express matches "/x" and "/x/" alike; the map's canonical address has the trailing slash.
app.get('/:slug', bySlug, (req, res, next) => {
  if (!req.slugMap) return next();
  if (!req.path.endsWith('/')) return res.redirect(301, `/${req.slugMap.slug}/`);
  renderMap(req, res, req.slugMap);
});
app.get('/:slug/state/:code', bySlug, (req, res, next) => (req.slugMap ? renderState(req, res, req.slugMap) : next()));

app.use((req, res) => res.status(404).send(views.notFoundPage({ author: req.author })));
app.use((err, req, res, _next) => {
  console.error(err);
  if (req.path.startsWith('/api')) return res.status(err.status || 500).json({ error: err.message || 'Server error' });
  res.status(500).send('Something broke. Try again in a minute.');
});

app.listen(config.port, config.host, () => {
  console.log(`datesin50states on http://${config.host}:${config.port} (${config.prod ? 'production' : 'development'})`);
});
