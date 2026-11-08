// Content checks for user-supplied text (Jev, TypeSafe's typed decision model) and
// photos (Google Cloud Vision SafeSearch). Both fail open: if a service is down or
// unconfigured, the content is allowed and the failure is logged.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';

const LIKELIHOOD = { UNKNOWN: 0, VERY_UNLIKELY: 1, UNLIKELY: 2, POSSIBLE: 3, LIKELY: 4, VERY_LIKELY: 5 };

// --- Text (Jev) -----------------------------------------------------------------

// fields: { slug: { label: 'Web address', value: 'rapid-crawling-elk' }, ... }
// Each field is judged on its own (one call each, in parallel) so one bad field
// doesn't color the others. Returns { flagged: ['slug', ...], scores: { slug: 0.02, ... } }.
export async function checkText(fields) {
  const entries = Object.entries(fields).filter(([, f]) => f.value && String(f.value).trim());
  if (!entries.length || !config.typesafeKey) return { flagged: [], scores: {} };
  const scores = {};
  try {
    await Promise.all(entries.map(async ([name, f]) => { scores[name] = await jevScore(f); }));
  } catch (e) {
    console.error('[moderation] text check failed (allowing):', e.message);
    return { flagged: [], scores, error: e.message };
  }
  return { flagged: entries.map(([n]) => n).filter((n) => scores[n] >= config.textFlagAt), scores };
}

async function jevScore({ label, value }) {
  const isAddress = /address/i.test(label);
  const state = `${label} a person entered on a public, family-friendly travel blog site: "${String(value).slice(0, 300)}"`
    + (isAddress ? '\nIt is a web address, so words are joined by dashes; read them as spaces.' : '');
  const r = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.typesafeKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-latest',
      state,
      questions: {
        bad: {
          type: 'noul',
          instructions: `Is this ${label.toLowerCase()} offensive or inappropriate for a family-friendly site: hateful, racist, slurs, harassment, sexual, violent, or promoting illegal drugs? Ordinary names, places (including real place names that contain words like "dead" or "devil"), travel words, identities, and mild humor are fine.`,
          criteria: { true: 'Inappropriate', false: 'Fine' },
        },
      },
    }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${JSON.stringify(data).slice(0, 200)}`);
  return Number(data.answers?.bad?.noul ?? 0);
}

// --- Photos (Cloud Vision SafeSearch) -------------------------------------------

// Checks a stored photo's thumbnail (small, so it's cheap to send).
// Returns { flagged, reasons, safe } where safe is Vision's raw likelihoods.
export async function checkImage(thumbPath) {
  if (!config.visionKey) return { flagged: false };
  try {
    const content = readFileSync(path.join(config.mediaDir, thumbPath)).toString('base64');
    const r = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${config.visionKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ image: { content }, features: [{ type: 'SAFE_SEARCH_DETECTION' }] }] }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    const res = data.responses?.[0];
    if (!r.ok || res?.error) throw new Error(res?.error?.message || `HTTP ${r.status}`);
    const safe = res.safeSearchAnnotation || {};
    const reasons = Object.entries(config.imageFlagAt)
      .filter(([k, min]) => (LIKELIHOOD[safe[k]] || 0) >= LIKELIHOOD[min])
      .map(([k]) => k);
    return { flagged: reasons.length > 0, reasons, safe };
  } catch (e) {
    console.error('[moderation] image check failed (allowing):', e.message);
    return { flagged: false, error: e.message };
  }
}

// --- Strikes ----------------------------------------------------------------------

export function recordFlag({ authorId, mapId, kind, detail }) {
  db.prepare('INSERT INTO moderation_events (author_id, map_id, kind, detail) VALUES (?, ?, ?, ?)')
    .run(authorId ?? null, mapId ?? null, kind, JSON.stringify(detail).slice(0, 2000));
}

// Blocks the account once it has more than the allowed number of flagged photos.
// Admins are never blocked. Returns true if the account is (now) blocked.
export function strikeForPhotos(authorId) {
  const a = db.prepare('SELECT id, role, blocked_at FROM authors WHERE id = ?').get(authorId);
  if (!a || a.role === 'admin') return false;
  if (a.blocked_at) return true;
  const n = db.prepare("SELECT COUNT(*) AS n FROM moderation_events WHERE author_id = ? AND kind = 'photo'").get(authorId).n;
  if (n <= config.photoStrikesAllowed) return false;
  db.prepare("UPDATE authors SET blocked_at = datetime('now'), block_reason = ? WHERE id = ?")
    .run(`${n} inappropriate photos`, authorId);
  db.prepare('DELETE FROM sessions WHERE author_id = ?').run(authorId);
  console.warn(`[moderation] blocked author ${authorId} after ${n} flagged photos`);
  return true;
}
