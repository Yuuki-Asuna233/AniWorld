// Bounded JSON/text requests. Every redirect shares a deadline and settles
// through one Promise; event callbacks never throw outside it.
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, timeout: 60000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, timeout: 60000 });

function httpFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false, activeRequest, activeStream;
    const timeout = Math.max(1, Number(opts.timeout) || 15000);
    const maxBytes = Math.max(1, Number(opts.maxResponseBytes) || 16 * 1024 * 1024);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      if (error) { activeStream?.destroy(); activeRequest?.destroy(); reject(error); }
      else resolve(result);
    };
    const abort = () => finish(opts.signal.reason instanceof Error ? opts.signal.reason : new Error('REQUEST_ABORTED'));
    const timer = setTimeout(() => finish(new Error('timeout')), timeout);
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) return abort();
    const request = (target, depth, options) => {
      if (settled) return;
      try {
        const parsed = new URL(target);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported HTTP protocol');
        const secure = parsed.protocol === 'https:';
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Accept: 'application/json', ...options.headers };
        const method = String(options.method || 'GET').toUpperCase();
        const outgoing = (secure ? https : http).request(parsed, {
          method, headers, agent: secure ? httpsAgent : httpAgent,
        }, response => {
          if (settled) { response.destroy(); return; }
          const onResponseError = error => finish(error);
          const onResponseAborted = () => finish(new Error('HTTP_RESPONSE_ABORTED'));
          response.on('error', onResponseError);
          response.on('aborted', onResponseAborted);
          try {
            if (options.followRedirect && [301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
              if (depth >= 5) throw new Error('Too many redirects');
              const next = new URL(response.headers.location, parsed);
              if (!['http:', 'https:'].includes(next.protocol)) throw new Error('Unsupported redirect protocol');
              const nextOptions = { ...options, headers: { ...options.headers } };
              if (next.origin !== parsed.origin) {
                for (const key of Object.keys(nextOptions.headers)) {
                  if (/^(authorization|cookie|x-signature|x-timestamp|x-appid)$/i.test(key)) delete nextOptions.headers[key];
                }
              }
              if (response.statusCode === 303) {
                nextOptions.method = 'GET'; delete nextOptions.body;
                for (const key of Object.keys(nextOptions.headers)) {
                  if (/^content-(length|type)$/i.test(key)) delete nextOptions.headers[key];
                }
              }
              if (next.hostname === 'api.dandanplay.net' && parsed.hostname === next.hostname) {
                const appId = headers['X-AppId'], apiKey = String(process.env.DANDANAPI_KEY || '').trim();
                if (appId && apiKey) {
                  const ts = Math.floor(Date.now() / 1000);
                  nextOptions.headers['X-Timestamp'] = String(ts);
                  nextOptions.headers['X-Signature'] = crypto.createHash('sha256').update(`${appId}${ts}${next.pathname}${apiKey}`).digest('base64');
                }
              }
              // Redirect bodies are irrelevant; release their socket immediately.
              response.removeListener('error', onResponseError);
              response.removeListener('aborted', onResponseAborted);
              response.on('error', () => {});
              response.destroy();
              request(next, depth + 1, nextOptions);
              return;
            }
            const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
            const decompress = encoding.includes('gzip') ? zlib.createGunzip()
              : encoding.includes('deflate') ? zlib.createInflate() : encoding.includes('br') ? zlib.createBrotliDecompress() : null;
            const stream = activeStream = decompress ? response.pipe(decompress) : response;
            const chunks = [];
            let bytes = 0;
            stream.on('error', error => finish(error));
            stream.on('data', chunk => {
              if (settled) return;
              bytes += chunk.length;
              if (bytes > maxBytes) return finish(new Error('HTTP_RESPONSE_TOO_LARGE'));
              chunks.push(chunk);
            });
            stream.on('end', () => {
              if (settled) return;
              const text = Buffer.concat(chunks).toString('utf8');
              let data = text;
              try { data = JSON.parse(text); } catch (_) {}
              finish(null, { status: response.statusCode, data, headers: response.headers });
            });
          } catch (error) { response.destroy(); finish(error); }
        });
        activeRequest = outgoing;
        outgoing.on('error', error => { if (activeRequest === outgoing) finish(error); });
        if (options.body) outgoing.write(options.body);
        outgoing.end();
      } catch (error) { finish(error); }
    };
    request(url, 0, opts);
  });
}
module.exports = httpFetch;
