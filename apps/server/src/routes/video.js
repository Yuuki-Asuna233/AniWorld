/**
 * Video proxy route - Node streaming proxy with Range support.
 */
const { openPublicStream } = require('../services/public-http');
const CHROME_UA = 'Mozilla/5.0 Chrome/125.0.0.0 Safari/537.36';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Content-Range, Accept-Ranges',
    'Access-Control-Max-Age': '86400'
  };
}

function copyResponseHeaders(upstreamHeaders, { rewritten = false } = {}) {
  const allowed = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified'
  ];
  const out = {
    ...corsHeaders(),
    'Cache-Control': 'public, max-age=3600'
  };
  for (const key of allowed) {
    if (upstreamHeaders[key]) out[key] = upstreamHeaders[key];
  }
  if (rewritten) {
    delete out['content-length'];
    delete out['content-range'];
    out['content-type'] = 'application/vnd.apple.mpegurl; charset=utf-8';
    out['accept-ranges'] = 'none';
    out['Cache-Control'] = 'no-cache';
  }
  if (!out['content-type']) out['content-type'] = 'video/mp4';
  if (!out['accept-ranges']) out['accept-ranges'] = 'bytes';
  return out;
}

function proxyPublicUrl(req, upstreamUrl) {
  const proto = req.protocol || 'http';
  const params = new URLSearchParams({ url: upstreamUrl });
  if (req.query.referer) params.set('referer', String(req.query.referer));
  if (req.query.userAgent) params.set('userAgent', String(req.query.userAgent));
  // DLNA renderers cannot send custom access headers. Keep the already
  // validated short-lived token on rewritten HLS playlists and segments.
  if (req.query.access_token) {
    params.set('access_token', String(req.query.access_token));
  }
  return `${proto}://${req.get('host')}/api/video?${params.toString()}`;
}

function rewriteHlsManifest(text, upstreamUrl, req) {
  const toProxyUrl = value => {
    const uri = String(value || '').trim();
    if (!uri || uri.startsWith('data:')) return uri;
    try {
      return proxyPublicUrl(req, new URL(uri, upstreamUrl).toString());
    } catch (_) {
      return uri;
    }
  };

  let rewritten = String(text || '')
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${toProxyUrl(uri)}"`);
      }
      return toProxyUrl(trimmed);
    })
    .join('\n');

  // 显式声明 VOD：上游（OI fMP4-in-PNG + BYTERANGE 的非标准 HLS）未带
  // PLAYLIST-TYPE 时，ffmpeg 可能按 LIVE 处理；Android libmpv 在 VO 切换
  // 触发 refresh seek 时会把位置错误定位到第 2 个片段（约 20s，跳过开头）。
  // 补上 PLAYLIST-TYPE:VOD 让 ffmpeg 明确按 VOD 处理 seek（实测可根治）。
  if (/ENDLIST/.test(String(text || '')) &&
      !rewritten.includes('#EXT-X-PLAYLIST-TYPE:VOD')) {
    rewritten = rewritten.replace(
      '#EXT-X-VERSION:7',
      '#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:VOD'
    );
  }
  return rewritten;
}

function isHlsManifest(videoUrl, headers) {
  const contentType = String(headers['content-type'] || '').toLowerCase();
  return /\.m3u8(?:$|[?#])/i.test(videoUrl)
    || contentType.includes('mpegurl')
    || contentType.includes('vnd.apple.mpegurl');
}

function proxyController(res) {
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  return controller;
}

function failResponse(res, error) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) return res.destroy();
  res.status(502).json({ error: '媒体请求失败: ' + error.message });
}

async function readBounded(stream, limit, { truncate = false } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const remaining = limit - size;
    chunks.push(chunk.subarray(0, remaining));
    size += chunk.length;
    if (size >= limit && truncate) break;
    if (size > limit) throw new Error('Media manifest too large');
  }
  return Buffer.concat(chunks);
}

function mountVideoRoutes(app) {
  app.options('/api/video', (_req, res) => res.set(corsHeaders()).status(204).end());

  app.get('/api/video', async (req, res) => {
    if (typeof req.query.url !== 'string') return res.status(400).send('Missing url');
    const controller = proxyController(res);
    try {
      const headers = {
        'User-Agent': String(req.query.userAgent || CHROME_UA),
        Accept: '*/*',
        Referer: String(req.query.referer || req.headers.referer || new URL(req.query.url).origin)
      };
      if (req.headers.range) headers.Range = req.headers.range;
      const { response, url } = await openPublicStream(req.query.url, {
        headers, signal: controller.signal, method: req.method
      });
      if (res.destroyed) { response.destroy(); return; }
      if (req.method === 'HEAD') {
        res.writeHead(response.statusCode, copyResponseHeaders(response.headers, {
          rewritten: isHlsManifest(url.toString(), response.headers)
        }));
        response.destroy();
        res.end();
        return;
      }
      response.on('error', error => failResponse(res, error));
      response.on('aborted', () => failResponse(res, new Error('Upstream stream aborted')));
      if (isHlsManifest(url.toString(), response.headers)) {
        const data = await readBounded(response, 8 * 1024 * 1024);
        if (res.destroyed) return;
        const body = Buffer.from(rewriteHlsManifest(data.toString('utf8'), url.toString(), req));
        res.writeHead(response.statusCode, { ...copyResponseHeaders(response.headers, { rewritten: true }), 'content-length': body.length });
        res.end(body);
      } else {
        res.writeHead(response.statusCode, copyResponseHeaders(response.headers));
        response.pipe(res);
      }
    } catch (error) { failResponse(res, error); }
  });

  app.get('/api/video-info', async (req, res) => {
    if (typeof req.query.url !== 'string') return res.status(400).json({ error: 'Missing url' });
    const controller = proxyController(res);
    try {
      const { response } = await openPublicStream(req.query.url, {
        signal: controller.signal, timeout: 10000,
        headers: { 'User-Agent': CHROME_UA, Range: 'bytes=0-65535' }
      });
      const data = await readBounded(response, 65536, { truncate: true });
      if (res.destroyed || res.writableEnded) return;
      const header = data.toString('hex', 0, Math.min(data.length, 100));
      const info = {
        contentType: response.headers['content-type'] || 'unknown',
        contentLength: parseInt(response.headers['content-length'], 10) || 0,
        status: response.statusCode,
        codec: header.includes('68766331') || header.includes('68657631') ? 'HEVC/H265'
          : header.includes('61766331') ? 'H264/AVC' : 'unknown'
      };
      if (header.includes('66747970')) info.container = 'mp4';
      res.json(info);
    } catch (error) { failResponse(res, error); }
  });
}

module.exports = {
  mountVideoRoutes,
  rewriteHlsManifest,
  isHlsManifest
};
