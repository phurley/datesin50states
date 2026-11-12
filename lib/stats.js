// Simple, cookie-free page-view counting.
//
// Pages send a beacon (POST /hit) after they load, so bots that don't run JavaScript are never
// counted. A visitor is a salted hash of IP + user agent: no IP is stored, and the salt never
// leaves the server. scripts/backfill-stats.js fills in older days from nginx's access log.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { db } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS page_views (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,            -- ISO time (UTC)
  path TEXT NOT NULL,
  map_id INTEGER,              -- the map (or collection) the page belongs to
  state TEXT,                  -- two-letter code on state pages
  visitor TEXT NOT NULL,       -- salted hash of IP + user agent
  referrer TEXT,               -- other site's host, if the visitor came from one
  device TEXT,                 -- 'phone' | 'tablet' | 'desktop'
  own INTEGER NOT NULL DEFAULT 0, -- a member looking at their own map
  source TEXT NOT NULL DEFAULT 'beacon' -- 'beacon' | 'log' (backfilled)
);
CREATE INDEX IF NOT EXISTS page_views_ts ON page_views(ts);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

let salt = db.prepare("SELECT value FROM settings WHERE key = 'visitor_salt'").get()?.value;
if (!salt) {
  salt = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('visitor_salt', ?)").run(salt);
  salt = db.prepare("SELECT value FROM settings WHERE key = 'visitor_salt'").get().value;
}

export const visitorId = (ip, ua) => crypto.createHmac('sha256', salt).update(`${ip}|${ua || ''}`).digest('base64url').slice(0, 16);

export const BOT_RE = /bot|crawl|spider|slurp|preview|fetch|scan|monitor|headless|lighthouse|python|curl|wget|httpclient|go-http|java\/|okhttp|axios|node-fetch|libwww|scrapy|facebookexternalhit|embedly|whatsapp|telegram|discord|skype|bitly|quora|pinterest|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claude|perplexity|ccbot|dataforseo|censys|zgrab|masscan|nmap|nuclei/i;
export const isBot = (ua) => !ua || ua.length < 20 || BOT_RE.test(ua);

export function deviceOf(ua = '') {
  if (/iPad|Tablet|Kindle|Silk|PlayBook|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua)) return 'phone';
  return 'desktop';
}

// Sign-in round trips aren't referrals.
const SIGN_IN_HOSTS = new Set(['appleid.apple.com', 'accounts.google.com']);

// The other site's host (e.g. "facebook.com"), or null for our own pages and direct visits.
export function referrerHost(ref, ownHost) {
  if (!ref || ref === '-') return null;
  try {
    const u = new URL(ref);
    if (!/^https?:$/.test(u.protocol)) return null;
    const h = u.hostname.toLowerCase().replace(/^(www|m|l|lm|mobile)\./, '');
    if (!h || SIGN_IN_HOSTS.has(h) || h === ownHost || h.endsWith(`.${ownHost}`) || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h === 'localhost') return null;
    return h.slice(0, 100);
  } catch { return null; }
}

const STATE_CODES = new Set(JSON.parse(readFileSync(new URL('./usa-states.json', import.meta.url), 'utf8')).map((s) => s.code));

// Which map/state a page path is about: /, /state/ca, /some-slug/, /some-slug/state/ca.
// Returns null for paths that aren't map or state pages (profile, login, ...), which we don't count.
export function resolvePath(rawPath, rootMapId) {
  const p = String(rawPath || '').split(/[?#]/)[0].toLowerCase();
  let m = p.match(/^\/(?:state\/([a-z]{2})\/?)?$/);
  if (m) return pageFor(rootMapId, m[1], p);
  m = p.match(/^\/([a-z0-9-]{3,48})\/(?:state\/([a-z]{2})\/?)?$/);
  if (!m) return null;
  const map = db.prepare('SELECT id, is_root FROM maps WHERE slug = ?').get(m[1])
    || db.prepare('SELECT m.id, m.is_root FROM slug_history h JOIN maps m ON m.id = h.map_id WHERE h.slug = ?').get(m[1]);
  if (!map) return null;
  return pageFor(map.id, m[2], p);
}
function pageFor(mapId, st, p) {
  const state = st ? st.toUpperCase() : null;
  if (state && !STATE_CODES.has(state)) return null;
  return { map_id: mapId, state, path: p.replace(/\/$/, '') || '/' };
}

const insert = db.prepare(`INSERT INTO page_views (ts, path, map_id, state, visitor, referrer, device, own, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
export function recordView(v) {
  insert.run(v.ts, v.path, v.map_id, v.state, v.visitor, v.referrer, v.device, v.own ? 1 : 0, v.source || 'beacon');
}

// Ignore a repeat of the same page by the same visitor within 30 seconds (reloads, back/forward).
const recent = new Map();
export function isRepeat(visitor, path) {
  const k = `${visitor}${path}`, t = Date.now();
  const seen = recent.get(k);
  recent.set(k, t);
  if (recent.size > 20000) recent.clear();
  return seen && t - seen < 30e3;
}

// --- Report --------------------------------------------------------------------

const dayFmt = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFmt = (tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' });

export function report({ days, mapId = null, tz = 'America/Los_Angeles' }) {
  const nowMs = Date.now();
  const toDay = dayFmt(tz), toHour = hourFmt(tz);
  const first = db.prepare('SELECT MIN(ts) AS t FROM page_views WHERE own = 0').get().t;
  // "All" starts at the first recorded view.
  const span = days || (first ? Math.max(1, Math.ceil((nowMs - Date.parse(first)) / 864e5) + 1) : 30);
  const sinceMs = nowMs - span * 864e5;
  const since = new Date(sinceMs).toISOString();
  const mapFilter = mapId ? 'AND map_id = ?' : '';
  const args = mapId ? [mapId] : [];
  const rows = db.prepare(`SELECT ts, path, map_id, state, visitor, referrer, device, source FROM page_views
    WHERE own = 0 AND ts >= ? ${mapFilter} ORDER BY ts`).all(since, ...args);

  // Visitors seen before this window count as "returning".
  const before = new Set(db.prepare(`SELECT DISTINCT visitor FROM page_views WHERE own = 0 AND ts < ? ${mapFilter}`)
    .all(since, ...args).map((r) => r.visitor));

  const dayKeys = [];
  for (let i = span - 1; i >= 0; i--) dayKeys.push(toDay.format(new Date(nowMs - i * 864e5)));
  const byDay = new Map([...new Set(dayKeys)].map((d) => [d, { day: d, views: 0, visitors: new Set(), log: false }]));
  const visitors = new Set(), returning = new Set(), firstDay = new Map();
  const tally = () => new Map();
  const states = tally(), maps = tally(), pages = tally(), refs = tally(), devices = tally();
  const hours = Array(24).fill(0);
  const bump = (m, k, n = 1) => k != null && m.set(k, (m.get(k) || 0) + n);
  const live = new Set();

  for (const r of rows) {
    const t = new Date(r.ts);
    const d = byDay.get(toDay.format(t));
    if (d) { d.views++; d.visitors.add(r.visitor); if (r.source === 'log') d.log = true; }
    visitors.add(r.visitor);
    const fd = firstDay.get(r.visitor);
    if (before.has(r.visitor) || (fd && fd !== toDay.format(t))) returning.add(r.visitor);
    if (!fd) firstDay.set(r.visitor, toDay.format(t));
    bump(states, r.state);
    bump(maps, r.map_id);
    bump(pages, r.path);
    bump(refs, r.referrer);
    bump(devices, r.device);
    hours[Number(toHour.format(t)) % 24]++;
    if (nowMs - t.getTime() < 5 * 60e3) live.add(r.visitor);
  }

  const top = (m, n = 10) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
  const mapNames = new Map(db.prepare('SELECT id, slug, is_root, kind, title_script, title FROM maps').all().map((m) => [m.id, m]));
  const series = [...byDay.values()].map((d) => ({ day: d.day, views: d.views, visitors: d.visitors.size, log: d.log }));
  const busiest = series.reduce((a, b) => (b.views > (a?.views ?? -1) ? b : a), null);

  return {
    span, since, tz,
    views: rows.length,
    visitors: visitors.size,
    returning: returning.size,
    live: live.size,
    allTime: db.prepare(`SELECT COUNT(*) AS n FROM page_views WHERE own = 0 ${mapFilter}`).get(...args).n,
    firstView: first,
    series, busiest,
    states: Object.fromEntries(states),
    maps: top(maps).map(([id, n]) => ({ map: mapNames.get(id), n })).filter((m) => m.map),
    pages: top(pages),
    referrers: top(refs),
    devices: Object.fromEntries(devices),
    hours,
    backfilledUntil: db.prepare("SELECT MAX(ts) AS t FROM page_views WHERE source = 'log'").get().t,
  };
}
