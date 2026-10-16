// Merged OIAPI/local search adapter. The route owns cache and HTTP policy.
const { findAlias } = require('../../anime-titles');
const { filterChineseResults, cleanOiTitle } = require('../utils/chinese');
const { safeJsonParse } = require('../utils/db-helpers');
const { OI_BASE, smartMatchScore, searchOiWithSubstrings } = require('./oi-helpers');
const { enrichSearchResultsWithAniListMeta } = require('./catalogue');
const { animeCoverFields } = require('./anime-covers');

async function buildMergedSearchResults(q, { database, httpFetch }) {
  let degraded = false;
  let oiResults = [];
  let anilistResults = [];

  const aliasedName = findAlias(q);
  const oiSearchTerms = [aliasedName || q, q];
  if (q.length >= 4 && /[\u4e00-\u9fff]/.test(q)) {
    const cleaned = q.replace(/[【】「」（）\(\)\[\]《》，。！？\s]/g, '').trim();
    if (cleaned.length >= 4) oiSearchTerms.push(cleaned.slice(0, Math.floor(cleaned.length * 0.6)));
  }

  try {
    const uniqueTerms = [...new Set(oiSearchTerms)]
      .filter(searchTerm => searchTerm && searchTerm.length >= 2);
    const termResults = await Promise.all(uniqueTerms.map(async searchTerm => {
      try {
        const url = `${OI_BASE}?msg=${encodeURIComponent(searchTerm)}`;
        const r = await httpFetch(url, { timeout: 8000 });
        if (r.status === 200 && r.data?.code === 200 && Array.isArray(r.data.data)) return r.data.data;
        degraded = true;
        return [];
      } catch (_) {
        degraded = true;
        return [];
      }
    }));
    for (const list of termResults) {
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        oiResults.push({
          id: 'oi_' + i, title: a.name || '未知', image: a.image || '',
          ji: a.ji || '', year: a.year || '', source: 'oiapi',
          oiMsg: a.name || '', oiIndex: i + 1
        });
      }
      // Some providers return only a partial alias result (for example
      // RE0 omits one cour), so merge every distinct search variant.
    }
    const seenOi = new Set();
    oiResults = oiResults.filter(r => {
      if (seenOi.has(r.title)) return false;
      seenOi.add(r.title); return true;
    });

    if (oiResults.length === 0 && q.length >= 2 && /[\u4e00-\u9fff]/.test(q)) {
      const subResult = await searchOiWithSubstrings(q, httpFetch, 5000);
      if (subResult) {
        oiResults.push({
          id: 'oi_sub_0', title: subResult.title || '未知', image: subResult.image || '',
          ji: subResult.ji || '', year: subResult.year || '', source: 'oiapi',
          oiMsg: subResult.title || '', oiIndex: subResult.oiIndex || 1
        });
      }
      if (oiResults.length === 0 && q.length <= 3) {
        try {
          const retryR = await httpFetch(`${OI_BASE}?msg=${encodeURIComponent(q)}`, { timeout: 12000 });
          if (retryR.status === 200 && retryR.data?.code === 200) {
            const retryList = Array.isArray(retryR.data.data) ? retryR.data.data : [];
            for (let i = 0; i < retryList.length; i++) {
              oiResults.push({
                id: 'oi_retry_' + i, title: cleanOiTitle(retryList[i].name || '未知'),
                image: retryList[i].image || '', ji: retryList[i].ji || '',
                year: retryList[i].year || '', source: 'oiapi',
                oiMsg: cleanOiTitle(retryList[i].name || ''), oiIndex: i + 1
              });
            }
          }
        } catch (e2) {}
      }
    }
  } catch (e) { degraded = true; console.error('OI search error:', e.message); }

  // The same identity check the details route uses, so a card and its detail
  // page agree on one stable AniList ID instead of a title hash or a list
  // position.
  enrichSearchResultsWithAniListMeta(oiResults, database);

  let dbSearchResults = [];
  try {
    dbSearchResults = database.searchAnimeMetaByTitle(q, 20, { strict: true });
  } catch (_) {
    degraded = true;
  }
  anilistResults = dbSearchResults.map(m => ({
    id: 'anilist_' + m.anilist_id,
    title: m.title_chinese || m.title_romaji || m.title_native || 'Unknown',
    romajiTitle: m.title_romaji || '', englishTitle: '', nativeTitle: m.title_native || '',
    ...animeCoverFields({}, { metadata: m }), score: m.average_score || 0, episodes: m.episodes || '?',
    status: m.status || 'UNKNOWN', genres: safeJsonParse(m.genres, []),
    source: 'db', format: m.format || '', seasonYear: m.season_year || '',
    oiMsg: m.oi_msg || '', oiIndex: m.oi_index || 0, oiResolved: !!(m.oi_msg && m.oi_index)
  }));

  const merged = [];
  const seenExact = new Set();
  for (const r of oiResults) {
    const key = (r.title || '').toLowerCase().trim();
    if (!seenExact.has(key)) { merged.push(r); seenExact.add(key); }
  }
  for (const a of anilistResults) {
    const key = (a.title || '').toLowerCase().trim();
    if (!seenExact.has(key)) merged.push(a);
    else {
      const existing = merged.find(r => (r.title || '').toLowerCase().trim() === key);
      if (existing) {
        if (a.episodes && a.episodes !== '?' && (!existing.episodes || existing.episodes === '?')) existing.episodes = a.episodes;
        if ((a.score || 0) > (existing.score || 0)) existing.score = a.score;
      }
    }
    seenExact.add(key);
  }

  const scored = merged.map(r => {
    const matchScore = smartMatchScore(q, r.title,
      r._romajiTitle || r.romajiTitle || '', r._englishTitle || r.englishTitle || '',
      r._nativeTitle || r.nativeTitle || '');
    delete r._romajiTitle; delete r._englishTitle; delete r._nativeTitle;
    return { ...r, _matchScore: matchScore };
  });

  scored.sort((a, b) => {
    const aOi = a.source === 'oiapi' ? 1 : 0;
    const bOi = b.source === 'oiapi' ? 1 : 0;
    if (bOi !== aOi && Math.abs(b._matchScore - a._matchScore) <= 20) return bOi - aOi;
    if (b._matchScore !== a._matchScore) return b._matchScore - a._matchScore;
    return (b.score || 0) - (a.score || 0);
  });

  let filtered = filterChineseResults(scored);
  if (filtered.length === 0 && scored.length > 0) filtered = scored.filter(r => r.title && r.title.length > 0);
  filtered.forEach(r => delete r._matchScore);

  return { results: filtered.slice(0, 30), total: filtered.length, degraded };
}

// Preserve the public search response contract without coupling metadata to playback.
async function buildPureSearchResults(q, dependencies) {
  const data = await buildMergedSearchResults(q, dependencies);
  return { ...data, pure: true, source: data.results.length ? data.results[0].source : 'none' };
}

module.exports = { buildMergedSearchResults, buildPureSearchResults };
