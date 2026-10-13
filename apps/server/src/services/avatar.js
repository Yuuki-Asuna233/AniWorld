const path = require('path');
const fs = require('fs/promises');
const { randomUUID } = require('crypto');
const sharp = require('sharp');
const avatarDir = path.resolve(__dirname, '../../../../data/uploads/avatars');

function isSafeAvatar(value) {
  if (value === '') return true;
  if (typeof value !== 'string') return false;
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return value.length <= 7 * 1024 * 1024;
  if (value.length > 2048) return false;
  if (/^\/uploads\/avatars\/avatar_[\w-]+\.(?:png|jpg|jpeg|gif|webp)$/i.test(value)) return true;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch (_) { return false; }
}

async function saveAvatar(buffer, userId) {
  const image = sharp(buffer, { limitInputPixels: 16 * 1024 * 1024, failOn: 'warning' });
  const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format)) throw new Error('Unsupported image format');
  const data = await image.resize(512, 512, { fit: 'inside', withoutEnlargement: true }).webp().toBuffer();
  const filename = `avatar_${userId}_${randomUUID()}.webp`;
  await fs.mkdir(avatarDir, { recursive: true });
  await fs.writeFile(path.join(avatarDir, filename), data, { flag: 'wx' });
  return `/uploads/avatars/${filename}`;
}

async function normalizeAvatar(value, userId) {
  if (!isSafeAvatar(value)) throw new Error('Invalid avatar');
  if (!value.startsWith('data:')) return value;
  const buffer = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
  if (buffer.length > 5 * 1024 * 1024) throw new Error('Avatar too large');
  return saveAvatar(buffer, userId);
}

module.exports = { saveAvatar, isSafeAvatar, normalizeAvatar };
