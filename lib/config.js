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
  // Google sign-in (OAuth web client). Both are needed; the button hides until they're set.
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
  // Moderation. Jev (typesafe.ai) checks user-entered text; Cloud Vision SafeSearch checks photos.
  typesafeKey: env.TYPESAFE_API_KEY || '',
  visionKey: env.GOOGLE_VISION_API_KEY || '',
  textFlagAt: Number(env.TEXT_FLAG_AT || 0.6),          // Jev probability that text is inappropriate
  imageFlagAt: { adult: 'LIKELY', violence: 'LIKELY' }, // SafeSearch likelihood that rejects a photo
  photoStrikesAllowed: Number(env.PHOTO_STRIKES_ALLOWED || 10), // more than this blocks the account
  // Photo storage. With R2 set, processed photos are uploaded to the bucket and served from
  // MEDIA_URL (e.g. https://media.datesin50states.com); otherwise they stay in DATA_DIR/media.
  r2: {
    accountId: env.R2_ACCOUNT_ID || '',
    accessKeyId: env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: env.R2_SECRET_ACCESS_KEY || '',
    bucket: env.R2_BUCKET || '',
  },
  mediaUrl: (env.MEDIA_URL || '/media').replace(/\/$/, ''),
  // Free tier: photos per map, and max stored size per photo (re-encoded to fit).
  freePhotoLimit: Number(env.FREE_PHOTO_LIMIT || 100),
  freePhotoBytes: Number(env.FREE_PHOTO_BYTES || 1.5 * 1024 * 1024),
  // Admins (no limits, root map). Matched against the verified email from Apple or Google.
  authorEmails: (env.AUTHOR_EMAILS || 'phurley@gmail.com:Patrick,sue.hurley@gmail.com:Susan')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => { const [email, name] = s.split(':'); return { email: email.toLowerCase(), name: name || email }; }),
  // Local-only shortcut login for development. Never honored in production.
  devLogin: !prod && env.DEV_LOGIN === '1',
};

config.mediaDir = path.join(config.dataDir, 'media');
// R2 turns on only with its credentials AND a public MEDIA_URL, so photos are never uploaded
// somewhere the site can't yet serve them from.
config.r2.enabled = Boolean(config.r2.accountId && config.r2.accessKeyId && config.r2.secretAccessKey && config.r2.bucket
  && /^https?:\/\//.test(config.mediaUrl));
config.dbPath = path.join(config.dataDir, 'dates.db');
mkdirSync(config.mediaDir, { recursive: true });
