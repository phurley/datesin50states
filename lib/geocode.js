// Turns an entry's free-text place ("Harvest Host- Batavia, OH") into coordinates with
// OpenStreetMap's Nominatim, for the map tour when the entry's photos have no GPS.
// Nominatim's rules: at most one request a second and an identifying User-Agent, so every
// lookup goes through one slow queue. Results are stored on the entry, keyed by state+place,
// so each place is looked up once.
import { db } from './db.js';
import { STATE_BY_CODE } from './views.js';

const UA = 'datesin50states.com map tour';
const GAP_MS = 1100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The whole string first, then its pieces: "Corbin Kentucky-SANDERS CAFE & MUSEUM" finds nothing,
// but "Corbin Kentucky" does.
function candidates(place) {
  const parts = place.split(/\s*[-–—|/•]\s*|\s*\(\s*|\)\s*/).map((s) => s.trim()).filter((s) => s.length > 2);
  return [...new Set([place.trim(), ...parts])].slice(0, 4);
}

let last = 0;
async function search(q) {
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.search = new URLSearchParams({ q, countrycodes: 'us', format: 'jsonv2', limit: '1', addressdetails: '1' });
  const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Nominatim HTTP ${r.status}`);
  return (await r.json())[0] || null;
}

// { lat, lng } of the first candidate that lands in the entry's state, or null. Throws on network trouble.
export async function geocodePlace(place, code) {
  const state = STATE_BY_CODE[code];
  if (!place?.trim() || !state) return null;
  for (const c of candidates(place)) {
    const hit = await search(`${c}, ${state.name}`);
    if (hit && hit.address?.['ISO3166-2-lvl4'] === `US-${code}`) return { lat: Number(hit.lat), lng: Number(hit.lon) };
  }
  return null;
}

// One worker drains the queue so concurrent saves still respect the rate limit.
const queue = new Set();
let working = false;

export function geocodeEntry(id) {
  queue.add(Number(id));
  if (!working) drain();
}

async function drain() {
  working = true;
  while (queue.size) {
    const id = queue.values().next().value;
    queue.delete(id);
    const e = db.prepare('SELECT id, state, place, place_key FROM entries WHERE id = ?').get(id);
    if (!e) continue;
    const key = e.place?.trim() ? `${e.state}|${e.place.trim()}` : null;
    if (key === e.place_key) continue;
    try {
      const pt = key ? await geocodePlace(e.place, e.state) : null;
      // Only store if the place didn't change while we were looking it up.
      db.prepare('UPDATE entries SET place_lat = ?, place_lng = ?, place_key = ? WHERE id = ? AND place IS ?')
        .run(pt?.lat ?? null, pt?.lng ?? null, key, id, e.place);
    } catch (err) {
      console.error(`[geocode] entry ${id}:`, err.message); // left unkeyed, so the next start retries it
    }
  }
  working = false;
}

// On startup: look up any place we haven't yet (new column, or edits made while it was down).
export function geocodeBackfill() {
  const rows = db.prepare(`SELECT id FROM entries WHERE (place IS NOT NULL AND TRIM(place) != '' AND place_key IS NOT (state || '|' || TRIM(place)))
    OR ((place IS NULL OR TRIM(place) = '') AND place_key IS NOT NULL)`).all();
  for (const r of rows) geocodeEntry(r.id);
}
