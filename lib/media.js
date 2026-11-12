import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import exifr from 'exifr';
import { config } from './config.js';
import { removeStored } from './storage.js';

// Small box (1 GB RAM): process one image at a time and don't keep a pixel cache.
sharp.concurrency(1);
sharp.cache(false);

const LARGE = 2000;
const THUMB = 640;

// Resize an image buffer into a large JPEG and a WebP thumbnail.
// maxBytes (free tier) steps quality, then size, down until the JPEG fits.
// Returns paths relative to the media dir.
export async function storeImage(buffer, { maxBytes = Infinity } = {}) {
  const id = crypto.randomUUID();
  const dir = id.slice(0, 2);
  mkdirSync(path.join(config.mediaDir, dir), { recursive: true });
  const file = `${dir}/${id}.jpg`;
  const thumb = `${dir}/${id}_t.webp`;

  const base = sharp(buffer, { failOn: 'none', limitInputPixels: 120e6 }).rotate();
  let out;
  for (const [size, quality] of [[LARGE, 82], [LARGE, 72], [LARGE, 62], [1600, 66], [1280, 64], [1024, 60]]) {
    out = await base.clone()
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (out.data.length <= maxBytes) break;
  }
  writeFileSync(path.join(config.mediaDir, file), out.data);
  const { info } = out;
  await base.clone()
    .resize({ width: THUMB, height: THUMB, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 74 })
    .toFile(path.join(config.mediaDir, thumb));

  let takenAt = null, gps = null;
  try {
    const meta = await sharp(buffer).metadata();
    takenAt = exifDate(meta.exif);
  } catch { /* no exif */ }
  try {
    const g = await exifr.gps(buffer);
    gps = validGps(g?.latitude, g?.longitude);
  } catch { /* no gps */ }
  return { file, thumb, width: info.width, height: info.height, takenAt, gps };
}

// Deletes a photo's files locally and in R2.
export function removeImage(photo) {
  removeStored(photo);
}

// Pull DateTimeOriginal ("YYYY:MM:DD HH:MM:SS") out of a raw EXIF buffer without a full parser.
function exifDate(exif) {
  if (!exif) return null;
  const m = exif.toString('latin1').match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
}

// { lat, lng } if both are real coordinates (0,0 is what some apps write for "unknown"), else null.
export function validGps(lat, lng) {
  lat = Number(lat); lng = Number(lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}
