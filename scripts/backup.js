// Writes a consistent copy of the database to $DATA_DIR/backups and prunes old ones.
import { readdirSync, unlinkSync, readFileSync } from 'node:fs';
import path from 'node:path';

// cron doesn't load the systemd EnvironmentFile; read it ourselves if present.
try {
  for (const line of readFileSync('/etc/datesin50states.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* local dev */ }

const { db } = await import('../lib/db.js');
const { config } = await import('../lib/config.js');
const dir = path.join(config.dataDir, 'backups');
const file = path.join(dir, `dates-${new Date().toISOString().slice(0, 10)}.db`);
try { unlinkSync(file); } catch { /* none yet */ }
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
const old = readdirSync(dir).filter((f) => /^dates-.*\.db$/.test(f)).sort().slice(0, -30);
for (const f of old) unlinkSync(path.join(dir, f));
console.log(`${new Date().toISOString()} backup ok -> ${file}`);
