import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.js';
import { db } from './db.js';

const SESSION_COOKIE = 'd50_session';
const SIWA_COOKIE = 'd50_siwa';
const GOOGLE_COOKIE = 'd50_goog';
export const INVITE_COOKIE = 'd50_invite';
export const PENDING_COOKIE = 'd50_pending';
const SESSION_DAYS = 90;
const APPLE_ISSUER = 'https://appleid.apple.com';
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, sameSite = 'Lax' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`];
  if (config.prod || sameSite === 'None') parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

export function appendCookie(res, c) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
}

export function startSession(res, authorId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, author_id, expires_at) VALUES (?, ?, ?)').run(token, authorId, expires);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  appendCookie(res, cookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400 }));
}

export function endSession(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  appendCookie(res, cookie(SESSION_COOKIE, '', { maxAge: 0 }));
}

// Attaches req.author (or null) to every request: the signed-in person and their map.
export function loadAuthor(req, _res, next) {
  req.author = null;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) {
    req.author = db.prepare(`SELECT a.id, a.name, a.email, a.role, a.map_id, a.apple_sub, a.google_sub, m.slug AS map_slug, m.is_root AS map_is_root,
        (SELECT COUNT(*) FROM collection_members cm WHERE cm.map_id = a.map_id AND cm.status = 'pending') AS pending_invites
      FROM sessions s JOIN authors a ON a.id = s.author_id LEFT JOIN maps m ON m.id = a.map_id
      WHERE s.token = ? AND s.expires_at > ? AND a.blocked_at IS NULL`).get(token, new Date().toISOString()) || null;
    if (req.author) req.author = { ...req.author, admin: req.author.role === 'admin' };
  }
  next();
}

// Writes must come from our own pages (Origin + custom header), from someone signed in.
export function sameOrigin(req) {
  const origin = req.headers.origin;
  return !origin || origin === new URL(config.baseUrl).origin;
}

export function requireAuthor(req, res, next) {
  if (!req.author) return res.status(401).json({ error: 'Sign in first.' });
  if (!req.author.map_id) return res.status(403).json({ error: 'Your account isn’t attached to a map.' });
  if (req.method !== 'GET') {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Bad origin.' });
    if (req.headers['x-d50'] !== '1') return res.status(403).json({ error: 'Missing request header.' });
  }
  next();
}

// Form posts (profile, join, admin): signed in where needed, and same origin.
export function formGuard(req, res, next) {
  if (!sameOrigin(req)) return res.status(403).send('Bad origin.');
  next();
}

// "link" = connect this provider to the signed-in account (from the profile page).
const intentOf = (req) => (req.query.intent === 'link' ? 'link' : 'signin');

// --- Sign in with Apple (web, form_post) -------------------------------------
// We verify the id_token Apple posts back against Apple's published keys, so no
// private key / client secret is needed (we never call Apple's token endpoint).

export function appleRedirect(req, res) {
  if (!config.appleClientId) return res.status(500).send('APPLE_CLIENT_ID is not configured.');
  const state = crypto.randomBytes(16).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  appendCookie(res, cookie(SIWA_COOKIE, `${state}.${nonce}.${intentOf(req)}`, { maxAge: 600, sameSite: 'None' }));
  const u = new URL('https://appleid.apple.com/auth/authorize');
  u.search = new URLSearchParams({
    client_id: config.appleClientId,
    redirect_uri: `${config.baseUrl}/auth/apple/callback`,
    response_type: 'code id_token',
    response_mode: 'form_post',
    scope: 'name email',
    state,
    nonce,
  });
  res.redirect(u.toString());
}

// Returns { identity, intent } or { error }.
export async function appleCallback(req, res) {
  const [state, nonce, intent] = (parseCookies(req)[SIWA_COOKIE] || '').split('.');
  appendCookie(res, cookie(SIWA_COOKIE, '', { maxAge: 0, sameSite: 'None' }));
  if (req.body?.error) return { error: `Apple said: ${req.body.error}` };
  if (!state || state !== req.body?.state) return { error: 'Sign-in expired or was started in another tab. Try again.' };
  let payload;
  try {
    ({ payload } = await jwtVerify(req.body.id_token || '', appleJwks, { issuer: APPLE_ISSUER, audience: config.appleClientId }));
  } catch (e) {
    return { error: `Could not verify Apple sign-in (${e.code || e.message}).` };
  }
  if (payload.nonce !== nonce) return { error: 'Sign-in nonce mismatch. Try again.' };
  // Apple sends the person's name only on the very first authorization, as a form field.
  let name = '';
  try {
    const u = JSON.parse(req.body.user || '{}');
    name = [u.name?.firstName, u.name?.lastName].filter(Boolean).join(' ');
  } catch { /* no name */ }
  return {
    intent,
    identity: {
      provider: 'apple',
      sub: payload.sub,
      email: String(payload.email || '').toLowerCase() || null,
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
      name,
    },
  };
}

// --- Google (OpenID Connect, authorization code + PKCE) ---------------------

export const googleReady = () => Boolean(config.googleClientId && config.googleClientSecret);

export function googleRedirect(req, res) {
  if (!googleReady()) return res.status(500).send('Google sign-in is not configured.');
  const state = crypto.randomBytes(16).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  appendCookie(res, cookie(GOOGLE_COOKIE, `${state}.${nonce}.${verifier}.${intentOf(req)}`, { maxAge: 600 }));
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: `${config.baseUrl}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  res.redirect(u.toString());
}

export async function googleCallback(req, res) {
  const [state, nonce, verifier, intent] = (parseCookies(req)[GOOGLE_COOKIE] || '').split('.');
  appendCookie(res, cookie(GOOGLE_COOKIE, '', { maxAge: 0 }));
  if (req.query.error) return { error: `Google said: ${req.query.error}` };
  if (!state || state !== req.query.state) return { error: 'Sign-in expired or was started in another tab. Try again.' };
  let tokens;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code || ''),
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: `${config.baseUrl}/auth/google/callback`,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(15000),
    });
    tokens = await r.json();
    if (!r.ok) return { error: `Google sign-in failed (${tokens.error || r.status}).` };
  } catch (e) {
    return { error: `Couldn’t reach Google (${e.message}).` };
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(tokens.id_token || '', googleJwks, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: config.googleClientId,
    }));
  } catch (e) {
    return { error: `Could not verify Google sign-in (${e.code || e.message}).` };
  }
  if (payload.nonce !== nonce) return { error: 'Sign-in nonce mismatch. Try again.' };
  return {
    intent,
    identity: {
      provider: 'google',
      sub: payload.sub,
      email: String(payload.email || '').toLowerCase() || null,
      emailVerified: payload.email_verified === true,
      name: payload.name || '',
    },
  };
}
