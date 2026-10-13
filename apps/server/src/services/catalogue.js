const { findAlias } = require('../../anime-titles');
const { dbMetaToResult, safeJsonParse } = require('../utils/db-helpers');
const { getCache, setCache } = require('./cache');
const { cycaniSearch, cycaniDetails } = require('./cycani-bridge');
const { OI_BASE, generateOiMsgCandidates, selectBestOiResult, resolveCurrentOiSelection } = require('./oi-helpers');
const { resolveAnimeMetadata } = require('./anime-identity');
const { resolveAnimeEditionPresentation, statusFromOiLabel } = require('./anime-presentation');
const { getOiAiringState } = require('./airing-reconcile');

function formatAniListDate(value) {
  const year = Number(value?.year) || 0;
  const month = Number(value?.month) || 0;
  const day = Number(value?.day) || 0;
  if (!year || !month || !day) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function enrichSearchResultsWithAniListMeta(results, database) {
  for (const result of results) {
    try {
      const meta = resolveAnimeMetadata(database, result.oiMsg || result.title, {
        year: result.year,
        requireYear: true,
        minimumScore: 1000
      });
      if (meta?.anilist_id) {
        const metadata = dbMetaToResult(meta);
        const totalEpisodes = Number(meta.episodes) || 0;
        const nextEpisode = Number(meta.next_airing_episode) || 0;
        result.anilistId = meta.anilist_id;
        result.metadataMatched = true;
        if (metadata.image) {
          result.coverFallback = result.image || '';
          result.image = metadata.image;
        }
        result.seasonYear = metadata.year;
        result.startDate = metadata.startDate;
        // Prefer a real count on either side; CYCANI often knows the announced
        // total while AniList still reports "?" for a season that just began.
        if (Number(metadata.episodes) > 0 || !(Number(result.episodes) > 0)) {
          result.episodes = metadata.episodes;
        }
        result.status = metadata.status;
        result.genres = metadata.genres;
        result.score = metadata.score;
        result.format = metadata.format;
        result.nextAiring = metadata.nextAiring;
        result.releasedEpisodes = meta.status === 'FINISHED'
          ? totalEpisodes
          : meta.status === 'RELEASING'
            ? Math.max(0, nextEpisode - 1)
            : 0;
      }
    } catch (_) {}
  }
  return results;
}

/**
 * Build the result list for the website/app search box (`pure=1`).
 *
 * CYCANI is the playback source of truth and is also the freshest catalogue,
 * so it is queried first; the AniList-synced local table is the fallback for
 * titles CYCANI has not ingested. OIAPI is deliberately not consulted here —
 * its catalogue lags a season behind, which made new seasons unsearchable.
 *
 * Results keep the historical field names (`source: 'oiapi'`, `oiMsg`,
 * `oiIndex`) because both clients branch on them: the web player uses
 * `source === 'oiapi' && oiIndex` to open the detail page, and the app stores
 * the pair as persisted playback identity. `oiMsg` holds a title that CYCANI
 * can resolve, so playback continues to work unchanged.
 */
async function buildPureSearchResults(q, { database, httpFetch }) {
  const results = [];
  const seen = new Set();
  const push = item => {
    const key = String(item.title || '').trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    results.push(item);
  };

  // Query the alias and the raw text, the way the OIAPI path used to, so short
  // or romanised searches ("RE0") still resolve.
  const aliasedName = findAlias(q);
  const terms = [...new Set([aliasedName || q, q])]
    .filter(term => term && String(term).trim().length >= 2);

  let degraded = false;
  try {
    const lists = await Promise.all(terms.map(term =>
      cycaniSearch(term, httpFetch, { pageSize: 30, strict: true }).catch(() => { degraded = true; return []; })));
    for (const list of lists) {
      for (const item of list) {
        push({
          id: 'cycani_' + item.videoId,
          title: item.title,
          image: item.image,
          ji: item.remarks,
          year: item.year,
          episodes: item.totalEpisodes || '?',
          score: item.score || 0,
          source: 'oiapi',
          provider: 'cycani',
          oiMsg: item.title,
          oiIndex: 1,
          oiResolved: true,
          cycaniVideoId: item.videoId
        });
      }
    }
  } catch (_) { degraded = true; }

  if (results.length === 0) {
    try {
      for (const row of database.searchAnimeMetaByTitle(q, 30, { strict: true })) {
        const mapped = dbMetaToResult(row);
        push({
          id: mapped.id,
          title: mapped.title,
          image: mapped.image,
          ji: '',
          year: mapped.year,
          episodes: mapped.episodes || '?',
          score: mapped.score || 0,
          source: 'oiapi',
          provider: 'db',
          oiMsg: mapped.oiMsg || mapped.title,
          oiIndex: mapped.oiIndex || 1,
          oiResolved: true,
          romajiTitle: mapped.romajiTitle || '',
          nativeTitle: mapped.nativeTitle || '',
          genres: mapped.genres || [],
          format: mapped.format || '',
          seasonYear: mapped.seasonYear || ''
        });
      }
    } catch (_) { degraded = true; }
  }

  enrichSearchResultsWithAniListMeta(results, database);

  return {
    results,
    total: results.length,
    pure: true,
    degraded,
    source: results.length > 0 ? results[0].provider : 'none'
  };
}

async function getAnimeDetails({ msg, n }, { database, httpFetch, cache: cacheObj }) {
  if (!msg || n === undefined) throw Object.assign(new Error('msg和n参数必需'), { status: 400 });
  const aliased = findAlias(msg);
  if (aliased) msg = aliased;

  let numericN = Math.max(1, Number.parseInt(n, 10) || 1);

  const detailsCacheKey = `details_v9_${msg}_${numericN}`;
  const detailsCached = getCache(cacheObj, detailsCacheKey, 15 * 60 * 1000);
  if (detailsCached) return detailsCached;

  async function callOiDetails(msgInner, nInner) {
    return await httpFetch(`${OI_BASE}?msg=${encodeURIComponent(msgInner)}&n=${nInner}`, { timeout: 15000 });
  }

  function isUsableOiDetailsResponse(response) {
    const data = response?.data?.data;
    return response?.status === 200 &&
      response?.data?.code === 200 &&
      data &&
      String(data.name || '').trim() &&
      Array.isArray(data.playlist) &&
      data.playlist.length > 0;
  }

  async function searchBestOiDetail(searchMsg) {
    try {
      const searchR = await httpFetch(`${OI_BASE}?msg=${encodeURIComponent(searchMsg)}`, { timeout: 10000 });
      if (!(searchR.status === 200 && searchR.data?.code === 200 && Array.isArray(searchR.data.data) && searchR.data.data.length > 0)) {
        return null;
      }
      const list = searchR.data.data;
      const bestIdx = selectBestOiResult(list, searchMsg);
      const best = list[bestIdx] || list[0];
      const bestN = bestIdx + 1;
      const bestName = best?.name || searchMsg;
      const detailR = await callOiDetails(bestName, bestN);
      if (isUsableOiDetailsResponse(detailR)) {
        return { response: detailR, msg: bestName, n: bestN };
      }
      const fallbackDetailR = await callOiDetails(searchMsg, bestN);
      if (isUsableOiDetailsResponse(fallbackDetailR)) {
        return { response: fallbackDetailR, msg: searchMsg, n: bestN };
      }
    } catch (e) {}
    return null;
  }

  /**
   * Resolve details through CYCANI and shape the result like an OIAPI
   * response, so every field derived below (episode count, airing state,
   * AniList metadata, rating) keeps working untouched.
   *
   * CYCANI's `remarks` uses the same "01|周六23:05后" / "即将放送" / "" forms
   * that airing-reconcile.js and anime-presentation.js already parse.
   */
  async function cycaniDetailsResponse(title) {
    try {
      const details = await cycaniDetails(title, httpFetch);
      if (!details || details.sections.length === 0) return null;
      return {
        status: 200,
        data: {
          code: 200,
          data: {
            name: details.resolvedTitle || details.title || title,
            image: details.cover || '',
            class: details.version || '',
            ji: details.remarks || '',
            year: details.year || '',
            desc: details.description || '',
            // AniList often has no announced episode count for a season that
            // just started, while CYCANI already knows it. Carry it through so
            // the page does not show "?".
            cycaniTotalEpisodes: details.totalEpisodes || 0,
            playlist: details.sections.map(section => ({
              name: section.title,
              j: section.episode,
              sectionId: section.id
            }))
          }
        }
      };
    } catch (_) {
      return null;
    }
  }

  // CYCANI is the playback source of truth and the freshest catalogue, so
  // resolve through it before spending a round trip on OIAPI. OIAPI stays
  // as the fallback for catalogue entries CYCANI has not ingested.
  let r = await cycaniDetailsResponse(msg);

  if (!isUsableOiDetailsResponse(r)) {
    const selection = await resolveCurrentOiSelection(msg, numericN, httpFetch, 8000);
    msg = selection.msg || msg;
    numericN = selection.index;

    r = await callOiDetails(msg, numericN);
    if (!isUsableOiDetailsResponse(r)) {
      r = await callOiDetails(msg, 1);
      if (isUsableOiDetailsResponse(r)) {
        numericN = 1;
      }
    }
  }

  if (!isUsableOiDetailsResponse(r)) {
    const candidates = generateOiMsgCandidates(msg);
    for (const candidate of [msg, ...candidates]) {
      const resolved = await searchBestOiDetail(candidate);
      if (resolved) {
        msg = resolved.msg;
        numericN = resolved.n;
        r = resolved.response;
        break;
      }
    }
  }

  if (isUsableOiDetailsResponse(r)) {
    const d = r.data.data;
    let aniEpisodes = '?', aniStatus = '', aniNextAiring = null, aniGenres = [], aniSeasonYear = '', aniStartDate = null, aniPopularity = 0, aniScore = 0, aniFormat = '', aniId = 0, aniTitleChinese = '', aniTitleRomaji = '', aniTitleNative = '', aniCover = '';
    try {
      const m = resolveAnimeMetadata(database, d.name || msg, {
        year: d.year,
        requireYear: true,
        minimumScore: 1000
      });
      if (m) {
        aniEpisodes = m.episodes || '?'; aniStatus = m.status || '';
        aniNextAiring = (m.status !== 'FINISHED' && m.next_airing_at > 0 && m.next_airing_episode > 0)
          ? { airingAt: m.next_airing_at, episode: m.next_airing_episode }
          : null;
        aniGenres = safeJsonParse(m.genres, []); aniSeasonYear = m.season_year || '';
        aniStartDate = safeJsonParse(m.start_date, null);
        aniPopularity = m.popularity || 0; aniScore = m.average_score || 0;
        aniFormat = m.format || ''; aniId = m.anilist_id || 0;
        aniTitleChinese = m.title_chinese || '';
        aniTitleRomaji = m.title_romaji || ''; aniTitleNative = m.title_native || '';
        aniCover = m.cover_image || '';
      }
    } catch (e) {}
    const edition = resolveAnimeEditionPresentation(d.name || msg);
    const oiAiringState = getOiAiringState(d);
    let episodeCountSource = Number(aniEpisodes) > 0 ? 'anilist' : 'unknown';
    if (edition?.episodes) {
      aniEpisodes = edition.episodes;
      episodeCountSource = 'edition_override';
    }
    // Fall back to CYCANI's announced total when neither AniList nor an
    // edition override knows the episode count (common for a season that
    // has just started airing).
    if ((!Number(aniEpisodes) || aniEpisodes === '?') && Number(d.cycaniTotalEpisodes) > 0) {
      aniEpisodes = Number(d.cycaniTotalEpisodes);
      episodeCountSource = 'cycani_total';
    }
    aniStatus = edition?.status || statusFromOiLabel(d.ji) || aniStatus;
    const nextEpisode = Number(aniNextAiring?.episode) || 0;
    if (Number(aniEpisodes) > 0 && nextEpisode > Number(aniEpisodes)) {
      aniEpisodes = '?';
      episodeCountSource = 'unknown';
    }
    if ((!Number(aniEpisodes) || aniEpisodes === '?')
        && oiAiringState.finished && oiAiringState.currentEpisode > 0) {
      aniEpisodes = oiAiringState.currentEpisode;
      episodeCountSource = 'oiapi_finished';
    }
    const response = {
      name:d.name||'', image:aniCover||d.image||'',
      coverFallback:aniCover ? (d.image||'') : '', class:d.class||'', ji:d.ji||'',
      year:d.year||'', desc:d.desc||'', playlist:d.playlist||[], source:'oiapi',
      resolved_n:numericN, metadataMatched:aniId > 0,
      episodes:String(aniEpisodes), aniStatus, aniNextAiring, aniGenres,
      releasedEpisodes:oiAiringState.currentEpisode || 0,
      episodeCountSource,
      aniSeasonYear, aniStartDate, aniPopularity, aniScore, aniFormat, aniId,
      aniTitleChinese, aniTitleRomaji, aniTitleNative, aniCover,
      airDate: edition?.airDate || formatAniListDate(aniStartDate),
      ratingSource: aniId > 0 ? 'anilist' : 'oiapi',
      ratingScore: aniScore,
      ratingTotal: aniPopularity,
      ratingCount: {},
      ratingRank: 0,
      bangumiSubjectId: 0
    };
    setCache(cacheObj, detailsCacheKey, response, 15 * 60 * 1000, { name: 'oi_details' });
    return response;
  } else {
    throw Object.assign(new Error((r.data || {}).message || '未找到详情'), { status: 404 });
  }
}

module.exports = { buildPureSearchResults, enrichSearchResultsWithAniListMeta, getAnimeDetails };
