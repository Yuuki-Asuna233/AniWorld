const { buildMergedSearchResults, buildPureSearchResults } = require('../services/catalogue-search');
const { getAnimeDetails, enrichSearchResultsWithAniListMeta } = require('../services/catalogue');
const { animeCoverFields, withAnimeCovers } = require('../services/anime-covers');
const { isAgentAdmin } = require('../services/agent-telemetry');
// OIAPI routes: search, details, play, probe, sources, franchise, trending, newseason, classic,
// today, calendar, rankings, browse, bridge, genres, meta

const { findAlias, findChinese } = require('../../anime-titles');
const {
  filterChineseResults,
  extractSeasonFromTitle, normalizeSeasonNumber
} = require('../utils/chinese');
const { getCurrentSeasonInfo, hkWeekday } = require('../utils/date');
const { dbMetaToResult, hasDbDataForYear } = require('../utils/db-helpers');
const { getOrSetCache } = require('../services/cache');
const {
  OI_BASE, generateOiMsgCandidates, selectBestOiResult,
  fetchOiCategory
} = require('../services/oi-helpers');
// oi-bridge.js removed — Chinese titles are now resolved during sync
const { syncAnimeMetaFromAniList, buildAiringSchedule } = require('../services/sync');
const {
  reconcileAiringWithOi
} = require('../services/airing-reconcile');
const {
  resolveAnimeMetadata,
  animeFranchiseSearchTitle,
  animeFranchiseSearchQueries,
  titlesShareAnimeFranchise
} = require('../services/anime-identity');
const { mountOiPlaybackRoutes } = require('./oiapi-playback');

const POPULAR_ANIME = [
  '鬼灭之刃', '咒术回战', '间谍过家家', '葬送的芙莉莲', 'Re:ZERO',
  '进击的巨人', '我推的孩子', '孤独摇滚', '死神 千年血战篇', '无职转生',
  '关于我转生变成史莱姆这档事', '辉夜大小姐想让我告白', '小林家的龙女仆', '迷宫饭',
  '排球少年', '灵能百分百', '电锯人', '文豪野犬', '约定的梦幻岛', '宝石之国'
];


const CLASSIC_ANIME = [
  '火影忍者', '海贼王', '名侦探柯南', '龙珠', '钢之炼金术师',
  'clannad', '命运石之门', '魔法少女小圆', '新世纪福音战士', '星际牛仔'
];

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function fetchCategoryFromDbByTitles(database, titles, limit) {
  const results = [];
  const seen = new Set();
  for (const title of titles) {
    if (results.length >= limit) break;
    const rows = database.searchAnimeMetaByTitle(title, 5);
    for (const row of rows) {
      const key = row.anilist_id || row.title_chinese;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(dbMetaToResult(row));
      break;
    }
  }
  return filterChineseResults(results).slice(0, limit);
}

/**
 * Attach a canonical AniList ID — plus the metadata both clients read off a
 * search card — only after the same identity check the details route uses, so a
 * card and its detail page agree on one stable ID instead of a title hash or a
 * list position.
 */
function mountOiapiRoutes(app, { database, httpFetch, cache: cacheObj, requireAuth }) {
  mountOiPlaybackRoutes(app);
  const withCover = item => ({ ...item, ...animeCoverFields(item, { database }) });

  // ==================== Search ====================
  app.get('/api/oi/search', async (req, res) => {
    const q = String(req.query.q || req.query.msg || '').trim();
    if (!q) return res.json({ results: [], total: 0 });
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');

    const pureOi = req.query.pure === '1';

    const cacheKey = pureOi
      ? `search_pure_v4_${JSON.stringify(q.toLowerCase())}`
      : `search_v9_${JSON.stringify(q.toLowerCase())}`;
    const cacheTtl = 10 * 60 * 1000;
    const refresh = req.query.refresh === '1';
    if (refresh) res.set('Cache-Control', 'no-store');
    try {
      const response = await getOrSetCache(cacheObj, cacheKey, cacheTtl, async () => {
        if (pureOi) return buildPureSearchResults(q, { database, httpFetch });
        return buildMergedSearchResults(q, { database, httpFetch });
      }, { refresh, cacheWhen: value => value.results.length > 0 && !value.degraded });
      if (response.degraded || !response.results.length) res.set('Cache-Control', 'no-store');
      if (response.degraded && !response.results.length) {
        return res.status(502).json({ error: '搜索源暂不可用，请稍后重试' });
      }
      res.json(response);
    } catch (error) {
      res.set('Cache-Control', 'no-store');
      res.status(502).json({ error: '搜索服务暂不可用' });
    }
  });

  // ==================== Details ====================
  app.get('/api/oi/details', async (req, res) => {
    try { res.json(await getAnimeDetails(req.query, { database, httpFetch, cache: cacheObj })); }
    catch (error) { res.status(error.status || 502).json({ error: error.message }); }
  });

  // ==================== Recommend ====================
  app.get('/api/oi/recommend', async (req, res) => {
    const { genres, excludeId } = req.query;
    const genreList = (genres || '').split(',').map(g => g.trim()).filter(Boolean);
    try {
      let dbResults;
      const excludeNid = parseInt(excludeId) || 0;
      const candidateLimit = excludeNid ? 11 : 10;
      if (genreList.length > 0) dbResults = database.getBrowseFromDb({ genre: genreList[0] }, 1, candidateLimit);
      else dbResults = database.getRankingsFromDb('popular', candidateLimit);

      const rows = Array.isArray(dbResults) ? dbResults : dbResults.results || [];
      let rawResults = rows.map(dbMetaToResult);
      if (excludeNid) rawResults = rawResults.filter(r => r.id !== `anilist_${excludeNid}`);
      rawResults = rawResults.slice(0, 10);
      // Chinese titles pre-resolved during sync

      const results = rawResults.map(r => ({
        id: r.id, title: r.title || '未知', romaji: r.romajiTitle || '',
        nativeTitle: r.nativeTitle || '', englishTitle: r.englishTitle || '',
        image: r.image || '', coverFallback: r.coverFallback || '', score: r.score || 0, seasonYear: r.seasonYear || '',
        episodes: r.episodes || '?', status: r.status || 'UNKNOWN', format: r.format || '',
        oiMsg: r.oiMsg || r.title || '', oiIndex: r.oiIndex || 1
      }));
      res.json({ results });
    } catch (e) { res.json({ results: [] }); }
  });

  // ==================== Franchise ====================
  app.get('/api/oi/franchise', async (req, res) => {
    let { msg } = req.query;
    if (!msg) return res.json({ entries: [] });
    const aliased = findAlias(msg);
    if (aliased) msg = aliased;
    try {
      let effectiveQuery = animeFranchiseSearchTitle(msg) || msg;
      const fetchEntries = async query => {
        const r = await httpFetch(`${OI_BASE}?msg=${encodeURIComponent(query)}`, { timeout: 10000 });
        if (!(r.status === 200 && r.data?.code === 200)) return [];
        const list = Array.isArray(r.data.data) ? r.data.data : [];
        return list.map((a, i) => {
          let type = 'TV';
          const name = a.name || '';
          if (/剧场版|电影/.test(name)) type = '剧场版';
          else if (/OVA|OAD/.test(name)) type = 'OVA';
          else if (/特别篇|总集篇|SP/.test(name)) type = '特别篇';
          else if (/季|Season/.test(name)) type = 'TV';
          return { index: i+1, title: name, image: a.image||'', year: a.year||'', ji: a.ji||'', type };
        });
      };

      let entries = await fetchEntries(effectiveQuery);
      if (entries.length <= 1 && effectiveQuery.length > 4) {
        for (const query of animeFranchiseSearchQueries(effectiveQuery)) {
          const candidate = await fetchEntries(query);
          if (candidate.length > entries.length) {
            entries = candidate;
            effectiveQuery = query;
          }
        }
      }
      entries = entries.filter(entry => titlesShareAnimeFranchise(effectiveQuery, entry.title));
      enrichSearchResultsWithAniListMeta(entries, database);
      const order = {'TV':0,'OVA':1,'剧场版':2,'特别篇':3};
      entries.sort((a,b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
      return res.json({
        entries,
        total: entries.length,
        currentIndex: parseInt(req.query.n)||1,
        query: effectiveQuery
      });
    } catch (e) {}
    res.json({ entries: [] });
  });

  // ==================== Category: Trending ====================
  app.get('/api/oi/trending', async (req, res) => {
    const CACHE_KEY = 'oi_trending', CACHE_TTL = 10*60*1000;
    try {
      const cached = await getOrSetCache(cacheObj, CACHE_KEY, CACHE_TTL, async () => {
        let results = await fetchOiCategory(POPULAR_ANIME, httpFetch, 14);
        if (!results.length) results = fetchCategoryFromDbByTitles(database, POPULAR_ANIME, 14);
        results = withAnimeCovers(results, database);
        const data = { results, total: results.length };
        return data;
      }, { cacheWhen: value => value.results.length > 0 });
      res.json(cached);
    } catch (e) { res.json({ results: [], total: 0 }); }
  });

  // ==================== Category: New Season ====================
  app.get('/api/oi/newseason', async (req, res) => {
    const CACHE_KEY = 'oi_newseason', CACHE_TTL = 30*60*1000;
    try {
      const cached = await getOrSetCache(cacheObj, CACHE_KEY, CACHE_TTL, async () => {
        const [currentSeason] = getCurrentSeasonInfo();
        const dbResults = database.getAnimeMetaBySeason(currentSeason.season, currentSeason.seasonYear, 18);
        let results = dbResults.map(dbMetaToResult);
        // Chinese titles pre-resolved during sync
        results = filterChineseResults(results);
        results.sort((a,b) => (b.score||0)-(a.score||0));
        results = results.slice(0, 15);
        const out = { results, total: results.length, source:'db', season:currentSeason };
        return out;
      }, { cacheWhen: value => value.results.length > 0 });
      res.json(cached);
    } catch (e) { res.json({ results: [], total: 0 }); }
  });

  // ==================== Category: Classic ====================
  app.get('/api/oi/classic', async (req, res) => {
    const CACHE_KEY = 'oi_classic', CACHE_TTL = 30*60*1000;
    try {
      const cached = await getOrSetCache(cacheObj, CACHE_KEY, CACHE_TTL, async () => {
        let results = await fetchOiCategory(CLASSIC_ANIME, httpFetch, 10);
        if (!results.length) results = fetchCategoryFromDbByTitles(database, CLASSIC_ANIME, 10);
        results = withAnimeCovers(results, database);
        const data = { results, total: results.length };
        return data;
      }, { cacheWhen: value => value.results.length > 0 });
      res.json(cached);
    } catch (e) { res.json({ results: [], total: 0 }); }
  });

  // ==================== Today ====================
  app.get('/api/oi/today', async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    try {
      const data = await getOrSetCache(cacheObj, 'oi_today_v4', 30 * 1000, async () => {
        const { schedule } = await buildAiringSchedule(database, httpFetch);
        const todayDay = DAY_NAMES[hkWeekday()];
        const todayList = schedule[todayDay] || [];
        const results = todayList.map(r => ({
          ...r,
          nextAiring: r.rawAniListData?.nextAiringEpisode
            ? { episode: r.rawAniListData.nextAiringEpisode.episode, time: r.rawAniListData.nextAiringEpisode.airingAt }
            : null
        }));
        results.forEach(r => { delete r.rawAniListData; });
        return { results, total: results.length };
      }, { name: 'oi_today' });
      res.json(data);
    } catch (e) { res.json({ results: [], total: 0 }); }
  });

  // ==================== Calendar ====================
  app.get('/api/oi/calendar', async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    try {
      const data = await getOrSetCache(cacheObj, 'oi_calendar_v4', 30 * 1000, async () => {
        const result = await buildAiringSchedule(database, httpFetch);
        for (const day of Object.keys(result.schedule))
          result.schedule[day].forEach(r => { delete r.rawAniListData; });
        return result;
      }, { name: 'oi_calendar' });
      res.json(data);
    } catch (e) { res.json({ schedule: {}, total: 0 }); }
  });

  // ==================== Rankings ====================
  app.get('/api/oi/rankings', async (req, res) => {
    const type = req.query.type || 'popular';
    const [currentSeason] = getCurrentSeasonInfo();
    const seasonPart = type === 'trending' ? `_${currentSeason.season}_${currentSeason.seasonYear}` : '';
    const cacheKey = `rankings_v7_${type}${seasonPart}`, cacheTtl = 30*60*1000;
    try {
      const cached = await getOrSetCache(cacheObj, cacheKey, cacheTtl, async () => {
        const dbResults = database.getRankingsFromDb(type, 20, currentSeason);
        let results = dbResults.map(dbMetaToResult);
        // Chinese titles pre-resolved during sync
        results = filterChineseResults(results);
        const response = { results, total: results.length, type, source:'db', season: type === 'trending' ? currentSeason : null };
        return response;
      }, { cacheWhen: value => value.results.length > 0 });
      res.json(cached);
    } catch (e) { res.json({ results: [], total: 0 }); }
  });

  // ==================== Browse ====================
  app.get('/api/oi/browse', async (req, res) => {
    const genre = req.query.genre || '';
    const year = req.query.year ? parseInt(req.query.year) : null;
    const requestedMonth = req.query.month ? parseInt(req.query.month) : null;
    const month = requestedMonth >= 1 && requestedMonth <= 12 ? requestedMonth : null;
    const season = req.query.season || '';
    const page = parseInt(req.query.page) || 1;
    const perPage = Math.min(parseInt(req.query.perPage) || 24, 50);

    const pageCacheKey = `browse_v15_${genre}_${year}_${month}_${season}_${page}_${perPage}`;
    const cacheTtl = 15*60*1000, emptyCacheTtl = 2*60*1000;
    try {
      const data = await getOrSetCache(cacheObj, pageCacheKey, cacheTtl, async () => {
        let dbResult = database.getBrowseFromDb({ genre, year, month, season }, page, perPage, { strict: true });
        const reconcile = await reconcileAiringWithOi(database, httpFetch, dbResult.results);
        if (reconcile.updated > 0) {
          dbResult = database.getBrowseFromDb({ genre, year, month, season }, page, perPage, { strict: true });
        }
        let results = dbResult.results.map(dbMetaToResult);
        // Chinese titles pre-resolved during sync
        results = filterChineseResults(results);
        const response = { results, total: dbResult.total, page, hasMore: dbResult.hasMore, filters: { genre, year, month, season }, source:'db' };
        return response;
      }, { ttlFor: value => value.results.length ? cacheTtl : emptyCacheTtl });
      res.json(data);
    } catch (e) {
      res.json({ results: [], total: 0 });
    }
  });

  // ==================== Meta Search ====================
  app.get('/api/oi/meta/search', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 1) return res.json({ results: [], total: 0 });
    try {
      if (hasDbDataForYear(database, 2010)) {
        const dbResults = database.searchAnimeMetaByTitle(q, 30);
        if (dbResults.length > 0) {
          let results = dbResults.map(dbMetaToResult);
          results = results.map(r => {
            if (r.oiMsg && r.oiIndex) { r.oiResolved = true; r.source = 'oiapi'; }
            return r;
          });
          return res.json({ results, total: results.length, source:'db' });
        }
      }
      res.json({ results: [], total: 0, source:'db_empty' });
    } catch (e) { res.json({ results: [], total: 0 }); }
  });

  // ==================== Meta Stats ====================
  app.get('/api/oi/meta/stats', (req, res) => {
    try {
      const total = database.getAnimeMetaCount();
      const withOi = database.getAnimeMetaWithOiMsgCount();
      res.json({ total, withOiMsg: withOi });
    } catch (e) { res.json({ total: 0, withOiMsg: 0 }); }
  });

  // ==================== Meta Sync (force) ====================
  app.post('/api/oi/meta/sync', requireAuth, async (req, res) => {
    if (!isAgentAdmin(req, database)) return res.status(403).json({ error: '需要管理员权限' });
    res.json({ message: 'Sync started in background' });
    syncAnimeMetaFromAniList(database, httpFetch, true).catch(e => console.error('[sync] Full sync error:', e.message));
  });

  // ==================== Genres ====================
  app.get('/api/oi/genres', async (req, res) => {
    const genreMap = {
      'Action':'动作','Adventure':'冒险','Comedy':'喜剧','Drama':'剧情',
      'Ecchi':'福利','Fantasy':'奇幻','Hentai':'成人',
      'Horror':'恐怖','Mahou Shoujo':'魔法少女','Mecha':'机战','Music':'音乐',
      'Mystery':'悬疑','Psychological':'心理','Romance':'恋爱','Sci-Fi':'科幻',
      'Slice of Life':'日常','Sports':'运动','Supernatural':'超自然','Thriller':'惊悚',
      'Yuri':'百合','Iyashikei':'治愈','Harem':'后宫'
    };
    const genres = ['Action','Adventure','Comedy','Drama','Ecchi','Fantasy','Hentai','Horror','Mahou Shoujo','Mecha','Music','Mystery','Psychological','Romance','Sci-Fi','Slice of Life','Sports','Supernatural','Thriller'];
    const tags = ['Yuri','Iyashikei','Harem'];
    res.json({
      genres: [...genres.map(g => ({ key:g, label:genreMap[g]||g, type:'genre' })),
              ...tags.map(t => ({ key:t, label:genreMap[t]||t, type:'tag' }))]
    });
  });

  // ==================== Bridge (AniList → OIAPI) ====================
  app.get('/api/oi/bridge', async (req, res) => {
    let { title, romaji, english, native, seasonInfo: seasonInfoParam } = req.query;
    let seasonInfo = seasonInfoParam || extractSeasonFromTitle(romaji, english, native);

    const aliased = findAlias(title || native || romaji || english || '');
    if (aliased) {
      try {
        const r = await httpFetch(`${OI_BASE}?msg=${encodeURIComponent(aliased)}`, { timeout: 8000 });
        if (r.status === 200 && r.data?.code === 200) {
          const list = Array.isArray(r.data.data) ? r.data.data : [];
          if (list.length > 0) {
            const bestIdx = selectBestOiResult(list, aliased, seasonInfo);
            return res.json(withCover({ found:true, msg:aliased, n:bestIdx+1, title:list[bestIdx].name||aliased, image:list[bestIdx].image||'', ji:list[bestIdx].ji||'', year:list[bestIdx].year||'' }));
          }
        }
      } catch (e) {}
    }

    const chinese = findChinese(romaji, english, native, title);
    if (chinese) {
      const titleWithSeason = seasonInfo && !chinese.includes(seasonInfo) ? chinese + ' ' + seasonInfo : chinese;
      const normalizedChinese = normalizeSeasonNumber(chinese);
      const normalizedTitleWithSeason = normalizeSeasonNumber(titleWithSeason);
      const variants = [normalizedTitleWithSeason, normalizedChinese];
      const fullWidth = normalizeSeasonNumber(chinese.replace(/:/g, '：'));
      if (fullWidth !== normalizedChinese && fullWidth !== normalizedTitleWithSeason) variants.push(fullWidth);
      const noPrefix = normalizeSeasonNumber(chinese.replace(/^Re:/i, '').replace(/^Re：/i, '').trim());
      if (noPrefix !== normalizedChinese && noPrefix.length >= 2) variants.push(noPrefix);
      const baseName = normalizeSeasonNumber(chinese.replace(/\s*(第[一二三四五六七八九十\d]+季|Season\s*\d+|Final\s*Season).*/i, '').trim());
      if (baseName !== normalizedChinese && baseName.length >= 2) variants.push(baseName);

      for (const v of variants) {
        try {
          const r = await httpFetch(`${OI_BASE}?msg=${encodeURIComponent(v)}`, { timeout: 8000 });
          if (r.status === 200 && r.data?.code === 200) {
            const list = Array.isArray(r.data.data) ? r.data.data : [];
            if (list.length > 0) {
              const bestIdx = selectBestOiResult(list, v, seasonInfo);
              return res.json(withCover({ found:true, msg:v, n:bestIdx+1, title:list[bestIdx].name||chinese, image:list[bestIdx].image||'', ji:list[bestIdx].ji||'', year:list[bestIdx].year||'' }));
            }
          }
        } catch (e) {}
      }
    }

    const rawTitles = [native, romaji, english, title].filter(Boolean);
    const titles = [];
    const tried = new Set();
    const seen = new Set();
    for (const t of rawTitles) {
      const normalized = normalizeSeasonNumber(t);
      if (!seen.has(normalized)) { seen.add(normalized); titles.push(normalized); }
      const mainPart = t.split(/[：:–—\-～~【\[]/)[0].trim();
      const normalizedMain = normalizeSeasonNumber(mainPart);
      if (normalizedMain && normalizedMain !== normalized && normalizedMain.length >= 2 && !seen.has(normalizedMain)) {
        seen.add(normalizedMain); titles.push(normalizedMain);
      }
    }

    for (const t of titles) {
      if (tried.has(t)) continue;
      tried.add(t);
      try {
        const r = await httpFetch(`${OI_BASE}?msg=${encodeURIComponent(t)}`, { timeout: 8000 });
        if (r.status === 200 && r.data?.code === 200) {
          const list = Array.isArray(r.data.data) ? r.data.data : [];
          if (list.length > 0) {
            const bestIdx = selectBestOiResult(list, t, seasonInfo);
            const a = list[bestIdx];
            return res.json(withCover({ found:true, msg:a.name||t, n:bestIdx+1, title:a.name||t, image:a.image||'', ji:a.ji||'', year:a.year||'' }));
          }
        }
      } catch (e) {}
    }
    res.json({ found: false, title: title || '', titlesTried: [...tried] });
  });

  // ==================== Bridge Resolve (实时解析中文名→OIAPI，30分钟缓存) ====================
  app.get('/api/oi/bridge-resolve', async (req, res) => {
    const title = (req.query.title || '').trim();
    if (!title) return res.json({ found: false });

    const cacheKey = 'br_' + JSON.stringify(title);
    try {
      const data = await getOrSetCache(cacheObj, cacheKey, 30 * 60 * 1000, async () => {
        const r = await httpFetch(OI_BASE + '?msg=' + encodeURIComponent(title), { timeout: 6000 });
        if (r.status !== 200 || r.data?.code !== 200 || !Array.isArray(r.data.data)) {
          throw new Error('桥接服务暂不可用');
        }
        const first = r.data.data[0];
        return first ? { found: true, oiMsg: first.name || title, oiIndex: 1 } : { found: false };
      }, { ttlFor: value => value.found ? 30 * 60 * 1000 : 30 * 1000 });
      res.json(data);
    } catch (error) { res.json({ found: false, degraded: true }); }

  });

}

module.exports = { mountOiapiRoutes };
