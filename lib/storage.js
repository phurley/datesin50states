// Object storage for photos: Cloudflare R2 (S3-compatible) when configured, else the local media dir.
// Keys are the same relative paths either way (e.g. "ab/<uuid>.jpg"), so database rows never change.
import { readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { AwsClient } from 'aws4fetch';
import { config } from './config.js';

const { r2 } = config;
const client = r2.enabled
  ? new AwsClient({ accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey, service: 's3', region: 'auto' })
  : null;
const objectUrl = (key) => `https://${r2.accountId}.r2.cloudflarestorage.com/${r2.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png' };

// Public URL for a stored key.
export const mediaUrl = (key) => `${config.mediaUrl}/${key}`;

async function call(method, key, init = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await client.fetch(objectUrl(key), { method, signal: AbortSignal.timeout(30000), ...init });
    if (res.ok || res.status === 404 || attempt >= 2 || res.status < 500) return res;
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
}

// Copy a local file (under the media dir) to R2. Cache forever: keys are random and never reused.
export async function putObject(key) {
  const body = readFileSync(path.join(config.mediaDir, key));
  const res = await call('PUT', key, {
    body,
    headers: {
      'Content-Type': TYPES[key.split('.').pop().toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
  if (!res.ok) throw new Error(`R2 PUT ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export async function headObject(key) {
  const res = await call('HEAD', key);
  return res.ok ? Number(res.headers.get('content-length')) : null;
}

export async function deleteObject(key) {
  const res = await call('DELETE', key);
  if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key}: HTTP ${res.status}`);
}

// After a photo passes moderation: move its files to R2 (no-op when R2 isn't configured).
export async function commitImage(img) {
  if (!client) return;
  for (const key of [img.file, img.thumb]) await putObject(key);
  for (const key of [img.file, img.thumb]) {
    try { unlinkSync(path.join(config.mediaDir, key)); } catch { /* already gone */ }
  }
}

// Remove a photo's files wherever they are.
export function removeStored(photo) {
  for (const key of [photo.file, photo.thumb]) {
    try { unlinkSync(path.join(config.mediaDir, key)); } catch { /* not local */ }
    if (client) deleteObject(key).catch((e) => console.error('[r2]', e.message));
  }
}

export const r2Enabled = () => Boolean(client);
