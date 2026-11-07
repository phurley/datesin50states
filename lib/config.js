import { mkdirSync } from 'node:fs';
import path from 'node:path';

const env = process.env;
const prod = env.NODE_ENV === 'production';

export const config = {
  prod,
  port: Number(env.PORT || 3050),
  host: env.HOST || '127.0.0.1',
  baseUrl: (env.SITE_URL || `http://localhost:${env.PORT || 3050}`).replace(/\/$/, ''),
  dataDir: path.resolve(env.DATA_DIR || './data'),
  // Sign in with Apple (web). Services ID is the OAuth client_id.
  appleClientId: env.APPLE_CLIENT_ID || '',
  // Emails allowed to write. Matched against the email in Apple's identity token.
  authorEmails: (env.AUTHOR_EMAILS || 'phurley@gmail.com:Patrick,sue.hurley@gmail.com:Susan')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => { const [email, name] = s.split(':'); return { email: email.toLowerCase(), name: name || email }; }),
  // Local-only shortcut login for development. Never honored in production.
  devLogin: !prod && env.DEV_LOGIN === '1',
};

config.mediaDir = path.join(config.dataDir, 'media');
config.dbPath = path.join(config.dataDir, 'dates.db');
mkdirSync(config.mediaDir, { recursive: true });
