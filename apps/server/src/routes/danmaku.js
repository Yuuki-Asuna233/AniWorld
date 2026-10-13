const crypto = require('crypto');

const DANDAN_API_BASE = 'https://api.dandanplay.net';
const COMMENT_TIMEOUT_MS = 30_000;
const METADATA_TIMEOUT_MS = 15_000;
const COMMENT_CACHE_TTL_MS = 15 * 60 * 1000;
const METADATA_CACHE_TTL_MS = 60 * 60 * 1000;
const STALE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_BYTES = 48 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 80;
const ALLOWED_PATHS = [
  '/api/v2/search/anime',
  '/api/v2/bangumi/',
  '/api/v2/comment/'
];
const responseCache = new Map();
const pendingRequests = new Map();
let responseCacheBytes = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isCommentPath(pathname) {
  return pathname.startsWith('/api/v2/comment/');
}

function getCacheEntry(key, { allowStale = false } = {}) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  const age = Date.now() - entry.createdAt;
  if (age > STALE_CACHE_TTL_MS) {
    responseCache.delete(key);
    responseCacheBytes -= entry.bytes;
    return null;
  }
  if (!allowStale && age > entry.ttl) return null;
  // Refresh insertion order so frequently used episodes survive eviction.
  responseCache.delete(key);
  responseCache.set(key, entry);
  return entry.response;
}

function setCacheEntry(key, response, ttl) {
  let serialized;
  try {
    serialized = JSON.stringify(response.data);
  } catch (_) {
    return;
  }
  const bytes = Buffer.byteLength(serialized);
  if (bytes > MAX_CACHE_BYTES / 2) return;

  const previous = responseCache.get(key);
  if (previous) responseCacheBytes -= previous.bytes;
  responseCache.delete(key);
  responseCache.set(key, {
    response,
    bytes,
    ttl,
    createdAt: Date.now()
  });
  responseCacheBytes += bytes;

  while (
    responseCache.size > MAX_CACHE_ENTRIES
    || responseCacheBytes > MAX_CACHE_BYTES
  ) {
    const oldestKey = responseCache.keys().next().value;
    const oldest = responseCache.get(oldestKey);
    responseCache.delete(oldestKey);
    responseCacheBytes -= oldest?.bytes || 0;
  }
}

function isSuccessfulResponse(response, pathname) {
  if (!response || response.status < 200 || response.status >= 300) return false;
  if (!response.data || typeof response.data !== 'object') return false;
  if (response.data.success === false) return false;
  if (isCommentPath(pathname)) return Array.isArray(response.data.comments);
  return true;
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function fetchDanmakuResponse({ target, pathname, headers, httpFetch }) {
  const key = target.toString();
  const cached = getCacheEntry(key);
  if (cached) return { ...cached, cacheStatus: 'hit' };
  if (pendingRequests.has(key)) return pendingRequests.get(key);

  const task = (async () => {
    const commentRequest = isCommentPath(pathname);
    const timeout = commentRequest ? COMMENT_TIMEOUT_MS : METADATA_TIMEOUT_MS;
    const maxAttempts = 2;
    let lastResponse;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        lastResponse = await httpFetch(target.toString(), {
          timeout,
          followRedirect: true,
          headers
        });
        if (!isRetryableStatus(lastResponse.status) || attempt === maxAttempts) {
          break;
        }
      } catch (error) {
        lastError = error;
        // A full comment timeout already consumed the user-facing deadline.
        if (attempt === maxAttempts || (commentRequest && error.message === 'timeout')) {
          break;
        }
      }
      await sleep(250 * attempt);
    }

    if (isSuccessfulResponse(lastResponse, pathname)) {
      setCacheEntry(
        key,
        lastResponse,
        commentRequest ? COMMENT_CACHE_TTL_MS : METADATA_CACHE_TTL_MS
      );
      return { ...lastResponse, cacheStatus: 'miss' };
    }

    const stale = getCacheEntry(key, { allowStale: true });
    if (stale) return { ...stale, cacheStatus: 'stale' };
    if (lastResponse) return { ...lastResponse, cacheStatus: 'upstream' };
    throw lastError || new Error('DanDanPlay request failed');
  })().finally(() => pendingRequests.delete(key));

  pendingRequests.set(key, task);
  return task;
}

function isAllowedPath(pathname) {
  return ALLOWED_PATHS.some(prefix =>
    pathname === prefix || pathname.startsWith(prefix)
  );
}

function createSignature(appId, apiKey, pathname, timestamp) {
  const value = `${appId}${timestamp}${pathname}${apiKey}`;
  return crypto.createHash('sha256').update(value).digest('base64');
}

function mountDanmakuRoutes(app, { httpFetch }) {
  app.get('/api/danmaku/status', (req, res) => {
    const configured = Boolean(
      String(process.env.DANDANAPI_APPID || '').trim()
      && String(process.env.DANDANAPI_KEY || '').trim()
    );
    res.json({ configured });
  });

  app.get('/api/danmaku/proxy', async (req, res) => {
    const appId = String(process.env.DANDANAPI_APPID || '').trim();
    const apiKey = String(process.env.DANDANAPI_KEY || '').trim();
    if (!appId || !apiKey) {
      return res.status(503).json({
        error: 'DANDAN_NOT_CONFIGURED',
        message: '弹幕服务尚未配置 DANDANAPI_APPID / DANDANAPI_KEY'
      });
    }

    const pathname = String(req.query.path || '').trim();
    if (!pathname.startsWith('/') || !isAllowedPath(pathname)) {
      return res.status(400).json({ error: 'Invalid danmaku API path' });
    }

    const target = new URL(pathname, DANDAN_API_BASE);
    for (const [key, rawValue] of Object.entries(req.query)) {
      if (key === 'path') continue;
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const value of values) {
        if (value !== undefined && value !== null) {
          target.searchParams.append(key, String(value));
        }
      }
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const headers = {
      'User-Agent': 'AniWorld/2.1.9',
      'Referer': '',
      'Accept-Encoding': 'gzip, deflate, br',
      'X-Auth': '1',
      'X-AppId': appId,
      'X-Timestamp': String(timestamp),
      'X-Signature': createSignature(appId, apiKey, pathname, timestamp)
    };
    try {
      const response = await fetchDanmakuResponse({
        target,
        pathname,
        headers,
        httpFetch
      });
      res.setHeader('X-AniWorld-Danmaku-Cache', response.cacheStatus);
      return res.status(response.status || 502).json(response.data);
    } catch (error) {
      return res.status(502).json({
        error: 'DANDAN_REQUEST_FAILED',
        message: error.message
      });
    }
  });
}

module.exports = {
  mountDanmakuRoutes,
  createSignature,
  isAllowedPath,
  fetchDanmakuResponse
};
