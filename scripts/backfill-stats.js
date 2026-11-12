// Fill page_views from nginx access logs (combined format), for days before the beacon existed.
//
//   zcat -f /var/log/nginx/access.log* | sudo -u dates env $(cat /etc/datesin50states.env | xargs) \
//     node scripts/backfill-stats.js
//
// nginx's log is shared with other sites on the server and has no Host, so a line only counts if
//   - it's a GET of a map or state page that exists here (200, or 304), and for "/" a full-size
//     page (the other site's index.html is tiny), and
//   - the same IP + browser also fetched this site's own CSS/JS or sent a datesin50states.com
//     referrer, i.e. a real browser was on this site (scanners with fake browser names don't), and
//   - the user agent isn't a known bot.
// People who edited (API writes, /profile) are treated as authors, and their views don't count.
// Re-running replaces earlier backfilled rows; nothing at or after the first live beacon is touched.
import readline from 'node:readline';
import { config } from '../lib/config.js';
import { db, tx, ROOT_MAP_ID } from '../lib/db.js';
import { visitorId, isBot, deviceOf, referrerHost, resolvePath, recordView } from '../lib/stats.js';

const LINE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+) [^"]*" (\d{3}) (\d+|-) "([^"]*)" "([^"]*)"/;
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const parseTime = (t) => {
  const m = t.match(/^(\d+)\/(\w+)\/(\d+):(\d+):(\d+):(\d+) ([+-])(\d\d)(\d\d)$/);
  if (!m) return null;
  const off = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  return new Date(Date.UTC(+m[3], MON[m[2]], +m[1], +m[4], +m[5], +m[6]) - off * 60e3);
};

const host = new URL(config.baseUrl).hostname.replace(/^www\./, '');
const ownRef = new RegExp(`^https?://(www\\.)?${host.replace(/\./g, '\\.')}/`, 'i');
const ASSET = /^\/(css\/style\.css|js\/(map|lightbox|editor)\.js|img\/states\/|img\/favicon\.svg)/;

const rows = [];
const human = new Set();
const authors = new Set();
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let lines = 0, bad = 0;
for await (const line of rl) {
  lines++;
  const m = line.match(LINE);
  if (!m) { bad++; continue; }
  const [, ip, time, method, url, status, bytes, ref, ua] = m;
  const key = `${ip}|${ua}`;
  const path = url.split('?')[0];
  if (ownRef.test(ref) || ASSET.test(path)) human.add(key);
  if ((method !== 'GET' && path.startsWith('/api/') && status.startsWith('2')) || (method === 'GET' && path === '/profile' && status === '200')) authors.add(key);
  if (method !== 'GET' || (status !== '200' && status !== '304')) continue;
  if (path === '/' && status === '200' && Number(bytes) < 5000) continue; // the other site's index.html
  rows.push({ key, ip, ua, path, ref, time });
}

const firstBeacon = db.prepare("SELECT MIN(ts) AS t FROM page_views WHERE source = 'beacon'").get().t;
const cutoff = firstBeacon ? Date.parse(firstBeacon) : Infinity;
const last = new Map();
const out = [];
for (const r of rows) {
  if (!human.has(r.key) || isBot(r.ua)) continue;
  const page = resolvePath(r.path, ROOT_MAP_ID);
  if (!page) continue;
  const t = parseTime(r.time);
  if (!t || t.getTime() >= cutoff) continue;
  out.push({ t, r, page });
}
out.sort((a, b) => a.t - b.t);

let kept = 0, own = 0;
tx(() => {
  db.prepare("DELETE FROM page_views WHERE source = 'log'").run();
  for (const { t, r, page } of out) {
    const visitor = visitorId(r.ip, r.ua);
    const k = `${visitor}${page.path}`;
    if (last.has(k) && t - last.get(k) < 30e3) continue; // reloads
    last.set(k, t.getTime());
    const isOwn = authors.has(r.key);
    own += isOwn;
    kept++;
    recordView({ ts: t.toISOString(), ...page, visitor, referrer: referrerHost(r.ref, host), device: deviceOf(r.ua), own: isOwn, source: 'log' });
  }
  // Anyone the beacon has since seen viewing their own map is an author on older days too.
  db.prepare(`UPDATE page_views SET own = 1 WHERE source = 'log' AND visitor IN
    (SELECT DISTINCT visitor FROM page_views WHERE source = 'beacon' AND own = 1)`).run();
});

const span = db.prepare("SELECT MIN(ts) AS a, MAX(ts) AS b, COUNT(DISTINCT visitor) AS v FROM page_views WHERE source = 'log' AND own = 0").get();
console.log(`read ${lines} lines (${bad} unparsed), ${human.size} real browsers, ${authors.size} authors`);
console.log(`backfilled ${kept} views (${own} by authors, not counted), ${span.v} visitors, ${span.a ?? '-'} → ${span.b ?? '-'}`);
