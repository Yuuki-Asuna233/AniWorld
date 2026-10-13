const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');

const ROOT = path.resolve(__dirname, '../../../../data/runtime/agent-artifacts');
const MAX_BYTES = 256 * 1024;
const cleanupCursors = new Map();
function artifactPath(userId, id) {
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0 || !/^[a-f0-9]{64}$/.test(id)) throw new Error('ARTIFACT_REFERENCE_INVALID');
  return path.join(ROOT, String(Number(userId)), id + '.json');
}
function sanitizedJson(payload) {
  return JSON.stringify(payload, (key, value) => /^(?:api[_-]?key|authorization|headers|cookie|password|secret|client[_-]?secret|(?:access[_-]?|refresh[_-]?)?token|reasoning_content)$/i.test(key) ? '[redacted]' : value);
}
function writeArtifact(userId, payload) {
  const text = sanitizedJson(payload), bytes = Buffer.byteLength(text);
  if (bytes > MAX_BYTES) return { omitted: 'size_limit' };
  const id = createHash('sha256').update(text).digest('hex'), file = artifactPath(userId, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  return { id, bytes };
}
function readArtifact(userId, id, offset = 0) {
  const text = fs.readFileSync(artifactPath(userId, id), 'utf8'), chars = [...text];
  const end = Math.min(chars.length, offset + 2400);
  return { artifactId: id, content: chars.slice(offset, end).join(''), offset, nextOffset: end < chars.length ? end : null, totalChars: chars.length };
}
function removeArtifact(userId, id) {
  const file = artifactPath(userId, id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function pruneOrphans(userId, isReferenced) {
  const directory = path.dirname(artifactPath(userId, '0'.repeat(64)));
  const previous = cleanupCursors.get(userId) || { offset: 0, at: 0 };
  if (Date.now() - previous.at < 3600000 || !fs.existsSync(directory)) return;
  const files = fs.readdirSync(directory);
  const offset = previous.offset < files.length ? previous.offset : 0;
  for (const name of files.slice(offset, offset + 256)) {
    const match = name.match(/^([a-f0-9]{64})\.json(?:\.[a-f0-9-]{36}\.tmp)?$/);
    if (!match) continue;
    const file = path.join(directory, name);
    if (fs.lstatSync(file).isFile() && fs.statSync(file).mtimeMs < Date.now() - 86400000
      && (name.endsWith('.tmp') || !isReferenced(match[1]))) fs.unlinkSync(file);
  }
  cleanupCursors.set(userId, { offset: offset + 256, at: Date.now() });
  if (cleanupCursors.size > 1000) cleanupCursors.delete(cleanupCursors.keys().next().value);
}

module.exports = { writeArtifact, readArtifact, removeArtifact, sanitizedJson, pruneOrphans };
