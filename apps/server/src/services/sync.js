// Background sync tasks — AniList meta sync + OIAPI resolution

const { getCurrentSeasonInfo, getSeasonSyncWindow, hkWeekday } = require('../utils/date');
const { dbMetaToResult } = require('../utils/db-helpers');
const { cache, getOrSetCache } = require('./cache');
const { invalidateAnimeCaches } = require('./anime-admin');
const { reconcileAiringWithOi } = require('./airing-reconcile');
const {
  containsChinese, containsJapaneseKana, filterChineseResults,
  extractBaseTitle
} = require('../utils/chinese');

const SYNC_INTERVAL = 12 * 60 * 60 * 1000;

const ANILIST_ENDPOINTS = [
  'https://trace.moe/anilist/',
  'https://graphql.anilist.co'
];

let isSyncing = false;

async function anilistQuery(query, httpFetch, variables = {}) {
  for (const endpoint of ANILIST_ENDPOINTS) {
    try {
      const r = await httpFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Origin': 'https://anilist.co',
          'Referer': 'https://anilist.co/'
        },
        body: JSON.stringify({ query, variables }),
        timeout: 15000
      });
      if (r.status === 200 && r.data?.data) return r.data.data;
      console.warn(`[sync] AniList endpoint failed ${endpoint}: HTTP ${r.status}`);
    } catch (e) {
      console.warn(`[sync] AniList endpoint failed ${endpoint}: ${e.message}`);
    }
  }
  return null;
}

async function syncAnimeMetaFromAniList(database, httpFetch, fullSync = false) {
  if (isSyncing) { console.log('[sync] Already syncing, skip'); return; }
  isSyncing = true;
  const startTime = Date.now();
  let totalInserted = 0;

  try {
    // A weekly show can cross a season boundary (for example a two-cour show).
    // Sync the previous season as well so a fresh deployment does not lose
    // still-airing carry-over titles from its calendar.
    const seasonsToSync = getSeasonSyncWindow().map(item => ({
      season: item.season,
      year: item.seasonYear
    }));

    console.log(`[sync] Starting sync: ${seasonsToSync.map(s => s.season + ' ' + s.year).join(', ')} (JP only)`);

    for (const { season, year } of seasonsToSync) {
      let page = 1;
      let hasNext = true;
      while (hasNext && page <= 3) {
        try {
          const data = await anilistQuery(`
            query { Page(page: ${page}, perPage: 50) {
              pageInfo { hasNextPage }
              media(season: ${season}, seasonYear: ${year}, type: ANIME, countryOfOrigin: JP, sort: POPULARITY_DESC) {
                id format status countryOfOrigin
                title { romaji english native }
                synonyms
                coverImage { large }
                averageScore popularity episodes genres
                season seasonYear
                startDate { year month day }
                nextAiringEpisode { episode airingAt }
              }
            }}
          `, httpFetch);

          if (!data?.Page?.media?.length) break;

          const metaList = data.Page.media.map(m => ({
            anilist_id: m.id,
            title_romaji: m.title?.romaji || '',
            title_native: m.title?.native || '',
            cover_image: m.coverImage?.large || '',
            average_score: m.averageScore || 0,
            popularity: m.popularity || 0,
            episodes: m.episodes || 0,
            status: m.status || '',
            format: m.format || '',
            genres: JSON.stringify(m.genres || []),
            season: m.season || season,
            season_year: m.seasonYear || year,
            start_date: m.startDate ? JSON.stringify(m.startDate) : '',
            next_airing_episode: m.nextAiringEpisode?.episode || 0,
            next_airing_at: m.nextAiringEpisode?.airingAt || 0,
            country_of_origin: m.countryOfOrigin || 'JP'
          }));

          // OIAPI resolution disabled — titles are resolved on-demand via bridge-resolve

          const result = database.upsertAnimeMetaBatch(metaList);
          if (result.success) totalInserted += result.count;

          hasNext = data.Page.pageInfo?.hasNextPage || false;
          page++;
          console.log(`[sync]   ${season} ${year} page ${page - 1}: ${metaList.length} anime`);
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          console.error(`[sync] Error fetching ${season} ${year} page ${page}:`, e.message);
          break;
        }
      }
    }
    await reconcileVisibleAiringState(database, httpFetch);
  } catch (e) {
    console.error('[sync] Sync error:', e.message);
  } finally {
    isSyncing = false;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[sync] Completed in ${elapsed}s, total upserted: ${totalInserted}`);
  }
}

async function reconcileVisibleAiringState(database, httpFetch) {
  try {
    const [currSeason] = getCurrentSeasonInfo();
    const browse = database.getBrowseFromDb({ year: currSeason.seasonYear }, 1, 200);
    const candidates = (browse.results || []).filter(m =>
      m.oi_msg && (m.status === 'RELEASING' || m.next_airing_episode || m.next_airing_at)
    );
    const result = await reconcileAiringWithOi(database, httpFetch, candidates);
    if (result.updated > 0) {
      invalidateAnimeCaches(cache);
      console.log(`[sync] OI airing state reconciled: ${result.updated}/${result.checked}`);
    }
  } catch (e) {
    console.warn('[sync] OI airing state reconcile failed:', e.message);
  }
}

function schedulePeriodicSync(database, httpFetch) {
  setTimeout(async () => {
    console.log('[sync] Background AniList refresh starting...');
    await syncAnimeMetaFromAniList(database, httpFetch, false);
    console.log('[sync] Background refresh done (oi_msg resolution skipped — use sync-db.js)');
  }, 60000);

  const syncTimer = setInterval(async () => {
    console.log('[sync] Periodic AniList refresh running...');
    await syncAnimeMetaFromAniList(database, httpFetch, false);
  }, SYNC_INTERVAL);

  return syncTimer;
}

async function buildAiringSchedule(database, httpFetch = null) {
  const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const SCHEDULE_CACHE_KEY = 'airing_schedule_v4';
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const weekSec = 7 * 24 * 60 * 60;
  return getOrSetCache(cache, SCHEDULE_CACHE_KEY, 10 * 60 * 1000, async () => {

    const schedule = { '周一': [], '周二': [], '周三': [], '周四': [], '周五': [], '周六': [], '周日': [] };

    let dbAiring = database.getAiringScheduleFromDb({ strict: true });
    if (httpFetch) {
      const reconcile = await reconcileAiringWithOi(database, httpFetch, dbAiring);
      if (reconcile.updated > 0) {
        dbAiring = database.getAiringScheduleFromDb({ strict: true });
      }
    }
    for (const m of dbAiring) {
      let airingAt = m.next_airing_at || 0;
      let airingEpisode = m.next_airing_episode || 0;
      if (!airingAt) continue;

      if (airingAt <= nowSec) {
        const weeksToAdvance = Math.floor((nowSec - airingAt) / weekSec) + 1;
        airingAt += weeksToAdvance * weekSec;
        airingEpisode += weeksToAdvance;
      }
      const r = dbMetaToResult(m);
      r.airingAt = airingAt;
      r.airingEpisode = airingEpisode;
      r.nextAiring = { episode: airingEpisode, time: airingAt };
      r.rawAniListData = {
        averageScore: m.average_score, episodes: m.episodes,
        genres: JSON.parse(m.genres || '[]'),
        nextAiringEpisode: { episode: airingEpisode, airingAt }
      };
      const d = new Date(airingAt * 1000);
      const day = DAY_NAMES[hkWeekday(d)];
      schedule[day].push(r);
    }
    console.log(`[schedule] DB: ${dbAiring.length} entries`);

    // Chinese titles are now resolved during sync — no runtime bridging needed
    const filteredSchedule = filterAndDedupeSchedule(schedule);

    const result = { schedule: filteredSchedule, total: Object.values(filteredSchedule).flat().length };
    return result;
  });
}

function filterAndDedupeSchedule(schedule) {
  const filteredSchedule = {};
  for (const day of Object.keys(schedule)) {
    let list = filterChineseResults(schedule[day], true);
    list = list.filter(r => {
      if (/剧场版|电影|总集篇|OVA|OAD|番外|外传/.test(r.title || '')) return false;
      if ((r.ji || '').includes('已完结')) return false;
      return true;
    });
    list = list.filter(r => {
      const hasCN = r.title && containsChinese(r.title) && !containsJapaneseKana(r.title);
      const year = parseInt(r.year) || 0;
      return hasCN || year >= 2025;
    });
    list.sort((a, b) => (b.score || 0) - (a.score || 0));
    filteredSchedule[day] = list;
  }

  for (const day of Object.keys(filteredSchedule)) {
    const seenTitles = new Set();
    filteredSchedule[day] = filteredSchedule[day].filter(r => {
      const base = extractBaseTitle(r.title).toLowerCase();
      if (seenTitles.has(base)) return false;
      seenTitles.add(base);
      return true;
    });
  }
  return filteredSchedule;
}

module.exports = {
  syncAnimeMetaFromAniList,
  schedulePeriodicSync,
  buildAiringSchedule,
  reconcileVisibleAiringState,
  filterAndDedupeSchedule
};
