// Copy every photo in the database from the local media dir to R2, verifying each upload.
// Safe to re-run: objects already in R2 with the same size are skipped.
//
//   node scripts/migrate-media-to-r2.js                 # upload + verify
//   node scripts/migrate-media-to-r2.js --delete-local  # ...then delete local copies that verified
import { existsSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { config } from '../lib/config.js';
import { db } from '../lib/db.js';
import { putObject, headObject, r2Enabled } from '../lib/storage.js';

if (!r2Enabled()) {
  console.error('R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).');
  process.exit(1);
}
const deleteLocal = process.argv.includes('--delete-local');
const keys = db.prepare('SELECT file, thumb FROM photos').all().flatMap((p) => [p.file, p.thumb]);
let uploaded = 0, skipped = 0, verified = 0, missing = 0, failed = 0, deleted = 0;

for (const key of keys) {
  const local = path.join(config.mediaDir, key);
  const size = existsSync(local) ? statSync(local).size : null;
  try {
    const remote = await headObject(key);
    if (size === null) {
      if (remote === null) { missing++; console.warn(`missing everywhere: ${key}`); } else verified++;
      continue;
    }
    if (remote === size) skipped++;
    else { await putObject(key); uploaded++; }
    if ((await headObject(key)) !== size) throw new Error('size mismatch after upload');
    verified++;
    if (deleteLocal) { unlinkSync(local); deleted++; }
  } catch (e) {
    failed++;
    console.error(`${key}: ${e.message}`);
  }
}
console.log(JSON.stringify({ objects: keys.length, uploaded, alreadyThere: skipped, verified, missing, failed, deletedLocal: deleted }));
process.exit(failed ? 1 : 0);
