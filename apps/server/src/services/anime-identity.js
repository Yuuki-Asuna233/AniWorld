const { chineseNumToArabic } = require('../utils/chinese');

const SEASON_CN_RE = /第\s*([一二三四五六七八九十百零\d]+)\s*[季期]/i;
const SEASON_EN_RE = /(\d+)(?:st|nd|rd|th)?\s*season/i;
const SEASON_TRAILING_RE = /\s+(\d+)\s*第\s*[一二三四五六七八九十百零\d]+\s*[季期]/i;

function normalizeAnimeTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[：:]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[【】「」『』《》()（）\[\]{}<>，。！？、；;,.!?·・~～—–_-]/g, '');
}

function extractAnimeSeason(value) {
  const title = String(value || '').normalize('NFKC');
  const cn = title.match(SEASON_CN_RE);
  if (cn) return chineseNumToArabic(cn[1]);
  const seasonFirst = title.match(/\bseason\s*(\d+)\b/i);
  if (seasonFirst) return Number(seasonFirst[1]) || 0;
  const en = title.match(SEASON_EN_RE);
  if (en) return Number(en[1]) || 0;
  const ordinal = title.match(/\b(\d+)(?:st|nd|rd|th)\s*season\b/i);
  if (ordinal) return Number(ordinal[1]) || 0;
  return 0;
}

function animeFranchiseSearchTitle(value) {
  let title = String(value || '').normalize('NFKC').trim();
  return title
    .replace(SEASON_TRAILING_RE, '')
    .replace(/\s+\d+\s*(?=第\s*[一二三四五六七八九十百零\d]+\s*[季期])/i, '')
    .replace(/\s*第\s*[一二三四五六七八九十百零\d]+\s*[季期].*$/i, '')
    .replace(/\s*(?:\d+)(?:st|nd|rd|th)?\s*season.*$/i, '')
    .replace(/\s*season\s*\d+.*$/i, '')
    .replace(/\s*final\s*season.*$/i, '')
    .replace(/\s*第?\s*[一二三四五六七八九十百零\d]+\s*部.*$/i, '')
    .replace(/\s*part\s*[.\-]?\s*\d+.*$/i, '')
    .replace(/\s*(?:ova|oad|sp|剧场版|劇場版|电影|電影|特别篇|特別篇|总集篇|總集篇|外传|外傳|番外).*$/i, '')
    .trim();
}

function animeFranchiseBase(value) {
  return normalizeAnimeTitle(animeFranchiseSearchTitle(value));
}

function titlesShareAnimeFranchise(left, right) {
  const baseLeft = animeFranchiseBase(left);
  const baseRight = animeFranchiseBase(right);
  if (!baseLeft || !baseRight) return false;
  if (baseLeft === baseRight) return true;
  return Math.min(baseLeft.length, baseRight.length) >= 6
    && (baseLeft.includes(baseRight) || baseRight.includes(baseLeft));
}

function animeFranchiseSearchQueries(value) {
  const raw = String(value || '').normalize('NFKC').trim();
  const queries = [raw, animeFranchiseSearchTitle(raw)];
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) queries.push(parts.slice(0, -1).join(' '));
  if (parts.length >= 3 && parts[0].length >= 4) queries.push(parts[0]);
  for (const run of raw.match(/[\u4e00-\u9fff]{6,}/g) || []) {
    queries.push(run.slice(0, 8));
  }
  const seen = new Set();
  return queries.filter(query => {
    const key = normalizeAnimeTitle(query);
    if (!key || key.length < 4 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function titlesShareAnimeIdentity(left, right) {
  const normalizedLeft = normalizeAnimeTitle(left);
  const normalizedRight = normalizeAnimeTitle(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;

  const baseLeft = animeFranchiseBase(left);
  const baseRight = animeFranchiseBase(right);
  if (!baseLeft || !baseRight) return false;
  const sameBase = baseLeft === baseRight
    || (Math.min(baseLeft.length, baseRight.length) >= 6
      && (baseLeft.includes(baseRight) || baseRight.includes(baseLeft)));
  if (!sameBase) return false;

  const seasonLeft = extractAnimeSeason(left);
  const seasonRight = extractAnimeSeason(right);
  if (seasonLeft && seasonRight) return seasonLeft === seasonRight;
  if (!seasonLeft && seasonRight > 1) return false;
  if (!seasonRight && seasonLeft > 1) return false;
  return true;
}

function scoreMetadataCandidate(query, meta) {
  const fields = [
    meta?.oi_msg,
    meta?.title_chinese,
    meta?.title_romaji,
    meta?.title_native
  ].filter(Boolean);
  if (!fields.length) return -Infinity;

  const queryNormalized = normalizeAnimeTitle(query);
  const queryBase = animeFranchiseBase(query);
  const querySeason = extractAnimeSeason(query);
  let best = -Infinity;

  for (const field of fields) {
    const fieldSeason = extractAnimeSeason(field);
    const sameFranchiseSeason = !querySeason && fieldSeason > 0
      && animeFranchiseBase(field) === queryBase;
    if (!titlesShareAnimeIdentity(query, field) && !sameFranchiseSeason) continue;
    const fieldNormalized = normalizeAnimeTitle(field);
    const fieldBase = animeFranchiseBase(field);
    let score = 0;

    if (fieldNormalized === queryNormalized) score += 1000;
    else if (fieldNormalized.includes(queryNormalized) || queryNormalized.includes(fieldNormalized)) score += 700;
    if (fieldBase && fieldBase === queryBase) score += 500;
    if (querySeason && fieldSeason && querySeason === fieldSeason) score += 250;
    if (field === meta.oi_msg) score += 100;
    best = Math.max(best, score);
  }

  return best;
}

function animeMetadataYear(meta) {
  const seasonYear = Number(meta?.season_year) || 0;
  if (seasonYear >= 1900 && seasonYear <= 2100) return seasonYear;
  try {
    const startDate = typeof meta?.start_date === 'string'
      ? JSON.parse(meta.start_date)
      : meta?.start_date;
    const year = Number(startDate?.year) || 0;
    return year >= 1900 && year <= 2100 ? year : 0;
  } catch (_) {
    return 0;
  }
}

function animeMetadataSeason(meta) {
  const fields = [meta?.oi_msg, meta?.title_chinese, meta?.title_romaji, meta?.title_native]
    .filter(Boolean);
  for (const field of fields) {
    const season = extractAnimeSeason(field);
    if (season) return season;
  }
  return 0;
}

function requestedAnimeYear(value) {
  if (value && typeof value === 'object') {
    return requestedAnimeYear(value.year);
  }
  const match = String(value || '').match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/);
  return match ? Number(match[1]) : 0;
}

function hasExactAnimeTitle(query, meta) {
  const normalized = normalizeAnimeTitle(query);
  if (!normalized) return false;
  return [meta?.oi_msg, meta?.title_chinese, meta?.title_romaji, meta?.title_native]
    .filter(Boolean)
    .some(field => normalizeAnimeTitle(field) === normalized);
}

function resolveAnimeMetadata(database, query, limitOrOptions = 100) {
  return resolveAnimeMetadataDetailed(database, query, limitOrOptions)?.selected || null;
}

function resolveAnimeMetadataDetailed(database, query, limitOrOptions = 100) {
  if (!database || !query) {
    return { status: 'not_found', selected: null, candidates: [], confidence: 0, score: 0, margin: 0 };
  }
  const options = typeof limitOrOptions === 'object' && limitOrOptions !== null
    ? limitOrOptions
    : {};
  const limit = typeof limitOrOptions === 'number'
    ? limitOrOptions
    : Number(options.limit) || 100;
  const expectedYear = requestedAnimeYear(
    options.year || options.airDate || options.startDate
  );
  const expectedSeason = Number(options.season || options.expectedSeason) || 0;
  const scoringQuery = expectedSeason && !extractAnimeSeason(query)
    ? `${query} 第${expectedSeason}季`
    : query;
  if (options.requireYear && !expectedYear) {
    return { status: 'not_found', selected: null, candidates: [], confidence: 0, score: 0, margin: 0 };
  }
  const minimumScore = Number(options.minimumScore) || 500;
  const candidates = [];
  const seen = new Set();
  const addCandidates = rows => {
    for (const row of rows || []) {
      const key = Number(row?.anilist_id) || `${row?.title_chinese || ''}|${row?.title_romaji || ''}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push(row);
    }
  };

  addCandidates(database.searchAnimeMetaByTitle(query, limit));
  if (typeof database.searchAnimeMetaByAnyTitle === 'function') {
    addCandidates(database.searchAnimeMetaByAnyTitle(query, limit));
  }
  const baseSearchTitle = animeFranchiseSearchTitle(query);
  if (baseSearchTitle && normalizeAnimeTitle(baseSearchTitle) !== normalizeAnimeTitle(query)) {
    addCandidates(database.searchAnimeMetaByTitle(baseSearchTitle, limit));
    if (typeof database.searchAnimeMetaByAnyTitle === 'function') {
      addCandidates(database.searchAnimeMetaByAnyTitle(baseSearchTitle, limit));
    }
  }

  const ranked = [];
  for (const candidate of candidates) {
    if (expectedYear) {
      const candidateYear = animeMetadataYear(candidate);
      // OIAPI's year identifies the edition. A candidate with another year is
      // a sequel, remake or side story, not a safe metadata fallback.
      if (!candidateYear || candidateYear !== expectedYear) continue;
    }
    if (expectedSeason) {
      const candidateSeason = animeMetadataSeason(candidate);
      // An explicit different season is never a safe fallback. Metadata that
      // has no season marker may still be considered as a last resort.
      if (candidateSeason && candidateSeason !== expectedSeason) continue;
    }
    if (options.requireExactTitle && !hasExactAnimeTitle(query, candidate)) {
      continue;
    }
    const score = scoreMetadataCandidate(scoringQuery, candidate);
    if (score >= minimumScore) ranked.push({ candidate, score });
  }
  ranked.sort((left, right) => right.score - left.score);
  const best = ranked[0]?.candidate || null;
  const bestScore = Number(ranked[0]?.score) || 0;
  const secondScore = Number(ranked[1]?.score) || 0;
  const exact = Boolean(best && hasExactAnimeTitle(query, best));
  const margin = bestScore - secondScore;
  const sameFranchise = Boolean(
    ranked[1]
      && animeFranchiseBase(ranked[0].candidate.oi_msg || ranked[0].candidate.title_chinese || ranked[0].candidate.title_romaji)
      && animeFranchiseBase(ranked[0].candidate.oi_msg || ranked[0].candidate.title_chinese || ranked[0].candidate.title_romaji)
        === animeFranchiseBase(ranked[1].candidate.oi_msg || ranked[1].candidate.title_chinese || ranked[1].candidate.title_romaji)
  );
  const ambiguous = Boolean(best && !exact && sameFranchise && margin < 120);
  return {
    status: !best ? 'not_found' : ambiguous ? 'ambiguous' : exact ? 'exact' : 'high_match',
    selected: best && !ambiguous ? best : null,
    candidates: ranked.slice(0, 5).map(item => ({
      meta: item.candidate,
      score: item.score,
      exact: hasExactAnimeTitle(query, item.candidate)
    })),
    confidence: !best ? 0 : Math.max(0, Math.min(1, bestScore / 1600)),
    score: bestScore,
    margin
  };
}

module.exports = {
  normalizeAnimeTitle,
  extractAnimeSeason,
  animeFranchiseSearchTitle,
  animeFranchiseBase,
  titlesShareAnimeFranchise,
  animeFranchiseSearchQueries,
  titlesShareAnimeIdentity,
  scoreMetadataCandidate,
  animeMetadataYear,
  animeMetadataSeason,
  requestedAnimeYear,
  hasExactAnimeTitle,
  resolveAnimeMetadata,
  resolveAnimeMetadataDetailed
};
