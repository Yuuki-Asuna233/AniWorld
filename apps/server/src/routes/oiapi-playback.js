// Playback compatibility, probing and multi-source discovery routes.
// Kept separate from catalogue/search routes because these endpoints resolve
// short-lived media URLs and have different caching and timeout semantics.

const { findAlias } = require('../../anime-titles');
const {
  OI_BASE,
  generateOiMsgCandidates,
  resolveCurrentOiSelection
} = require('../services/oi-helpers');
const {
  cycaniDetails,
  cycaniPlayUrl,
  cycaniPlayUrlBySection
} = require('../services/cycani-bridge');

const NO_STORE = 'no-store, no-cache, must-revalidate, proxy-revalidate';
const NON_VIDEO_PATH_PATTERN = /(?:~tplv-[^/]*-image\.image$|\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:$|[.~_-]))/i;
// Upstream may report a video via a URL whose path looks like an image
// (e.g. ByteDance ~tplv-...-image.image "video poster"). When the upstream
// explicitly declares a video codec/container, trust it as a real video.
const VIDEO_TYPE_HINT = /(h264|h265|hevc|avc|av1|vp9|mp4|flv|m3u8|mkv|webm|ts|mpeg|video)/i;
const PLAY_RESOLUTION_TTL = 20 * 1000;
const MAX_PLAY_RESOLUTIONS = 500;
const pendingPlayResolutions = new Map();
const recentPlayResolutions = new Map();

function getRecentPlayResolution(key) {
  const entry = recentPlayResolutions.get(key);
  if (!entry || Date.now() - entry.savedAt > PLAY_RESOLUTION_TTL) {
    recentPlayResolutions.delete(key);
    return null;
  }
  return entry.value;
}

function rememberPlayResolution(key, value) {
  recentPlayResolutions.set(key, { savedAt: Date.now(), value });
  if (recentPlayResolutions.size <= MAX_PLAY_RESOLUTIONS) return;
  const oldestKey = recentPlayResolutions.keys().next().value;
  if (oldestKey !== undefined) recentPlayResolutions.delete(oldestKey);
}

function isPlausibleOiPlayback(data) {
  // 与服务器当前逻辑保持一致：只要上游返回非空播放地址就接受。
  const rawUrl = String(data?.play_url || '').trim();
  return rawUrl.length > 0;
}

function episodeIndexCandidates(value) {
  const numeric = Math.max(0, parseInt(value, 10) || 0);
  return [String(numeric), String(numeric).padStart(2, '0'), String(numeric).padStart(3, '0')]
    .filter((item, index, values) => values.indexOf(item) === index);
}

function proxyUrlFor(playUrl) {
  if (!playUrl) return '';
  // Preserve escapes inside signed query parameters. The proxy URL only adds
  // one outer encoding layer; decoding the original would invalidate tokens.
  return `/api/video?url=${encodeURIComponent(String(playUrl))}`;
}

function videoTypeFor(playUrl) {
  const pathname = new URL(playUrl).pathname.toLowerCase();
  if (/\.m3u8?$/.test(pathname)) return 'm3u8';
  if (/\.mp4$/.test(pathname)) return 'mp4';
  // Opaque CDN paths need player probing; their actual container is unknown.
  return '';
}

function playbackPayload(data, extra = {}) {
  return {
    name: data?.name || '',
    play_num: data?.play_num || '',
    play_url: data?.play_url || '',
    video_type: data?.video_type || '',
    source: 'oiapi',
    proxy_url: proxyUrlFor(data?.play_url),
    ...extra
  };
}

function mountOiPlaybackRoutes(app, { httpFetch }) {
  // AniWorld's current source of truth. These endpoints deliberately do not
  // fall back to OIAPI: an OIAPI URL can be syntactically valid but already
  // unavailable, which makes the player show a misleading source error.
  app.get('/api/cycani/details', async (req, res) => {
    const title = String(req.query.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title参数必需' });
    try {
      const details = await cycaniDetails(title, httpFetch);
      if (!details || details.sections.length === 0) {
        return res.status(404).json({ error: '次元城未找到可播放剧集' });
      }
      return res.json(details);
    } catch (error) {
      return res.status(502).json({ error: `次元城剧集查询失败: ${error.message}` });
    }
  });

  const playbackRequestOptions = (req, res) => {
    const controller = new AbortController();
    const cleanup = () => { req.removeListener('aborted', abort); res.removeListener('close', abort); };
    const abort = () => {
      if (!res.writableEnded) controller.abort(new Error('PLAYBACK_CLIENT_DISCONNECTED'));
      cleanup();
    };
    req.once('aborted', abort);
    res.once('close', abort);
    res.once('finish', cleanup);
    return { signal: controller.signal };
  };
  app.get('/api/cycani/play', async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    const sectionId = String(req.query.sectionId || '').trim();
    const title = String(req.query.title || '').trim();
    const episode = String(req.query.j || req.query.episode || '1');
    if (!sectionId && !title) {
      return res.status(400).json({ error: 'sectionId或title参数必需' });
    }
    try {
      const options = playbackRequestOptions(req, res);
      const playUrl = sectionId
        ? await cycaniPlayUrlBySection(sectionId, httpFetch, options)
        : await cycaniPlayUrl(title, episode, httpFetch, options);
      if (res.destroyed) return;
      if (!playUrl) return res.status(503).json({ error: '次元城播放地址暂不可用' });
      return res.json({
        play_url: playUrl,
        video_type: videoTypeFor(playUrl),
        source: 'cycani',
        proxy_url: proxyUrlFor(playUrl),
        section_id: sectionId,
        play_num: episode
      });
    } catch (error) {
      if (res.destroyed) return;
      return res.status(502).json({ error: `次元城播放解析失败: ${error.message}` });
    }
  });

  // Kept as a compatibility alias for clients that persisted the old
  // aniworld://oi-play URL format. It now resolves through CYCANI only.
  app.get('/api/oi/play', async (req, res) => {
    let { msg, n, j } = req.query;
    if (!msg || n === undefined || j === undefined) {
      return res.status(400).json({ error: 'msg、n、j参数必需' });
    }
    const aliased = findAlias(msg);
    if (aliased) msg = aliased;
    const cleanJ = String(j).match(/\d+/)?.[0] || '1';
    res.set('Cache-Control', NO_STORE);
    try {
      const playUrl = await cycaniPlayUrl(msg, cleanJ, httpFetch, playbackRequestOptions(req, res));
      if (res.destroyed) return;
      if (!playUrl) {
        return res.status(503).json({ error: '次元城播放地址暂不可用' });
      }
      return res.json({
        name: msg,
        play_num: cleanJ,
        play_url: playUrl,
        video_type: videoTypeFor(playUrl),
        source: 'cycani',
        proxy_url: proxyUrlFor(playUrl),
        type_used: 'cycani',
        resolved_msg: msg,
        resolved_n: Number(n) || 1
      });
    } catch (error) {
      if (res.destroyed) return;
      return res.status(503).json({ error: `次元城播放解析失败: ${error.message}` });
    }
  });

  app.get('/api/oi/probe', async (req, res) => {
    let { msg, n, maxJ = '30', type = 'auto', tryAltN = 'true', preferredJ } = req.query;
    if (!msg || n === undefined) return res.status(400).json({ error: 'msg和n参数必需' });

    const aliased = findAlias(msg);
    if (aliased) msg = aliased;
    const selection = await resolveCurrentOiSelection(msg, n, httpFetch, 8000);
    msg = selection.msg || msg;
    let baseN = selection.index;

    const nValues = [baseN];
    if (tryAltN !== 'false') {
      for (let delta = -1; delta <= 2; delta++) {
        const altN = baseN + delta;
        if (altN >= 1 && !nValues.includes(altN)) nValues.push(altN);
      }
    }

    const max = Math.min(parseInt(maxJ) || 30, 50);
    const jValues = [];
    const preferred = parseInt(preferredJ);
    if (!isNaN(preferred) && preferred >= 0 && preferred <= max) jValues.push(preferred);
    for (let value = 0; value <= max; value++) {
      if (value !== preferred) jValues.push(value);
    }
    res.set('Cache-Control', NO_STORE);

    for (const tryN of nValues) {
      const types = type === 'auto' ? ['1', '2', '3'] : [type];
      for (let start = 0; start < jValues.length; start += 5) {
        const batch = [];
        for (let index = start; index < Math.min(start + 5, jValues.length); index++) {
          for (const candidateType of types) {
            batch.push({ j: String(jValues[index]), type: candidateType });
          }
        }
        const results = await Promise.all(batch.map(async ({ j: episode, type: candidateType }) => {
          try {
            const response = await httpFetch(
              `${OI_BASE}?msg=${encodeURIComponent(msg)}&n=${tryN}&j=${episode}&type=${candidateType}`,
              { timeout: 6000 }
            );
            if (response.status === 200 && response.data?.code === 200 && isPlausibleOiPlayback(response.data.data)) {
              return {
                found: true,
                j: episode,
                type: candidateType,
                n: tryN,
                ...playbackPayload(response.data.data)
              };
            }
          } catch (_) {}
          return null;
        }));
        const winner = results.find(Boolean);
        if (winner) return res.json(winner);
      }
    }
    return res.json({ found: false });
  });

  app.get('/api/oi/sources', async (req, res) => {
    let { msg, n, j = '1' } = req.query;
    if (!msg || n === undefined) return res.status(400).json({ error: 'msg和n参数必需' });
    const aliased = findAlias(msg);
    if (aliased) msg = aliased;

    const selection = await resolveCurrentOiSelection(msg, n, httpFetch, 8000);
    msg = selection.msg || msg;
    let numericN = selection.index;

    const jNum = parseInt(j) || 1;
    const jCandidates = [
      String(jNum),
      String(jNum).padStart(2, '0'),
      String(jNum).padStart(3, '0'),
      ...(jNum === 1 ? ['0'] : [])
    ].filter((value, index, values) => values.indexOf(value) === index);
    res.set('Cache-Control', NO_STORE);

    async function trySourcesWithMsg(testMsg) {
      let testN = numericN;
      if (testMsg !== msg) {
        const alternative = await resolveCurrentOiSelection(testMsg, numericN, httpFetch, 5000);
        testN = alternative.index;
      }

      const probeOne = async (candidateType, episode) => {
        const response = await httpFetch(
          `${OI_BASE}?msg=${encodeURIComponent(testMsg)}&n=${testN}&j=${episode}&type=${candidateType}`,
          { timeout: 5000 }
        );
        if (response.status === 200 && response.data?.code === 200 && isPlausibleOiPlayback(response.data.data)) {
          return {
            type: candidateType,
            j: episode,
            ...playbackPayload(response.data.data)
          };
        }
        throw new Error('not_found');
      };

      const probes = [];
      for (const candidateType of ['1', '2', '3']) {
        for (const episode of jCandidates) probes.push(probeOne(candidateType, episode));
        probes.push(probeOne(candidateType, '0'));
      }

      try {
        const timeoutSentinel = { __timeout: true };
        const timeout = new Promise(resolve => setTimeout(() => resolve(timeoutSentinel), 6000));
        const first = await Promise.any([...probes, timeout]);
        if (!first || first.__timeout) return { found: false, sources: [] };

        const collected = [first];
        const collectTimeout = new Promise(resolve => setTimeout(() => resolve('done'), 2000));
        await Promise.race([
          Promise.allSettled(probes).then(results => {
            for (const result of results) {
              if (result.status === 'fulfilled') collected.push(result.value);
            }
            return 'done';
          }),
          collectTimeout
        ]);

        const seen = new Set();
        const sources = collected.filter(source => {
          const key = source.play_url || `${source.type}|${source.j}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return { found: true, sources, best: sources[0] };
      } catch (_) {
        return { found: false, sources: [] };
      }
    }

    const primaryResult = await trySourcesWithMsg(msg);
    if (primaryResult.found) return res.json(primaryResult);

    for (const altMsg of generateOiMsgCandidates(msg)) {
      const altResult = await trySourcesWithMsg(altMsg);
      if (altResult.found) return res.json(altResult);
    }
    return res.json({ found: false, sources: [] });
  });
}

module.exports = {
  mountOiPlaybackRoutes,
  episodeIndexCandidates,
  isPlausibleOiPlayback,
  playbackPayload,
  proxyUrlFor
};
