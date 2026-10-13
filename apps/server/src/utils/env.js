const fs = require('fs');
const path = require('path');

function parseEnvLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) return null;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function loadEnvFile(filePath = path.join(process.cwd(), '.env')) {
  const resolved = path.resolve(filePath);
  let loadedByNode = false;
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(resolved);
      loadedByNode = true;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[env] Failed to load .env with Node loader:', error.message);
  }

  // Fallback for Node versions without process.loadEnvFile, and for cases
  // where the built-in loader rejects a line. Existing process env wins.
  try {
    if (!fs.existsSync(resolved)) return { loaded: loadedByNode, path: resolved };
    const text = fs.readFileSync(resolved, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      if (process.env[parsed.key] === undefined) process.env[parsed.key] = parsed.value;
    }
    return { loaded: true, path: resolved };
  } catch (error) {
    console.warn('[env] Failed to load .env fallback:', error.message);
    return { loaded: loadedByNode, path: resolved, error: error.message };
  }
}

module.exports = { loadEnvFile };
