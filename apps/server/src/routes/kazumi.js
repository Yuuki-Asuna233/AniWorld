// Kazumi-compatible API routes
// Serves anime metadata from local database in Bangumi API format
// so the Flutter Kazumi/AniWorld app can use our backend instead of bangumi.tv

const express = require('express');
const fs = require('fs');
const path = require('path');
const { safeJsonParse } = require('../utils/db-helpers');
const { getCurrentSeasonInfo, hkDateParts, hkWeekday } = require('../utils/date');
const { buildAiringSchedule } = require('../services/sync');
const { resolveAnimeMetadata } = require('../services/anime-identity');
const httpFetch = require('../services/http');

// --------------- helpers ---------------

const HONG_KONG_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAILY_REFRESH_HOUR = 4;
const WEEKLY_REFRESH_HOUR = 4;
const WEEKLY_REFRESH_MINUTE = 10;
const TREND_RETRY_MS = 30 * 60 * 1000;
let trendSnapshotStore = null;
let trendSnapshotStorePath = '';
const trendRefreshInFlight = { daily: null, weekly: null };
let trendSchedulerStarted = false;

function parseStartDate(val) {
  if (!val) return null;
  try {
    const obj = typeof val === 'string' ? JSON.parse(val) : val;
    if (obj && obj.year && obj.month && obj.day) {
      return {
        year: Number(obj.year),
        month: Number(obj.month),
        day: Number(obj.day)
      };
    }
  } catch (_) {}
  // Try "YYYY-MM-DD" string
  const m = String(val).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { year: +m[1], month: +m[2], day: +m[3] };
  return null;
}

function formatDate(d) {
  if (!d) return '';
  const m = String(d.month).padStart(2, '0');
  const day = String(d.day).padStart(2, '0');
  return `${d.year}-${m}-${day}`;
}

function weekdayFromDate(d) {
  if (!d) return 0;
  // JS getDay: 0=Sun, 1=Mon, ..., 6=Sat
  // Bangumi air_weekday: 1=Mon, 2=Tue, ..., 7=Sun
  const jsDay = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay; // Convert Sun 0→7, Mon 1→1
}

function scoreToRating(score) {
  if (!score || score === 0) return 0;
  return Math.round(score / 10 * 10) / 10; // Convert 61→6.1
}

function parseGenres(raw) {
  const arr = safeJsonParse(raw, []);
  return arr.map(name => ({ name, count: 0 }));
}

function emptyRatingCount() {
  const c = {};
  for (let i = 1; i <= 10; i++) c[i] = 0;
  return c;
}

function imagePack(url = '') {
  return { large: url, medium: url, small: url, grid: url };
}

function aniListName(name = {}) {
  return name.native || name.full || name.romaji || '';
}

function roleLabel(role) {
  const raw = String(role || '').toUpperCase();
  if (raw === 'MAIN') return '主角';
  if (raw === 'SUPPORTING') return '配角';
  if (raw === 'BACKGROUND') return '客串';
  return raw || '角色';
}

async function queryAniListMedia(id) {
  const anilistId = Number(id);
  if (!anilistId) return null;
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        status
        episodes
        nextAiringEpisode { episode airingAt }
        characters(sort: [ROLE, RELEVANCE], perPage: 24) {
          edges {
            role
            node { id name { full native } image { large medium } }
            voiceActors(language: JAPANESE, sort: [RELEVANCE]) {
              id
              name { full native }
              image { large medium }
            }
          }
        }
        staff(sort: [RELEVANCE], perPage: 24) {
          edges {
            role
            node { id name { full native } image { large medium } }
          }
        }
      }
    }
  `;
  const resp = await httpFetch('https://graphql.anilist.co', {
    method: 'POST',
    timeout: 12000,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { id: anilistId } })
  });
  if (resp.status >= 400 || !resp.data || resp.data.errors) return null;
  return resp.data?.data?.Media || null;
}

async function queryAniListCharacter(id) {
  const characterId = Number(id);
  if (!characterId) return null;
  const query = `
    query ($id: Int) {
      Character(id: $id) {
        id
        name { full native alternative }
        image { large medium }
        description(asHtml: false)
        gender
        age
        dateOfBirth { year month day }
        bloodType
      }
    }
  `;
  const resp = await httpFetch('https://graphql.anilist.co', {
    method: 'POST',
    timeout: 12000,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { id: characterId } })
  });
  if (resp.status >= 400 || !resp.data || resp.data.errors) return null;
  return resp.data?.data?.Character || null;
}

function characterToDetail(character, id) {
  if (!character) return null;
  const name = character.name || {};
  const image = character.image?.large || character.image?.medium || '';
  const birth = character.dateOfBirth && Object.values(character.dateOfBirth).filter(Boolean).join('-');
  const infobox = [
    character.gender && { key: '性别', value: character.gender },
    character.age && { key: '年龄', value: character.age },
    birth && { key: '生日', value: birth },
    character.bloodType && { key: '血型', value: character.bloodType }
  ].filter(Boolean);
  const info = infobox.map(item => `${item.key}：${item.value}`).join('\n');
  const alternatives = Array.isArray(name.alternative) ? name.alternative : [];
  return {
    id: Number(character.id) || Number(id) || 0,
    name: name.full || name.native || name.alternative?.[0] || '',
    nameCN: alternatives[0] || (name.native && name.full && name.native !== name.full ? name.native : ''),
    type: 1,
    images: imagePack(image),
    info,
    summary: String(character.description || '').trim(),
    infobox
  };
}

/**
 * Convert an anime_meta row to Bangumi-style subject JSON
 */
function metaToSubject(meta) {
  const date = parseStartDate(meta.start_date);
  const status = String(meta.status || '').toUpperCase();
  const episodes = Number(meta.episodes) || 0;
  const nextEpisode = Number(meta.next_airing_episode) || 0;
  const airedEpisodes = status === 'FINISHED'
    ? episodes
    : status === 'RELEASING'
      ? Math.max(0, nextEpisode - 1)
      : 0;
  return {
    id: meta.anilist_id,
    type: 2,
    format: meta.format || '',
    name: meta.title_native || meta.title_romaji || '',
    name_cn: meta.title_chinese || '',
    summary: '',
    date: formatDate(date),
    images: {
      large: meta.cover_image || '',
      common: meta.cover_image || '',
      medium: meta.cover_image || '',
      small: meta.cover_image || '',
      grid: meta.cover_image || ''
    },
    tags: parseGenres(meta.genres),
    rating: {
      rank: meta.popularity || 0,
      score: scoreToRating(meta.average_score),
      total: 0,
      count: emptyRatingCount()
    },
    air_weekday: weekdayFromDate(date),
    air_date: formatDate(date),
    status,
    eps: episodes,
    aired_eps: airedEpisodes,
    info: JSON.stringify({
      source: 'oiapi',
      oiMsg: meta.oi_msg || meta.title_chinese || '',
      oiIndex: Number(meta.oi_index) || 1
    }),
    collection: {
      doing: 0
    }
  };
}

function oiResultToSubject(item) {
  const idRaw = item.anilist_id || item.anilistId || item.id || 0;
  const id = Number(String(idRaw).replace(/^anilist_/, '')) || 0;
  const startDate = item.startDate && typeof item.startDate === 'object'
    ? item.startDate
    : null;
  const year = Number(item.seasonYear || item.year) || 0;
  const date = startDate || (year ? { year, month: 1, day: 1 } : null);
  const genres = Array.isArray(item.genres) ? item.genres : [];
  const score = Number(item.score || item.averageScore || 0);
  const status = String(item.status || '').toUpperCase();
  const episodes = Number(item.episodes) || 0;
  const nextEpisode = Number(
    item.next_airing_episode ||
    item.nextAiringEpisode?.episode ||
    item.nextAiringEpisode
  ) || 0;
  const airedEpisodes = status === 'FINISHED'
    ? episodes
    : status === 'RELEASING'
      ? Math.max(0, nextEpisode - 1)
      : 0;
  return {
    id,
    type: 2,
    format: item.format || '',
    name: item.nativeTitle || item.romajiTitle || item.romaji || item.title || '',
    name_cn: item.title || item.name || item.romajiTitle || '',
    summary: item.synopsis || item.desc || '',
    date: formatDate(date),
    images: {
      large: item.image || item.cover || '',
      common: item.image || item.cover || '',
      medium: item.image || item.cover || '',
      small: item.image || item.cover || '',
      grid: item.image || item.cover || ''
    },
    tags: genres.map(name => ({ name, count: 0 })),
    rating: {
      rank: Number(item.popularity || 0),
      score: scoreToRating(score),
      total: 0,
      count: emptyRatingCount()
    },
    air_weekday: weekdayFromDate(date),
    air_date: formatDate(date),
    status,
    eps: episodes,
    aired_eps: airedEpisodes,
    info: JSON.stringify({
      source: 'oiapi',
      oiMsg: item.oiMsg || item.title || item.name || '',
      oiIndex: Number(item.oiIndex) || 1
    }),
    collection: { doing: 0 }
  };
}

function uniqueSubjects(subjects) {
  const seen = new Set();
  return subjects.filter(item => {
    const key = item.id || item.name_cn || item.name;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function currentSeason() {
  return getCurrentSeasonInfo()[0];
}

function currentYearFilter(referenceDate = new Date()) {
  return { year: hkDateParts(referenceDate).year };
}

function getSectionMeta(database, type, limit) {
  const season = currentSeason();
  if (type === 'newseason') {
    const seasonal = database.getAnimeMetaBySeason(season.season, season.seasonYear, limit * 2);
    return seasonal
      .sort((a, b) => (b.average_score || 0) - (a.average_score || 0))
      .slice(0, limit);
  }
  if (type === 'classic') {
    return database.getRankingsFromDb('toprated', limit);
  }
  if (type === 'movie') {
    return database.getRecentMoviesFromDb(limit);
  }
  if (type === 'hot') {
    const ranked = database.getRankingsFromDb(
      'yearpopular',
      limit,
      currentYearFilter()
    );
    if (ranked.length) return ranked;
    return database.getRankingsFromDb('popular', limit);
  }
  if (type === 'popular') {
    return database.getRankingsFromDb('popular', limit);
  }
  const ranked = database.getRankingsFromDb('popular', limit);
  if (ranked.length) return ranked;
  const browse = database.getBrowseFromDb({}, 1, limit);
  return browse.results || [];
}

function trendSnapshotPath() {
  return process.env.TREND_SNAPSHOT_PATH ||
    path.join(process.cwd(), 'data', 'runtime', 'trend-rankings.json');
}

function formatPeriodDate(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-');
}

function trendPeriodKey(type, nowValue = Date.now()) {
  const shifted = new Date(Number(nowValue) + HONG_KONG_OFFSET_MS);
  if (type === 'daily') {
    if (shifted.getUTCHours() < DAILY_REFRESH_HOUR) {
      shifted.setUTCDate(shifted.getUTCDate() - 1);
    }
    return formatPeriodDate(shifted);
  }

  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  let daysSinceMonday = (shifted.getUTCDay() + 6) % 7;
  if (
    daysSinceMonday === 0 &&
    minutes < WEEKLY_REFRESH_HOUR * 60 + WEEKLY_REFRESH_MINUTE
  ) {
    daysSinceMonday = 7;
  }
  shifted.setUTCDate(shifted.getUTCDate() - daysSinceMonday);
  return formatPeriodDate(shifted);
}

function nextTrendRefreshAt(type, nowValue = Date.now()) {
  const now = Number(nowValue);
  const shifted = new Date(now + HONG_KONG_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  let target;

  if (type === 'daily') {
    target = Date.UTC(year, month, day, DAILY_REFRESH_HOUR, 0) -
      HONG_KONG_OFFSET_MS;
    if (target <= now) target += 24 * 60 * 60 * 1000;
    return target;
  }

  const daysUntilMonday = (8 - shifted.getUTCDay()) % 7;
  target = Date.UTC(
    year,
    month,
    day + daysUntilMonday,
    WEEKLY_REFRESH_HOUR,
    WEEKLY_REFRESH_MINUTE
  ) - HONG_KONG_OFFSET_MS;
  if (target <= now) target += 7 * 24 * 60 * 60 * 1000;
  return target;
}

function loadTrendSnapshotStore() {
  const filePath = trendSnapshotPath();
  if (trendSnapshotStore && trendSnapshotStorePath === filePath) {
    return trendSnapshotStore;
  }
  trendSnapshotStorePath = filePath;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    trendSnapshotStore = parsed && parsed.version === 1
      ? parsed
      : { version: 1 };
  } catch (_) {
    trendSnapshotStore = { version: 1 };
  }
  return trendSnapshotStore;
}

function saveTrendSnapshot(type, periodKey, rows) {
  const store = loadTrendSnapshotStore();
  store[type] = {
    periodKey,
    generatedAt: new Date().toISOString(),
    ids: rows.map(row => Number(row.anilist_id)).filter(Boolean)
  };
  const filePath = trendSnapshotPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function rowsFromTrendSnapshot(database, type, periodKey, limit) {
  const snapshot = loadTrendSnapshotStore()[type];
  if (
    !snapshot ||
    snapshot.periodKey !== periodKey ||
    !Array.isArray(snapshot.ids)
  ) {
    return [];
  }
  return snapshot.ids
    .map(id => database.getAnimeMetaById(Number(id)))
    .filter(meta => meta && meta.oi_msg)
    .slice(0, limit);
}

function trendFallback(database, limit) {
  const season = currentSeason();
  const seasonal = database.getAnimeMetaBySeason(
    season.season,
    season.seasonYear,
    limit
  );
  return seasonal.length
    ? seasonal
    : database.getRankingsFromDb('toprated', limit);
}

async function fetchTrendRows(database, fetcher, type, limit) {
  const season = currentSeason();
  const query = `
    query ($season: MediaSeason, $seasonYear: Int) {
      Page(page: 1, perPage: 50) {
        media(
          season: $season,
          seasonYear: $seasonYear,
          type: ANIME,
          countryOfOrigin: JP,
          status: RELEASING,
          sort: TRENDING_DESC
        ) {
          id
          trends(page: 1, perPage: 7, sort: DATE_DESC) {
            nodes { date trending }
          }
        }
      }
    }
  `;

  try {
    const response = await fetcher('https://graphql.anilist.co', {
      method: 'POST',
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: 'https://anilist.co',
        Referer: 'https://anilist.co/'
      },
      body: JSON.stringify({
        query,
        variables: {
          season: season.season,
          seasonYear: season.seasonYear
        }
      })
    });
    const media = response.status < 400
      ? response.data?.data?.Page?.media || []
      : [];
    const ranked = media
      .map(item => ({
        id: Number(item.id) || 0,
        trendScore: type === 'daily'
          ? Number(item.trends?.nodes?.[0]?.trending) || 0
          : (item.trends?.nodes || []).slice(0, 7).reduce(
              (sum, point) => sum + (Number(point?.trending) || 0),
              0
            )
      }))
      .filter(item => item.id && item.trendScore > 0)
      .sort((a, b) => b.trendScore - a.trendScore)
      .map(item => database.getAnimeMetaById(item.id))
      .filter(meta => meta && meta.oi_msg)
      .slice(0, limit);

    if (ranked.length) {
      const fallback = database.getAnimeMetaBySeason(
        season.season,
        season.seasonYear,
        limit * 2
      );
      const seen = new Set();
      return [...ranked, ...fallback]
        .filter(meta => {
          if (!meta || !meta.oi_msg || seen.has(meta.anilist_id)) return false;
          seen.add(meta.anilist_id);
          return true;
        })
        .slice(0, limit);
    }
  } catch (error) {
    console.warn(`[kazumi] AniList ${type} trend unavailable:`, error.message);
  }
  return [];
}

async function getTrendingMeta(database, fetcher, type, limit = 10) {
  const safeType = type === 'daily' ? 'daily' : 'weekly';
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 10));
  const periodKey = trendPeriodKey(safeType);
  const savedRows = rowsFromTrendSnapshot(
    database,
    safeType,
    periodKey,
    safeLimit
  );
  if (savedRows.length) return savedRows;

  if (!trendRefreshInFlight[safeType]) {
    trendRefreshInFlight[safeType] = (async () => {
      const rows = await fetchTrendRows(
        database,
        fetcher,
        safeType,
        10
      );
      if (rows.length) saveTrendSnapshot(safeType, periodKey, rows);
      return rows;
    })().finally(() => {
      trendRefreshInFlight[safeType] = null;
    });
  }

  const refreshed = await trendRefreshInFlight[safeType];
  if (refreshed.length) return refreshed.slice(0, safeLimit);

  const staleSnapshot = loadTrendSnapshotStore()[safeType];
  if (Array.isArray(staleSnapshot?.ids)) {
    const staleRows = staleSnapshot.ids
      .map(id => database.getAnimeMetaById(Number(id)))
      .filter(meta => meta && meta.oi_msg)
      .slice(0, safeLimit);
    if (staleRows.length) return staleRows;
  }
  return trendFallback(database, safeLimit);
}

function getDailyTrendingMeta(database, fetcher, limit = 10) {
  return getTrendingMeta(database, fetcher, 'daily', limit);
}

function getWeeklyTrendingMeta(database, fetcher, limit = 10) {
  return getTrendingMeta(database, fetcher, 'weekly', limit);
}

function scheduleTrendSnapshots(database, fetcher) {
  if (trendSchedulerStarted) return;
  trendSchedulerStarted = true;

  const scheduleType = (type, retryDelay = null) => {
    const delay = retryDelay === null
      ? Math.max(1000, nextTrendRefreshAt(type) - Date.now())
      : retryDelay;
    const timer = setTimeout(async () => {
      try {
        await getTrendingMeta(database, fetcher, type, 10);
      } catch (error) {
        console.warn(`[kazumi] Scheduled ${type} trend refresh failed:`, error.message);
      }
      const current = loadTrendSnapshotStore()[type];
      if (current?.periodKey === trendPeriodKey(type)) {
        scheduleType(type);
      } else {
        scheduleType(type, TREND_RETRY_MS);
      }
    }, delay);
    timer.unref?.();
  };

  scheduleType('daily');
  scheduleType('weekly');
}

/**
 * Wrap a subject in the format used by calendar endpoint
 */
function wrapCalendarItem(meta) {
  const status = String(meta.status || '').toUpperCase();
  const episodes = Number(meta.episodes) || 0;
  const nextEpisode = Number(meta.next_airing_episode) || 0;
  return {
    id: meta.anilist_id,
    url: '/subject/' + meta.anilist_id,
    type: 2,
    name: meta.title_native || meta.title_romaji || '',
    name_cn: meta.title_chinese || '',
    summary: '',
    air_date: formatDate(parseStartDate(meta.start_date)),
    air_weekday: weekdayFromDate(parseStartDate(meta.start_date)),
    rating: {
      total: 0,
      count: emptyRatingCount(),
      score: scoreToRating(meta.average_score)
    },
    rank: meta.popularity || 0,
    status,
    eps: episodes,
    aired_eps: status === 'FINISHED'
      ? episodes
      : status === 'RELEASING'
        ? Math.max(0, nextEpisode - 1)
        : 0,
    images: {
      large: meta.cover_image || '',
      common: meta.cover_image || '',
      medium: meta.cover_image || '',
      small: meta.cover_image || '',
      grid: meta.cover_image || ''
    },
    collection: { doing: 0 }
  };
}

// --------------- routes ---------------

function mountKazumiRoutes(app, { database, httpFetch, cache }) {
  require('./catalog-search').mountCatalogSearchRoutes(app, { database });
  const router = express.Router();
  scheduleTrendSnapshots(database, httpFetch);

  // ===== 1. Search =====
  // POST /kazumi/v0/search/subjects
  // Used by: bangumiSearch, getBangumiList, getCalendarBySearch
  router.post('/v0/search/subjects', (req, res) => {
    try {
      const keyword = (req.body.keyword || '').trim();
      const sort = req.body.sort || 'rank';
      const filter = req.body.filter || {};
      const tags = filter.tag || [];
      const typeFilter = filter.type || [];
      const airDateFilter = filter.air_date || [];
      const rankFilter = filter.rank || [];
      const nsfw = filter.nsfw !== undefined ? filter.nsfw : false;
      const airWeekdayFilter = filter.air_weekday || [];

      // Get limit/offset from URL query params (Bangumi API format)
      const limit = parseInt(req.query.limit) || 20;
      const offset = parseInt(req.query.offset) || 0;

      let results = [];

      if (keyword) {
        // Keyword search
        results = database.searchAnimeMetaByTitle(keyword, 200);
      } else {
        // Browse/filter query
        results = searchAllAnime(database, 200);
      }

      // Filter by type (2 = anime)
      if (typeFilter.length > 0 && !typeFilter.includes(2)) {
        return res.json({ data: [], total: 0 });
      }

      // Filter by tags (country/genre)
      if (tags.length > 0) {
        const lowerTags = tags.map(t => t.toLowerCase());
        // "日本" filter -> country_of_origin = 'JP'
        if (lowerTags.includes('日本') || lowerTags.includes('japan') || lowerTags.includes('jp')) {
          results = results.filter(r => (r.country_of_origin || 'JP') === 'JP');
        }
      }

      // Filter by air_date range
      if (airDateFilter.length >= 2) {
        const gte = airDateFilter[0].replace('>=', '');
        const lt = airDateFilter[1].replace('<', '');
        results = results.filter(r => {
          const d = parseStartDate(r.start_date);
          if (!d) return true;
          const s = formatDate(d);
          return s >= gte && s < lt;
        });
      }

      // Filter by rank
      if (rankFilter.length >= 2) {
        const minRank = parseInt(rankFilter[0].replace('>', '').replace('>=', '')) || 0;
        const maxRank = parseInt(rankFilter[1].replace('<=', '').replace('<', '')) || 99999;
        results = results.filter(r => {
          const rank = r.popularity || 0;
          return rank > minRank && rank <= maxRank;
        });
      }

      // Filter by air_weekday
      if (airWeekdayFilter.length > 0) {
        results = results.filter(r => {
          const wd = weekdayFromDate(parseStartDate(r.start_date));
          return airWeekdayFilter.includes(wd);
        });
      }

      // Sort
      if (sort === 'rank') {
        results.sort((a, b) => (b.average_score || 0) - (a.average_score || 0));
      } else if (sort === 'date') {
        results.sort((a, b) => {
          const da = parseStartDate(a.start_date);
          const db = parseStartDate(b.start_date);
          if (!da && !db) return 0;
          if (!da) return 1;
          if (!db) return -1;
          return formatDate(db).localeCompare(formatDate(da));
        });
      } else {
        // heat or default
        results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
      }

      const total = results.length;
      const paged = results.slice(offset, offset + limit);
      const data = paged.map(metaToSubject);

      res.json({ data, total });
    } catch (e) {
      console.error('[kazumi] search error:', e.message);
      res.json({ data: [], total: 0 });
    }
  });

  // ===== 2. Subject Detail =====
  // GET /kazumi/p1/subjects/:id
  router.get('/p1/subjects/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id || isNaN(id)) return res.status(404).json({ error: 'Not found' });
      const meta = database.getAnimeMetaById(id);
      if (!meta) return res.status(404).json({ error: 'Not found' });
      res.json(metaToSubject(meta));
    } catch (e) {
      console.error('[kazumi] subject error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ===== 3. Calendar =====
  // GET /kazumi/p1/calendar
  router.get('/p1/calendar', async (req, res) => {
    try {
      const calendar = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
      const result = await buildAiringSchedule(database, httpFetch);
      const schedule = result.schedule || {};
      const weekKeys = Object.keys(schedule);
      for (let i = 0; i < 7; i++) {
        const key = weekKeys[i];
        const list = key ? schedule[key] || [] : [];
        calendar[i + 1] = uniqueSubjects(list.map(oiResultToSubject));
      }
      res.json(calendar);
    } catch (e) {
      console.error('[kazumi] calendar error:', e.message);
      res.json({ 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] });
    }
  });

  // ===== 4. Trending =====
  // GET /kazumi/p1/trending/subjects
  router.get('/p1/trending/subjects', (req, res) => {
    try {
      const type = parseInt(req.query.type) || 2;
      const limit = parseInt(req.query.limit) || 24;
      const offset = parseInt(req.query.offset) || 0;

      let results = [];
      // Use ranking data with popularity score as trending signal
      const rankings = database.getRankingsFromDb('trending', 100, currentSeason());
      if (rankings.length === 0) {
        // Fallback to browse
        const browse = database.getBrowseFromDb({}, 1, 100);
        results = browse.results || [];
      } else {
        results = rankings;
      }

      const total = results.length;
      const paged = results.slice(offset, offset + limit);
      const data = paged.map(meta => ({
        subject: metaToSubject(meta)
      }));

      res.json({ data, total });
    } catch (e) {
      console.error('[kazumi] trending error:', e.message);
      res.json({ data: [], total: 0 });
    }
  });

  // ===== 5. Popular Subjects (Mirror) =====
  // GET /kazumi/v1/popular/subjects
  router.get('/v1/popular/subjects', (req, res) => {
    try {
      const tag = req.query.tag || '';
      const year = req.query.year ? parseInt(req.query.year) : null;
      const season = req.query.season || '';
      const limit = parseInt(req.query.limit) || 24;
      const offset = parseInt(req.query.offset) || 0;

      let results;
      if (tag || year || season) {
        // Search by genre tag
        const browse = database.getBrowseFromDb({ genre: tag, year, season }, 1, 200);
        results = browse.results || [];
      } else {
        // General popular
        const rankings = database.getRankingsFromDb('popular', 100);
        if (rankings.length === 0) {
          const browse = database.getBrowseFromDb({}, 1, 100);
          results = browse.results || [];
        } else {
          results = rankings;
        }
      }

      const paged = results.slice(offset, offset + limit);
      res.json(paged.map(metaToSubject));
    } catch (e) {
      console.error('[kazumi] popular error:', e.message);
      res.json([]);
    }
  });

  // ===== 5.1 AniWorld Home Sections =====
  // GET /kazumi/v1/aniworld/section?type=today|newseason|popular|hot|classic|movie|daily|weekly
  router.get('/v1/aniworld/section', async (req, res) => {
    try {
      const type = String(req.query.type || 'popular').toLowerCase();
      const limit = Math.min(parseInt(req.query.limit) || 18, 50);

      if (type === 'today') {
        const result = await buildAiringSchedule(database, httpFetch);
        const schedule = result.schedule || {};
        const weekKeys = Object.keys(schedule);
        const todayIndex = (hkWeekday() + 6) % 7; // Monday-first
        const todayKey = weekKeys[todayIndex];
        const todayList = todayKey ? schedule[todayKey] || [] : [];
        return res.json(uniqueSubjects(todayList.map(oiResultToSubject)).slice(0, limit));
      }

      const rows = type === 'daily'
        ? await getDailyTrendingMeta(database, httpFetch, limit)
        : type === 'weekly'
          ? await getWeeklyTrendingMeta(database, httpFetch, limit)
          : getSectionMeta(database, type, limit);
      res.json(uniqueSubjects(rows.map(metaToSubject)).slice(0, limit));
    } catch (e) {
      console.error('[kazumi] aniworld section error:', e.message);
      res.json([]);
    }
  });

  // POST /kazumi/v1/aniworld/subjects/resolve
  // Refreshes metadata for locally persisted App cards in one round trip.
  // Title fallback also migrates collections saved with legacy Bangumi IDs.
  router.post('/v1/aniworld/subjects/resolve', (req, res) => {
    try {
      const items = Array.isArray(req.body?.items)
        ? req.body.items.slice(0, 200)
        : [];
      const resolved = items.map(item => {
        const requestedId = Number.parseInt(item?.id, 10) || 0;
        const title = String(item?.oiMsg || item?.title || '').trim();
        const expectedYear = item?.year || item?.airDate || '';
        let meta = requestedId > 0
          ? database.getAnimeMetaById(requestedId)
          : null;
        if (meta && expectedYear) {
          const verified = resolveAnimeMetadata({
            searchAnimeMetaByTitle: () => [meta]
          }, title, {
            year: expectedYear,
            requireExactTitle: true
          });
          if (!verified) meta = null;
        }
        if (!meta && title) {
          meta = resolveAnimeMetadata(database, title, {
            year: expectedYear,
            requireExactTitle: true
          });
        }
        return meta
          ? { requestedId, subject: metaToSubject(meta) }
          : null;
      }).filter(Boolean);
      res.set('Cache-Control', 'no-store');
      res.json(resolved);
    } catch (e) {
      console.error('[kazumi] aniworld subjects resolve error:', e.message);
      res.json([]);
    }
  });

  // GET /kazumi/v1/aniworld/home?limit=18
  // A single payload removes four extra authenticated round trips from the
  // Flutter home screen. Most sections are local DB reads; the airing schedule
  // already has its own short-lived service cache.
  router.get('/v1/aniworld/home', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 18, 50);
      let todayList = [];
      try {
        const result = await buildAiringSchedule(database, httpFetch);
        const schedule = result.schedule || {};
        const weekKeys = Object.keys(schedule);
        const todayIndex = (hkWeekday() + 6) % 7;
        const todayKey = weekKeys[todayIndex];
        todayList = todayKey ? schedule[todayKey] || [] : [];
      } catch (e) {
        console.warn('[kazumi] home airing schedule unavailable:', e.message);
      }
      const section = (type, sectionLimit = limit) => uniqueSubjects(
        getSectionMeta(database, type, sectionLimit).map(metaToSubject)
      ).slice(0, sectionLimit);

      res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
      res.json({
        generatedAt: new Date().toISOString(),
        today: uniqueSubjects(todayList.map(oiResultToSubject)).slice(0, limit),
        recommend: section('popular'),
        newSeason: section('newseason'),
        hot: section('hot'),
        classic: section('classic'),
        movies: section('movie', 10)
      });
    } catch (e) {
      console.error('[kazumi] aniworld home error:', e.message);
      res.status(500).json({ error: 'HOME_UNAVAILABLE' });
    }
  });

  // GET /kazumi/v1/aniworld/browse?genre=&year=&month=&season=&format=&sort=&page=&limit=
  router.get('/v1/aniworld/browse', (req, res) => {
    try {
      const genre = String(req.query.genre || '');
      const year = req.query.year ? parseInt(req.query.year) : null;
      const requestedMonth = req.query.month ? parseInt(req.query.month) : null;
      const month = requestedMonth >= 1 && requestedMonth <= 12 ? requestedMonth : null;
      const season = String(req.query.season || '');
      const requestedFormat = String(req.query.format || '').toUpperCase();
      const format = ['TV', 'MOVIE'].includes(requestedFormat) ? requestedFormat : '';
      const requestedSort = String(req.query.sort || 'latest').toLowerCase();
      const sort = ['latest', 'popular', 'rating'].includes(requestedSort)
        ? requestedSort
        : 'latest';
      const page = Math.max(parseInt(req.query.page) || 1, 1);
      const limit = Math.min(parseInt(req.query.limit) || 24, 50);
      const data = database.getBrowseFromDb(
        { genre, year, month, season, format, sort },
        page,
        limit
      );
      const results = uniqueSubjects((data.results || []).map(metaToSubject));
      res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      res.json({
        data: results,
        total: data.total || results.length,
        page,
        hasMore: !!data.hasMore,
        filters: {
          genre,
          year: year || '',
          month: month || '',
          season,
          format,
          sort
        }
      });
    } catch (e) {
      console.error('[kazumi] aniworld browse error:', e.message);
      res.json({ data: [], total: 0, page: 1, hasMore: false });
    }
  });

  // ===== 6. Season Calendar (Mirror) =====
  // GET /kazumi/v1/calendar/season
  router.get('/v1/calendar/season', async (req, res) => {
    try {
      const start = req.query.start || '';
      const end = req.query.end || '';

      // Parse date range to determine season/year
      let year, season;
      if (start) {
        const d = new Date(start);
        const parts = hkDateParts(d);
        year = parts.year;
        const m = parts.month;
        if (m >= 1 && m <= 3) season = 'WINTER';
        else if (m >= 4 && m <= 6) season = 'SPRING';
        else if (m >= 7 && m <= 9) season = 'SUMMER';
        else season = 'FALL';
      } else {
        const now = new Date();
        const parts = hkDateParts(now);
        year = parts.year;
        const m = parts.month;
        if (m >= 1 && m <= 3) season = 'WINTER';
        else if (m >= 4 && m <= 6) season = 'SPRING';
        else if (m >= 7 && m <= 9) season = 'SUMMER';
        else season = 'FALL';
      }

      const calendar = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };

      // For the active season this endpoint is an update calendar, not merely
      // a list of titles whose premiere date falls inside the quarter. Reuse
      // the rolling schedule so previous-season two-cour shows are included
      // and grouped by their actual next-airing weekday.
      const [currentSeason] = getCurrentSeasonInfo();
      if (year === currentSeason.seasonYear && season === currentSeason.season) {
        const result = await buildAiringSchedule(database, httpFetch);
        const schedule = result.schedule || {};
        const weekKeys = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
        for (let i = 0; i < weekKeys.length; i++) {
          calendar[i + 1] = uniqueSubjects(
            (schedule[weekKeys[i]] || []).map(oiResultToSubject)
          );
        }
        return res.json(calendar);
      }

      const seen = new Set();

      // Get anime for this season
      const seasonal = database.getAnimeMetaBySeason ?
        database.getAnimeMetaBySeason(season, year, 200) : [];

      // Also get from browse
      const browse = database.getBrowseFromDb({ year, season }, 1, 200);
      const allResults = [...seasonal, ...(browse.results || [])];

      for (const meta of allResults) {
        if (seen.has(meta.anilist_id)) continue;
        seen.add(meta.anilist_id);
        const wd = weekdayFromDate(parseStartDate(meta.start_date));
        if (wd >= 1 && wd <= 7) {
          calendar[wd].push({
            ...wrapCalendarItem(meta),
            sort: meta.popularity || 0
          });
        }
      }

      for (let d = 1; d <= 7; d++) {
        calendar[d].sort((a, b) => (b.sort || 0) - (a.sort || 0));
        calendar[d].forEach(item => delete item.sort);
      }

      res.json(calendar);
    } catch (e) {
      console.error('[kazumi] season calendar error:', e.message);
      res.json({ 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] });
    }
  });

  // ===== 7. Episodes =====
  // GET /kazumi/v0/episodes
  router.get('/v0/episodes', (req, res) => {
    try {
      const subjectId = parseInt(req.query.subject_id);
      const offset = parseInt(req.query.offset) || 0;
      const limit = parseInt(req.query.limit) || 100;

      if (!subjectId || isNaN(subjectId)) {
        return res.json({ data: [], total: 0 });
      }

      const meta = database.getAnimeMetaById(subjectId);
      if (!meta) return res.json({ data: [], total: 0 });

      const totalEpisodes = meta.episodes || 0;
      if (totalEpisodes <= 0) return res.json({ data: [], total: 0 });

      // Generate episode list
      const episodes = [];
      const start = offset + 1;
      const end = Math.min(start + limit - 1, totalEpisodes);

      for (let i = start; i <= end; i++) {
        episodes.push({
          id: subjectId * 10000 + i,
          type: 0,
          name: `第${i}集`,
          name_cn: `第${i}集`,
          sort: i,
          airdate: meta.start_date ? formatDate(parseStartDate(meta.start_date)) : '',
          status: 'Air',
          duration: '00:24:00'
        });
      }

      res.json({ data: episodes, total: totalEpisodes });
    } catch (e) {
      console.error('[kazumi] episodes error:', e.message);
      res.json({ data: [], total: 0 });
    }
  });

  // ===== 8. Characters =====
  // GET /kazumi/v0/subjects/:id/characters
  router.get('/v0/subjects/:id/characters', async (req, res) => {
    try {
      const media = await queryAniListMedia(req.params.id);
      const edges = media?.characters?.edges || [];
      const results = edges.map(edge => {
        const node = edge.node || {};
        const image = node.image?.large || node.image?.medium || '';
        const actors = (edge.voiceActors || []).slice(0, 2).map(actor => {
          const actorImage = actor.image?.large || actor.image?.medium || '';
          return {
            id: actor.id || 0,
            type: 1,
            name: aniListName(actor.name),
            images: imagePack(actorImage)
          };
        });
        return {
          id: node.id || 0,
          type: 1,
          name: aniListName(node.name),
          relation: roleLabel(edge.role),
          images: imagePack(image),
          actors
        };
      }).filter(item => item.name);
      res.json(results);
    } catch (e) {
      console.error('[kazumi] characters error:', e.message);
      res.json([]);
    }
  });

  // ===== 9. Subject Comments =====
  // GET /kazumi/p1/subjects/:id/comments
  router.get('/p1/subjects/:id/comments', (req, res) => {
    res.json({ data: [], total: 0 });
  });

  // ===== 10. Episode Comments =====
  // GET /kazumi/p1/episodes/:id/comments
  router.get('/p1/episodes/:id/comments', (req, res) => {
    res.json([]);
  });

  // ===== 11. Character Info =====
  // GET /kazumi/p1/characters/:id
  router.get('/p1/characters/:id', async (req, res) => {
    try {
      const character = await queryAniListCharacter(req.params.id);
      const detail = characterToDetail(character, req.params.id);
      if (!detail) return res.status(404).json({ error: '角色不存在' });
      return res.json(detail);
    } catch (e) {
      console.error('[kazumi] character info error:', e.message);
      return res.status(502).json({ error: '角色资料暂时不可用' });
    }
  });

  // ===== 12. Character Comments =====
  // GET /kazumi/p1/characters/:id/comments
  router.get('/p1/characters/:id/comments', (req, res) => {
    res.json([]);
  });

  // ===== 13. Staff =====
  // GET /kazumi/p1/subjects/:id/staffs/persons
  router.get('/p1/subjects/:id/staffs/persons', async (req, res) => {
    try {
      const media = await queryAniListMedia(req.params.id);
      const characterEdges = media?.characters?.edges || [];
      const staffEdges = media?.staff?.edges || [];
      const voiceActors = [];
      const seenVoice = new Set();
      for (const edge of characterEdges) {
        const characterName = aniListName(edge.node?.name);
        for (const actor of (edge.voiceActors || []).slice(0, 1)) {
          if (!actor?.id || seenVoice.has(actor.id)) continue;
          seenVoice.add(actor.id);
          const actorImage = actor.image?.large || actor.image?.medium || '';
          voiceActors.push({
            staff: {
              id: actor.id,
              name: aniListName(actor.name),
              nameCN: '',
              type: 1,
              info: '',
              comment: 0,
              lock: false,
              nsfw: false,
              images: imagePack(actorImage)
            },
            positions: [{
              type: { id: 0, en: 'Voice Actor', cn: characterName ? `声优 · ${characterName}` : '声优', jp: '声優' },
              summary: '',
              appearEps: ''
            }]
          });
        }
      }
      const staffs = staffEdges.slice(0, 12).map(edge => {
        const node = edge.node || {};
        const staffImage = node.image?.large || node.image?.medium || '';
        return {
          staff: {
            id: node.id || 0,
            name: aniListName(node.name),
            nameCN: '',
            type: 1,
            info: '',
            comment: 0,
            lock: false,
            nsfw: false,
            images: imagePack(staffImage)
          },
          positions: [{
            type: { id: 0, en: edge.role || '', cn: edge.role || '制作人员', jp: edge.role || '' },
            summary: '',
            appearEps: ''
          }]
        };
      }).filter(item => item.staff.name);
      const data = [...voiceActors, ...staffs].slice(0, 36);
      res.json({ data, total: data.length });
    } catch (e) {
      console.error('[kazumi] staffs error:', e.message);
      res.json({ data: [], total: 0 });
    }
  });

  // Bangumi OAuth and ID mapping are not implemented by this compatibility API.
  const unavailableCollection = (_req, res) => res.status(503).json({
    error: 'Bangumi 账号同步暂不可用，请使用 AniWorld 账号追番',
    code: 'BANGUMI_SYNC_UNAVAILABLE'
  });
  router.get('/v0/me', unavailableCollection);
  router.get('/v0/users/:username/collections', unavailableCollection);
  router.post('/v0/users/-/collections/:id', unavailableCollection);

  app.use('/kazumi', router);
  console.log('[kazumi] Routes mounted: /kazumi/v0/* and /kazumi/p1/* and /kazumi/v1/*');
}

// Fallback search when no keyword provided
function searchAllAnime(database, limit) {
  try {
    const browse = database.getBrowseFromDb({}, 1, limit);
    return browse.results || [];
  } catch (e) {
    return [];
  }
}

module.exports = {
  getSectionMeta,
  getDailyTrendingMeta,
  getWeeklyTrendingMeta,
  trendPeriodKey,
  nextTrendRefreshAt,
  mountKazumiRoutes,
  currentYearFilter
};
