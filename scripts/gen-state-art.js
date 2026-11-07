// Generates a vintage travel-poster illustration per state with Gemini, used to fill
// visited states on the map when no photo has been chosen.
//   GEMINI_API_KEY=... node scripts/gen-state-art.js            # only missing states
//   GEMINI_API_KEY=... node scripts/gen-state-art.js MI TX       # (re)generate these
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import sharp from 'sharp';

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('Set GEMINI_API_KEY'); process.exit(1); }
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
const OUT = new URL('../public/img/states/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const attractions = JSON.parse(readFileSync(new URL('../lib/state-attractions.json', import.meta.url), 'utf8'));
const states = JSON.parse(readFileSync(new URL('../lib/usa-states.json', import.meta.url), 'utf8'));
const byCode = Object.fromEntries(states.map((s) => [s.code, s]));

const RATIOS = { '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '3:2': 1.5, '2:3': 2 / 3, '16:9': 16 / 9, '9:16': 9 / 16 };
function ratioFor(code) {
  const [x0, y0, x1, y1] = byCode[code].b;
  const r = (x1 - x0) / (y1 - y0);
  return Object.entries(RATIOS).sort((a, b) => Math.abs(Math.log(a[1] / r)) - Math.abs(Math.log(b[1] / r)))[0][0];
}

const prompt = (code) => `A vintage 1930s WPA national park travel poster illustration of ${attractions[code]}, in ${byCode[code].name}.
Flat screen-print style with bold simple shapes, subtle paper grain, and a warm limited palette of burnt orange, rust, mustard yellow, teal, deep blue and cream.
Full-bleed scene filling the entire frame edge to edge with the main subject centered. No text, no lettering, no title, no border, no frame, no signature, no people in the foreground.`;

async function generate(code) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt(code) }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: ratioFor(code) } },
      }),
    });
    const json = await res.json().catch(() => ({}));
    const img = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (res.ok && img) {
      // The model tends to add a thin paper border; crop 5% off every edge so it never shows inside a state.
      const buf = Buffer.from(img.data, 'base64');
      const { width: w, height: h } = await sharp(buf).metadata();
      const dx = Math.round(w * 0.05), dy = Math.round(h * 0.05);
      await sharp(buf)
        .extract({ left: dx, top: dy, width: w - 2 * dx, height: h - 2 * dy })
        .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 74 })
        .toFile(new URL(`${code}.webp`, OUT).pathname);
      return;
    }
    const why = json.error?.message || json.candidates?.[0]?.finishReason || `HTTP ${res.status}`;
    console.warn(`  ${code} attempt ${attempt}: ${why}`);
    await new Promise((r) => setTimeout(r, 4000 * attempt));
  }
  throw new Error(`${code}: gave up`);
}

const wanted = process.argv.slice(2).map((s) => s.toUpperCase());
const todo = (wanted.length ? wanted : Object.keys(attractions)).filter((c) => wanted.length || !existsSync(new URL(`${c}.webp`, OUT)));
console.log(`generating ${todo.length} with ${MODEL}`);
const queue = [...todo];
const failed = [];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let code; (code = queue.shift());) {
    try { await generate(code); console.log(`ok ${code} (${ratioFor(code)})`); }
    catch (e) { failed.push(code); console.error(e.message); }
  }
}));
if (failed.length) { console.error(`failed: ${failed.join(' ')}`); process.exit(1); }
