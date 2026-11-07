// Generates lib/usa-states.json from us-atlas (pre-projected Albers USA, 975x610).
// Run once with `npm run build:map`; the output is committed so production needs no dev deps.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const topo = JSON.parse(readFileSync(require.resolve('us-atlas/states-albers-10m.json'), 'utf8'));
const fc = feature(topo, topo.objects.states);

const FIPS = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','12':'FL','13':'GA',
  '15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD',
  '25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH','34':'NJ',
  '35':'NM','36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI','45':'SC',
  '46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI','56':'WY',
};

const r = (n) => Math.round(n * 10) / 10;
function ringPath(ring) {
  return 'M' + ring.map(([x, y]) => `${r(x)},${r(y)}`).join('L') + 'Z';
}
function centroid(rings) {
  // area-weighted centroid of the largest ring (good enough for label placement)
  let best = null, bestA = 0;
  for (const ring of rings) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, n = ring.length; i < n - 1; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
      const f = x0 * y1 - x1 * y0;
      a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
    }
    if (Math.abs(a) > bestA) { bestA = Math.abs(a); best = [r(cx / (3 * a)), r(cy / (3 * a))]; }
  }
  return best;
}

const states = [];
for (const f of fc.features) {
  const code = FIPS[f.id];
  if (!code) continue; // skip DC & territories
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const outer = polys.map((p) => p[0]);
  const pts = polys.flat(2);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(r);
  states.push({ code, name: f.properties.name, d: polys.flat().map(ringPath).join(''), c: centroid(outer), b });
}
states.sort((a, b) => a.name.localeCompare(b.name));
if (states.length !== 50) throw new Error(`expected 50 states, got ${states.length}`);
writeFileSync(new URL('../lib/usa-states.json', import.meta.url), JSON.stringify(states));
console.log(`wrote ${states.length} states`);
