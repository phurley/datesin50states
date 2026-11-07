import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.js';
import { db } from './db.js';

const SESSION_COOKIE = 'd50_session';
const SIWA_COOKIE = 'd50_siwa';
const SESSION_DAYS = 90;
const APPLE_ISSUER = 'https://appleid.apple.com';
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, { maxAge, sameSite = 'Lax' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`];
  if (config.prod || sameSite === 'None') parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

function appendCookie(res, c) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
}

export function startSession(res, authorId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, author_id, expires_at) VALUES (?, ?, ?)').run(token, authorId, expires);
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  appendCookie(res, cookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400 }));
}

export function endSession(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  appendCookie(res, cookie(SESSION_COOKIE, '', { maxAge: 0 }));
}

// Attaches req.author (or null) to every request.
export function loadAuthor(req, _res, next) {
  req.author = null;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) {
    req.author = db.prepare(`SELECT a.id, a.name, a.email FROM sessions s JOIN authors a ON a.id = s.author_id
      WHERE s.token = ? AND s.expires_at > ?`).get(token, new Date().toISOString()) || null;
  }
  next();
}

// For mutating API routes: must be signed in, and the request must come from our own pages.
export function requireAuthor(req, res, next) {
  if (!req.author) return res.status(401).json({ error: 'Sign in first.' });
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && origin !== new URL(config.baseUrl).origin) return res.status(403).json({ error: 'Bad origin.' });
    if (req.headers['x-d50'] !== '1') return res.status(403).json({ error: 'Missing request header.' });
  }
  next();
}

// --- Sign in with Apple (web, form_post) -------------------------------------
// We verify the id_token Apple posts back against Apple's published keys, so no
// private key / client secret is needed (we never call Apple's token endpoint).

export function appleRedirect(_req, res) {
  if (!config.appleClientId) return res.status(500).send('APPLE_CLIENT_ID is not configured.');
  const state = crypto.randomBytes(16).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  appendCookie(res, cookie(SIWA_COOKIE, `${state}.${nonce}`, { maxAge: 600, sameSite: 'None' }));
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

export async function appleCallback(req) {
  const [state, nonce] = (parseCookies(req)[SIWA_COOKIE] || '').split('.');
  if (req.body?.error) return { error: `Apple said: ${req.body.error}` };
  if (!state || state !== req.body?.state) return { error: 'Sign-in expired or was started in another tab. Try again.' };
  let payload;
  try {
    ({ payload } = await jwtVerify(req.body.id_token || '', appleJwks, {
      issuer: APPLE_ISSUER,
      audience: config.appleClientId,
    }));
  } catch (e) {
    return { error: `Could not verify Apple sign-in (${e.code || e.message}).` };
  }
  if (payload.nonce !== nonce) return { error: 'Sign-in nonce mismatch. Try again.' };

  const sub = payload.sub;
  const email = String(payload.email || '').toLowerCase();
  const emailOk = payload.email_verified === true || payload.email_verified === 'true';

  let author = db.prepare('SELECT id, name FROM authors WHERE apple_sub = ?').get(sub);
  if (!author && email && emailOk) {
    author = db.prepare('SELECT id, name FROM authors WHERE email = ?').get(email);
    if (author) db.prepare('UPDATE authors SET apple_sub = ? WHERE id = ? AND apple_sub IS NULL').run(sub, author.id);
  }
  if (!author) {
    console.warn(`[auth] rejected Apple sign-in sub=${sub} email=${email || '(none)'}`);
    return { error: 'not-on-list', sub, email };
  }
  return { author };
}

export function clearSiwa(res) {
  appendCookie(res, cookie(SIWA_COOKIE, '', { maxAge: 0, sameSite: 'None' }));
}
