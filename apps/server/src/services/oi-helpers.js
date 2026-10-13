// OIAPI search helpers

const { findAlias } = require('../../anime-titles');
const {
  cleanOiTitle, containsChinese, containsJapaneseKana,
  chineseNumToArabic, extractSeasonFromTitle, cleanTitle,
  normalizeSeasonNumber
} = require('../utils/chinese');
const { getOiSearchCache, setOiSearchCache, getBridgeCache, setBridgeCache } = require('./cache');

const OI_BASE = 'https://oiapi.net/api/Anime';
const OI_SELECTION_TTL = 5 * 60 * 1000;
const oiSelectionCache = new Map();
const oiSelectionInFlight = new Map();

function normalizeOiIdentity(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Resolve the current OIAPI result position for an exact title.
 *
 * `n` is only a position in OIAPI's current search result list, so it may
 * drift when that list changes. The stored value is therefore only a hint.
 * When the exact title is still present, its live position always wins.
 */
async function resolveCurrentOiSelection(msg, hintedIndex, httpFetch, timeout = 8000) {
  const originalMsg = String(msg || '').trim();
  const fallbackIndex = Math.max(1, Number.parseInt(hintedIndex, 10) || 1);
  if (!originalMsg) {
    return { msg: originalMsg, index: fallbackIndex, exact: false, refreshed: false };
  }

  const aliased = findAlias(originalMsg);
  const queryMsg = String(aliased || originalMsg).trim();
  const cacheKey = `${normalizeOiIdentity(queryMsg)}|${normalizeOiIdentity(originalMsg)}`;
  const cached = oiSelectionCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt <= OI_SELECTION_TTL) {
    return { ...cached.value, refreshed: cached.value.index !== fallbackIndex };
  }

  let pending = oiSelectionInFlight.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await httpFetch(
          `${OI_BASE}?msg=${encodeURIComponent(queryMsg)}`,
          { timeout }
        );
        const list = response.status === 200 && response.data?.code === 200
          ? (Array.isArray(response.data.data) ? response.data.data : [])
          : [];
        const wantedNames = new Set([
          normalizeOiIdentity(originalMsg),
          normalizeOiIdentity(queryMsg)
        ]);
        const exactIndex = list.findIndex(item =>
          wantedNames.has(normalizeOiIdentity(item?.name))
        );
        if (exactIndex >= 0) {
          const exactMsg = String(list[exactIndex]?.name || queryMsg).trim();
          return { msg: exactMsg, index: exactIndex + 1, exact: true };
        }
      } catch (_) {}
      return null;
    })().finally(() => oiSelectionInFlight.delete(cacheKey));
    oiSelectionInFlight.set(cacheKey, pending);
  }

  const resolved = await pending;
  if (resolved) {
    oiSelectionCache.set(cacheKey, { savedAt: Date.now(), value: resolved });
    if (oiSelectionCache.size > 500) {
      const oldestKey = oiSelectionCache.keys().next().value;
      if (oldestKey !== undefined) oiSelectionCache.delete(oldestKey);
    }
    return { ...resolved, refreshed: resolved.index !== fallbackIndex };
  }
  return { msg: queryMsg, index: fallbackIndex, exact: false, refreshed: false };
}

function generateOiMsgCandidates(msg) {
  const candidates = [];
  const aliased = findAlias(msg);
  if (aliased && aliased !== msg) candidates.push(aliased);

  const noSeason = msg.replace(/[\s　]*第[一二三四五六七八九十百零\d]+[季期部季]/g, '')
    .replace(/[\s　]*Season\s*\d+/gi, '').replace(/[\s　]*Part\s*\d+/gi, '')
    .replace(/[\s　]*[IVXLCDM]+\s*$/i, '').trim();
  if (noSeason !== msg && noSeason.length >= 2) candidates.push(noSeason);

  const noBrackets = msg.replace(/【.*?】/g, '').replace(/「.*?」/g, '').replace(/（.*?）/g, '').trim();
  if (noBrackets !== msg && noBrackets.length >= 2) candidates.push(noBrackets);

  const bracketContent = msg.match(/【(.+?)】/);
  if (bracketContent && bracketContent[1].length >= 2) {
    const inside = bracketContent[1].trim();
    const afterBracket = msg.replace(/【.+?】/, '').trim();
    candidates.push(inside);
    if (afterBracket && inside + afterBracket !== noBrackets) candidates.push(inside + afterBracket);
  }

  for (const c of [...candidates]) {
    const a = findAlias(c);
    if (a && a !== c && !candidates.includes(a)) candidates.push(a);
  }
  return [...new Set(candidates)].filter(c => c && c.length >= 2).slice(0, 5);
}

function selectBestOiResult(list, searchTerm, preferredSeason) {
  if (!list || list.length === 0) return 0;
  if (list.length === 1) return 0;

  function extractSeasonNum(str) {
    if (!str) return 0;
    const cnMatch = str.match(/第([一二三四五六七八九十]+)季/);
    if (cnMatch) return chineseNumToArabic(cnMatch[1]);
    const arMatch = str.match(/第(\d+)季/);
    if (arMatch) return parseInt(arMatch[1]);
    return 0;
  }

  const isMovieSearch = searchTerm && /剧场版|电影|无限城|总集篇|特别篇|OVA|OAD|SP|番外|外传|精选|合集/.test(searchTerm);
  const seasonMatch = searchTerm && searchTerm.match(/第[一二三四五六七八九十\d]+季|最终季|\d+期/);
  const seasonFromSearch = preferredSeason || (seasonMatch ? seasonMatch[0] : '');
  let bestIdx = 0, bestScore = -Infinity;

  for (let i = 0; i < list.length; i++) {
    const n = (list[i].name || '').trim();
    const y = parseInt(list[i].year) || 0;
    let score = 0;

    if (!isMovieSearch) {
      if (/剧场版|电影|总集篇|特别篇|OVA|OAD|SP|番外|外传|精选|合集/.test(n)) score -= 100;
    } else {
      if (searchTerm && n.includes(searchTerm)) score += 40;
      if (/剧场版|电影/.test(n)) score += 20;
    }
    if (y > 0 && y < 2018) score -= 50;
    if (y >= 2024) score += 30;
    if (y >= 2020 && y < 2024) score += 15;
    if (searchTerm && n === searchTerm) score += 50;
    if (/季/.test(n)) score += 20;
    if (seasonFromSearch) {
      const resultSeasonNum = extractSeasonNum(n);
      const searchSeasonNum = extractSeasonNum(String(seasonFromSearch));
      if (resultSeasonNum > 0 && searchSeasonNum > 0) {
        if (resultSeasonNum === searchSeasonNum) score += 200;
        else score -= 80;
      }
      if (/最终季/.test(seasonFromSearch) && /最终季/.test(n)) score += 200;
    }
    if (!isMovieSearch && /[:：]/.test(n) && n.indexOf(searchTerm || '') !== 0) score -= 15;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}

function extractKanjiChunks(text) {
  if (!text) return [];
  const chunks = text.split(/[^\u4e00-\u9fff\u3400-\u4dbf]+/g).filter(c => c.length >= 2);
  return [...new Set(chunks)].sort((a, b) => b.length - a.length);
}

async function searchOiDynamic(terms, httpFetch, timeout = 5000) {
  const tried = new Set();
  const mappedTerms = [...terms];
  for (const t of terms) {
    if (t && /[\u4e00-\u9fff]/.test(t)) {
      const alias = findAlias(t);
      if (alias && !terms.includes(alias)) mappedTerms.push(alias);
    }
  }

  for (const t of mappedTerms) {
    if (!t || t.length < 2 || tried.has(t)) continue;
    const normalizedT = normalizeSeasonNumber(t);
    if (tried.has(normalizedT)) continue;

    const variants = [normalizedT];
    const noSeason = normalizedT.replace(/\s*(第[一二三四五六七八九十\d]+季|Season\s*\d+|Final\s*Season|\d+期).*/i, '').trim();
    if (noSeason !== normalizedT && noSeason.length >= 2 && !tried.has(noSeason)) variants.push(noSeason);
    const mainPart = normalizedT.split(/[：:–—\-～~【\[\(\)（）]/)[0].trim();
    if (mainPart && mainPart !== normalizedT && mainPart.length >= 2 && !tried.has(mainPart)) variants.push(mainPart);
    const kanjiChunks = extractKanjiChunks(t);
    for (const kc of kanjiChunks.slice(0, 2)) {
      if (kc.length >= 2 && !tried.has(kc)) variants.push(kc);
    }

    for (const v of variants) {
      if (tried.has(v)) continue;
      tried.add(v);

      const cached = getOiSearchCache(v);
      if (cached.found) {
        if (cached.data) return cached.data;
        continue;
      }

      try {
        const url = `${OI_BASE}?msg=${encodeURIComponent(v)}`;
        const r = await httpFetch(url, { timeout });
        if (r.status === 200 && r.data?.code === 200) {
          const list = Array.isArray(r.data.data) ? r.data.data : [];
          if (list.length > 0) {
            const seasonMatch = t.match(/第[一二三四五六七八九十\d]+季|最终季|\d+期/);
            const bestIdx = selectBestOiResult(list, v, seasonMatch ? seasonMatch[0] : '');
            const a = list[bestIdx];
            const title = cleanOiTitle(a.name || t);
            const result = {
              id: 'oi_' + bestIdx, title, image: a.image || '', ji: a.ji || '',
              year: a.year || '', source: 'oiapi', oiMsg: title, oiIndex: bestIdx + 1
            };
            setOiSearchCache(v, result);
            return result;
          }
        }
        setOiSearchCache(v, null);
      } catch (e) {}
    }
  }
  return null;
}

async function searchOiWithSubstrings(term, httpFetch, timeout = 5000) {
  if (!term || term.length < 2) return null;
  let result = await searchOiDynamic([term], httpFetch, timeout);
  if (result) return result;
  for (let len = Math.min(term.length, 14); len >= 2; len--) {
    const sub = term.slice(0, len);
    if (sub === term) continue;
    result = await searchOiDynamic([sub], httpFetch, timeout);
    if (result) return result;
  }
  return null;
}

function smartMatchScore(query, title, romajiTitle, englishTitle, nativeTitle) {
  if (!query || !title) return 0;
  const q = query.toLowerCase().trim();
  if (q.length < 1) return 0;
  const fields = [title, romajiTitle, englishTitle, nativeTitle].filter(Boolean).map(t => t.toLowerCase());
  let bestScore = 0;
  for (const field of fields) {
    if (field.includes(q)) { bestScore = Math.max(bestScore, 100); continue; }
    if (/[\u4e00-\u9fff]/.test(q)) {
      let qi = 0;
      for (let ti = 0; ti < field.length && qi < q.length; ti++) {
        if (field[ti] === q[qi]) qi++;
      }
      if (qi === q.length) { bestScore = Math.max(bestScore, 80); continue; }
      const ratio = qi / q.length;
      if (ratio >= 0.7) bestScore = Math.max(bestScore, Math.round(50 * ratio));
    } else if (field.includes(q[0]) || field.includes(q.slice(-1))) {
      bestScore = Math.max(bestScore, 20);
    }
  }
  return bestScore;
}

function generateShortSubstrings(q) {
  const subs = [];
  const cleaned = q.replace(/[【】「」（）\(\)\[\]《》，。！？\s]/g, '').trim();
  if (cleaned !== q && cleaned.length >= 2) subs.push(cleaned);
  if (/[\u4e00-\u9fff]/.test(cleaned) && cleaned.length >= 3) {
    const halfLen = Math.max(2, Math.floor(cleaned.length / 2));
    subs.push(cleaned.slice(0, halfLen));
    if (halfLen < cleaned.length) subs.push(cleaned.slice(halfLen));
  }
  if (/\s/.test(q)) {
    const firstWord = q.split(/\s+/)[0];
    if (firstWord.length >= 2 && firstWord !== q) subs.push(firstWord);
  }
  return [...new Set(subs)].slice(0, 4);
}

async function fetchOiCategory(names, httpFetch, limit = 12) {
  const items = names.slice(0, limit);
  const concurrency = 6;
  const allResults = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(async (name) => {
      try {
        const searchName = normalizeSeasonNumber(name);
        const url = `${OI_BASE}?msg=${encodeURIComponent(searchName)}`;
        const r = await httpFetch(url, { timeout: 10000 });
        if (r.status === 200 && r.data?.code === 200) {
          const list = Array.isArray(r.data.data) ? r.data.data : [];
          if (list.length > 0) {
            const seasonMatch = searchName.match(/第[一二三四五六七八九十\d]+季|最终季|\d+期/);
            const bestIdx = selectBestOiResult(list, searchName, seasonMatch ? seasonMatch[0] : '');
            const a = list[bestIdx];
            return {
              id: name, title: a.name || name, image: a.image || '',
              ji: a.ji || '', year: a.year || '', source: 'oiapi',
              oiMsg: a.name || name, oiIndex: bestIdx + 1
            };
          }
        }
      } catch (e) {}
      return null;
    }));
    for (const r of batchResults) { if (r) allResults.push(r); }
  }
  return allResults;
}

module.exports = {
  OI_BASE,
  generateOiMsgCandidates,
  selectBestOiResult,
  searchOiDynamic,
  searchOiWithSubstrings,
  resolveCurrentOiSelection,
  smartMatchScore,
  generateShortSubstrings,
  fetchOiCategory
};
