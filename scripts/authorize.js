// Bind an Apple user id (sub) to an author, for Apple IDs that hide their email.
// Usage: npm run authorize -- <apple-sub> <Patrick|Susan>
//        npm run authorize -- --list
import { db } from '../lib/db.js';

const [sub, name] = process.argv.slice(2);
if (!sub || sub === '--list') {
  console.table(db.prepare('SELECT a.id, a.name, a.email, a.role, m.slug AS map, a.apple_sub, a.google_sub FROM authors a LEFT JOIN maps m ON m.id = a.map_id').all());
  process.exit(0);
}
const author = db.prepare('SELECT id FROM authors WHERE name = ?').get(name);
if (!author) { console.error(`No author named "${name}". Use --list to see authors.`); process.exit(1); }
db.prepare('UPDATE authors SET apple_sub = NULL WHERE apple_sub = ?').run(sub);
db.prepare('UPDATE authors SET apple_sub = ? WHERE id = ?').run(sub, author.id);
console.log(`Apple sub ${sub} now signs in as ${name}.`);
