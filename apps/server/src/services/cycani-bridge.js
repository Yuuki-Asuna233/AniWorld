// Authenticated CYCANI resolver used only by the AniWorld source bridge.
const { findAlias } = require('../../anime-titles');
const BASE = 'https://www.cycani.org/api';
const HEADERS = {
  Accept: 'application/json',
  'X-App-Name': 'cyc_web',
  'X-App-Version': 'cycweb',
  'X-Time-Zone': 'Asia/Shanghai'
};

let token = '';
let tokenExpiresAt = 0;
let loginInFlight = null;
const videoCache = new Map();

function waitForShared(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('PLAYBACK_CANCELLED'));
    if (signal.aborted) {
      promise.catch(() => {});
      return abort();
    }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function withPlaybackDeadline(httpFetch, options, resolve) {
  const controller = new AbortController();
  const deadline = Date.now() + Math.max(1, Math.min(18000, Number(options.timeoutMs) || 18000));
  const abort = () => controller.abort(options.signal?.reason || new Error('PLAYBACK_CANCELLED'));
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('PLAYBACK_RESOLVE_TIMEOUT')), deadline - Date.now());
  timer.unref?.();
  const boundedFetch = (url, settings = {}) => {
    if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
    if (Date.now() >= deadline) return Promise.reject(new Error('PLAYBACK_RESOLVE_TIMEOUT'));
    return httpFetch(url, {...settings, signal: controller.signal,
      timeout: Math.max(1, Math.min(Number(settings.timeout) || 15000, deadline - Date.now()))});
  };
  Object.assign(boundedFetch, { deadline, signal: controller.signal, shared: httpFetch });
  try { return await resolve(boundedFetch); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}

function normalizeToken(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return /^Bearer\s/i.test(raw) ? raw : `Bearer ${raw}`;
}

async function requestJson(httpFetch, url, options = {}) {
  const response = await httpFetch(url, options);
  return { status: response?.status || 0, data: response?.data };
}

async function login(httpFetch) {
  const username = String(process.env.CYCANI_USERNAME || '').trim();
  const password = String(process.env.CYCANI_PASSWORD || '');
  if (!username || !password) return null;
  const response = await requestJson(httpFetch, `${BASE}/auth/login`, {
    method: 'POST',
    timeout: 12000,
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const body = response.data || {};
  const data = body.data || body;
  const next = normalizeToken(data.token || data.access_token || body.token);
  if (response.status < 200 || response.status >= 300 || !next) {
    throw new Error(`CYCANI login failed (${response.status || 'network'})`);
  }
  token = next;
  const expiry = Date.parse(String(data.expires_at || data.expiresAt || ''));
  tokenExpiresAt = Number.isFinite(expiry) && expiry > Date.now()
    ? expiry
    : Date.now() + 9 * 60 * 1000;
  return token;
}

async function getToken(httpFetch, force = false) {
  if (httpFetch.signal?.aborted) throw httpFetch.signal.reason || new Error('PLAYBACK_CANCELLED');
  if (!force && token && tokenExpiresAt - Date.now() > 60 * 1000) return token;
  const configured = normalizeToken(process.env.CYCANI_AUTH_TOKEN);
  if (!force && configured) {
    token = configured;
    tokenExpiresAt = Date.now() + 9 * 60 * 1000;
    return token;
  }
  if (!loginInFlight) {
    // One caller abandoning playback must not cancel another caller's login.
    loginInFlight = login(httpFetch.shared || httpFetch).finally(() => { loginInFlight = null; });
  }
  return waitForShared(loginInFlight, httpFetch.signal);
}

function rows(body, strict = false) {
  const candidates = [
    body?.data?.list,
    body?.data?.items,
    body?.data?.sections,
    body?.data?.results,
    body?.data,
    body?.list,
    body?.items,
    body?.results,
    body?.sections,
    body
  ];
  const list = candidates.find(Array.isArray);
  if (!list && strict) throw new Error('CYCANI搜索列表格式异常');
  return list || [];
}

function titleOf(row) {
  return String(row?.title || row?.name || '').trim();
}

function keyOf(value) {
  return String(value || '').toLowerCase()
    .replace(/[\s\u3000·・:：,，.!！?？'"“”‘’()（）\[\]【】{}《》]/g, '');
}

function videoIdOf(row) {
  return row?.video_id || row?.id || row?.videoId || null;
}

function mapVideoRow(row) {
  return {
    videoId: videoIdOf(row),
    title: titleOf(row),
    image: String(row?.cover_url || row?.cover || '').trim(),
    remarks: String(row?.remarks || '').trim(),
    year: row?.year || '',
    version: String(row?.version || '').trim(),
    description: String(row?.description || '').trim(),
    totalEpisodes: Number(row?.total) || 0,
    score: Number(row?.score) || 0,
    hits: Number(row?.hits) || 0
  };
}

// Resolve a title to its full CYCANI video row. The whole row is cached so
// callers can reuse cover/year/remarks without a second search request.
async function findVideo(title, httpFetch) {
  const query = String(title || '').trim();
  if (!query) return null;
  const key = keyOf(query);
  const cached = videoCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.row;
  const response = await requestJson(
    httpFetch,
    `${BASE}/videos/search?q=${encodeURIComponent(query)}`,
    { timeout: 12000, headers: HEADERS }
  );
  if (response.status < 200 || response.status >= 300) return null;
  const list = rows(response.data);
  const wanted = keyOf(query);
  const exact = list.filter(row => keyOf(titleOf(row)) === wanted);
  const aliasKey = keyOf(findAlias(query) || query);
  const aliases = list.filter(row => keyOf(titleOf(row)) === aliasKey);
  const item = exact.length === 1 ? exact[0] : exact.length === 0 && aliases.length === 1 ? aliases[0] : null;
  const row = item || null;
  for (const [cacheKey, value] of videoCache) {
    if (value.expiresAt <= Date.now()) videoCache.delete(cacheKey);
  }
  if (videoCache.size >= 500) videoCache.delete(videoCache.keys().next().value);
  videoCache.set(key, { row, expiresAt: Date.now() + 10 * 60 * 1000 });
  return row;
}

async function findVideoId(title, httpFetch) {
  return videoIdOf(await findVideo(title, httpFetch));
}

// Keyword search against the CYCANI catalogue. CYCANI is the site's current
// source of truth for playback, so it also backs the search box; OIAPI's
// catalogue lags a whole season behind.
async function cycaniSearch(query, httpFetch, options = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const pageSize = Math.min(Math.max(Number.parseInt(options.pageSize, 10) || 30, 1), 50);
  const page = Math.max(Number.parseInt(options.page, 10) || 1, 1);
  const response = await requestJson(
    httpFetch,
    `${BASE}/videos/search?q=${encodeURIComponent(q)}&page=${page}&page_size=${pageSize}`,
    { timeout: options.timeout || 12000, headers: HEADERS }
  );
  if (response.status < 200 || response.status >= 300) {
    if (options.strict) throw new Error('CYCANI搜索请求失败');
    return [];
  }
  const body = response.data || {};
  if (body.code !== 0 && body.code !== 200) {
    if (options.strict) throw new Error('CYCANI搜索响应异常');
    return [];
  }
  const list = rows(body, options.strict);
  const mapped = list.map(mapVideoRow);
  if (options.strict && mapped.some(item => !item.videoId || !item.title)) {
    throw new Error('CYCANI搜索结果字段异常');
  }
  return mapped.filter(item => item.videoId && item.title);
}

function normalizeSection(row, index) {
  const id = row?.id || row?.section_id || row?.sectionId || '';
  const episode = episodeOf(row) || index + 1;
  const title = String(
    row?.title || row?.name || row?.episode_title || row?.episodeTitle || ''
  ).trim() || `第${String(episode).padStart(2, '0')}集`;
  return { id: String(id), episode, title, playable: Boolean(id) };
}

async function cycaniDetails(title, httpFetch) {
  const video = await findVideo(title, httpFetch);
  const videoId = videoIdOf(video);
  if (!videoId) return null;
  const response = await requestJson(
    httpFetch,
    `${BASE}/videos/${encodeURIComponent(videoId)}/sections?player_code=cychub`,
    { timeout: 12000, headers: HEADERS }
  );
  if (response.status < 200 || response.status >= 300) return null;
  const sections = rows(response.data)
    .map((row, index) => normalizeSection(row, index))
    .filter(section => section.id);
  const meta = mapVideoRow(video);
  return {
    source: 'cycani',
    videoId: String(videoId),
    title: String(title || '').trim(),
    // The catalogue name can differ from the requested title (for example
    // "转生成为魔剑 第二季" vs CYCANI's "转生就是剑 第二季"), so expose both.
    resolvedTitle: meta.title || String(title || '').trim(),
    cover: meta.image,
    year: meta.year,
    remarks: meta.remarks,
    description: meta.description,
    version: meta.version,
    totalEpisodes: meta.totalEpisodes,
    sections,
    availableEpisodes: sections.filter(section => section.playable).length
  };
}

function episodeOf(row) {
  for (const value of [row?.episode, row?.episode_number, row?.episodeNumber, row?.sort, row?.number, row?.title]) {
    const match = String(value ?? '').match(/\d+/);
    if (match) return Number(match[0]);
  }
  return 0;
}

async function cycaniPlayUrl(title, episode, httpFetch, options = {}) {
  if (!httpFetch.deadline) return withPlaybackDeadline(httpFetch, options,
    fetch => cycaniPlayUrl(title, episode, fetch));
  const videoId = await findVideoId(title, httpFetch);
  if (!videoId) return null;
  const sectionResponse = await requestJson(
    httpFetch,
    `${BASE}/videos/${encodeURIComponent(videoId)}/sections?player_code=cychub`,
    { timeout: 12000, headers: HEADERS }
  );
  if (sectionResponse.status < 200 || sectionResponse.status >= 300) return null;
  const list = rows(sectionResponse.data);
  const wanted = Number.parseInt(String(episode).replace(/\D/g, ''), 10) || 1;
  const matches = list.filter(row => episodeOf(row) === wanted);
  const section = matches.length === 1 ? matches[0]
    : list.every(row => episodeOf(row) === 0) ? list[wanted - 1] : null;
  const sectionId = section?.id || section?.section_id || section?.sectionId;
  if (!sectionId) return null;

  return cycaniPlayUrlBySection(sectionId, httpFetch);
}

async function cycaniPlayUrlBySection(sectionId, httpFetch, options = {}) {
  if (!httpFetch.deadline) return withPlaybackDeadline(httpFetch, options,
    fetch => cycaniPlayUrlBySection(sectionId, fetch));
  if (!sectionId) return null;

  let currentToken = await getToken(httpFetch);
  if (!currentToken) return null;
  let response = await requestJson(
    httpFetch,
    `${BASE}/v2/sections/${encodeURIComponent(sectionId)}/play-url`,
    { timeout: 15000, headers: { ...HEADERS, Authorization: currentToken } }
  );
  if (response.status === 401) {
    currentToken = await getToken(httpFetch, true);
    if (!currentToken) return null;
    response = await requestJson(
      httpFetch,
      `${BASE}/v2/sections/${encodeURIComponent(sectionId)}/play-url`,
      { timeout: 15000, headers: { ...HEADERS, Authorization: currentToken } }
    );
  }
  if (response.status < 200 || response.status >= 300) return null;
  const body = response.data || {};
  const data = body.data || body;
  const url = data.url || data.play_url || data.playUrl || body.url || body.play_url;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

module.exports = {
  cycaniDetails,
  cycaniPlayUrl,
  cycaniPlayUrlBySection,
  cycaniSearch,
  findVideo
};
