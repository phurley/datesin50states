// Imports photos from a public iCloud Shared Album ("Public Website" turned on).
// Uses the same JSON endpoints the icloud.com shared-album web page uses.
import { db } from './db.js';
import { storeImage } from './media.js';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const MAX_PHOTOS = 400;

// Newer "Shared Collections" links (photos.icloud.com/shared/album/<id>, share.icloud.com/photos/<id>).
// Their photos are encrypted and decrypted in the browser, so we can't import them, only link to them.
// We do read the album title from CloudKit's public share lookup to label the link.
export function collectionId(url) {
  const m = String(url || '').trim().match(/^https:\/\/(?:photos|www)\.icloud\.com\/shared\/album\/([A-Za-z0-9_-]{10,})/i)
    || String(url || '').trim().match(/^https:\/\/share\.icloud\.com\/photos\/([A-Za-z0-9_-]{10,})/i);
  return m ? m[1] : null;
}

export async function collectionTitle(url) {
  const id = collectionId(url);
  if (!id) return null;
  try {
    const res = await fetch('https://ckdatabasews.icloud.com/database/1/com.apple.photos.cloud/production/public/records/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://photos.icloud.com' },
      body: JSON.stringify({ shortGUIDs: [{ value: id, shouldFetchRootRecord: true }] }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    return json.results?.[0]?.share?.fields?.['cloudkit.title']?.value || null;
  } catch {
    return null;
  }
}

export function albumKind(url) {
  if (albumToken(url)) return 'legacy';
  if (collectionId(url)) return 'collection';
  return null;
}

export function albumToken(url) {
  const m = String(url || '').trim().match(/^https:\/\/(?:www\.)?icloud\.com\/sharedalbum\/(?:[a-z-]+\/)?#([A-Za-z0-9]+)/i);
  return m ? m[1] : null;
}

function partitionHost(token) {
  const b62 = (s) => [...s].reduce((n, ch) => n * 62 + BASE62.indexOf(ch), 0);
  const n = token[0] === 'A' ? b62(token[1]) : b62(token.slice(1, 3));
  return `p${String(n).padStart(2, '0')}-sharedstreams.icloud.com`;
}

async function post(host, token, endpoint, body, hops = 0) {
  const res = await fetch(`https://${host}/${token}/sharedstreams/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Origin: 'https://www.icloud.com' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 330 && hops < 3) {
    const json = await res.json().catch(() => ({}));
    const next = res.headers.get('x-apple-mme-host') || json['X-Apple-MMe-Host'];
    if (next) return post(next, token, endpoint, body, hops + 1);
  }
  if (!res.ok) {
    throw new Error(res.status === 404
      ? 'Album not found. In Photos, open the shared album, tap the people icon, and turn on "Public Website".'
      : `iCloud returned HTTP ${res.status}`);
  }
  return { host, json: await res.json() };
}

async function fetchAlbum(token) {
  const { host, json: stream } = await post(partitionHost(token), token, 'webstream', { streamCtag: null });
  const photos = (stream.photos || [])
    .filter((p) => p.mediaAssetType !== 'video')
    .slice(0, MAX_PHOTOS)
    .map((p) => {
      // pick the largest numbered derivative (keys are like "342", "2049")
      const derivs = Object.entries(p.derivatives || {})
        .filter(([k]) => /^\d+$/.test(k))
        .map(([, d]) => d)
        .sort((a, b) => Number(b.width) - Number(a.width));
      return { guid: p.photoGuid, caption: p.caption || null, date: p.dateCreated || null, checksum: derivs[0]?.checksum };
    })
    .filter((p) => p.checksum);

  const urls = {};
  for (let i = 0; i < photos.length; i += 25) {
    const { json } = await post(host, token, 'webasseturls', { photoGuids: photos.slice(i, i + 25).map((p) => p.guid) });
    for (const [checksum, item] of Object.entries(json.items || {})) {
      urls[checksum] = `https://${item.url_location}${item.url_path}`;
    }
  }
  return { name: stream.streamName, photos: photos.map((p) => ({ ...p, url: urls[p.checksum] })).filter((p) => p.url) };
}

const running = new Set();

// Download any album photos we don't have yet. Safe to call repeatedly.
// limits: { remaining (photos this map may still add), maxBytes } for free-tier maps.
export async function syncAlbum(entryId, limits = {}) {
  if (running.has(entryId)) return { busy: true };
  running.add(entryId);
  try {
    const entry = db.prepare('SELECT id, album_url, cover_photo_id FROM entries WHERE id = ?').get(entryId);
    const token = albumToken(entry?.album_url);
    if (!token) return { added: 0 };
    const album = await fetchAlbum(token);
    const have = new Set(db.prepare("SELECT source_key FROM photos WHERE entry_id = ? AND source = 'icloud'")
      .all(entryId).map((r) => r.source_key));
    let pos = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM photos WHERE entry_id = ?').get(entryId).p;
    const insert = db.prepare(`INSERT OR IGNORE INTO photos
      (entry_id, source, source_key, file, thumb, width, height, caption, taken_at, position)
      VALUES (?, 'icloud', ?, ?, ?, ?, ?, ?, ?, ?)`);
    let added = 0;
    let remaining = limits.remaining ?? Infinity;
    for (const p of album.photos) {
      if (have.has(p.guid)) continue;
      if (remaining <= 0) break;
      const res = await fetch(p.url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) continue;
      const img = await storeImage(Buffer.from(await res.arrayBuffer()), { maxBytes: limits.maxBytes });
      remaining--;
      insert.run(entryId, p.guid, img.file, img.thumb, img.width, img.height, p.caption, img.takenAt || p.date, ++pos);
      added++;
    }
    db.prepare(`UPDATE entries SET album_synced_at = datetime('now'), album_error = NULL,
      cover_photo_id = COALESCE(cover_photo_id, (SELECT id FROM photos WHERE entry_id = ? ORDER BY position LIMIT 1))
      WHERE id = ?`).run(entryId, entryId);
    return { added, total: album.photos.length };
  } catch (e) {
    console.error(`[icloud] entry ${entryId}:`, e.message);
    db.prepare('UPDATE entries SET album_error = ? WHERE id = ?').run(e.message, entryId);
    return { error: e.message };
  } finally {
    running.delete(entryId);
  }
}

export function isSyncing(entryId) { return running.has(entryId); }
