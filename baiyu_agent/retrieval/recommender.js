const { dbMetaToResult, safeJsonParse } = require('../../apps/server/src/utils/db-helpers');
const { buildUserProfile } = require('../memory/profile');
const { recommendationConstraints, canonicalGenres } = require('./recommendation-constraints');

function uniqueById(rows) {
  const seen = new Set();
  return rows.filter(row => {
    const id = Number(row?.anilist_id) || 0;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function toCard(meta, reason = '') {
  const result = dbMetaToResult(meta);
  return {
    anilistId: Number(meta.anilist_id) || 0,
    title: result.title,
    image: result.image,
    score: result.score,
    year: result.year,
    status: result.status,
    genres: result.genres,
    episodes: result.episodes,
    reason,
    href: result.oiMsg
      ? `/anime.html?msg=${encodeURIComponent(result.oiMsg)}&n=${result.oiIndex || 1}`
      : `/search_anime.html?q=${encodeURIComponent(result.title)}`
  };
}

function overlapScore(values, targets) {
  if (!values.length || !targets.length) return 0;
  return values.filter(value => targets.includes(value)).length / Math.max(1, targets.length);
}

function recommendationReason(meta, profile, intent, contextMeta, semanticScore = 0) {
  const genres = safeJsonParse(meta.genres || '[]', []);
  const tags = safeJsonParse(meta.content_tags || '[]', []);
  const likedGenres = profile.genres.map(item => item.name);
  const likedTags = profile.tags.map(item => item.name);
  const overlaps = genres.filter(g => likedGenres.includes(g) || intent.genres.includes(g));
  const tagOverlaps = tags.filter(tag => likedTags.includes(tag));
  const contextGenres = contextMeta ? safeJsonParse(contextMeta.genres || '[]', []) : [];
  const contextOverlap = genres.filter(g => contextGenres.includes(g));
  const parts = [];
  if (semanticScore > 0) parts.push('与你描述的剧情或氛围语义相近');
  if (contextOverlap.length) parts.push(`和当前作品同属 ${contextOverlap.slice(0, 2).join('、')} 题材`);
  if (overlaps.length) parts.push(`贴合你偏好的 ${overlaps.slice(0, 2).join('、')}`);
  if (!overlaps.length && tagOverlaps.length) parts.push(`命中你常看的 ${tagOverlaps.slice(0, 2).join('、')} 标签`);
  if (meta.status === 'FINISHED') parts.push('已完结');
  else if (meta.status === 'RELEASING') parts.push('正在连载');
  if (Number(meta.average_score) >= 80) parts.push(`评分 ${meta.average_score}`);
  if (!parts.length) parts.push('综合口碑、热度和可播放状态较合适');
  return parts.join('；');
}

function getContextMeta(database, intent) {
  if (!intent.contextAnilistId) return null;
  return database.getAnimeMetaById(intent.contextAnilistId);
}

function recommendAnime(database, userId, input = {}) {
  const intent = recommendationConstraints(input);
  const explicitPreferences = intent.preferredGenres;
  const profile = buildUserProfile(database, userId);
  const contextMeta = getContextMeta(database, intent);
  const pool = [
    ...database.getRankingsFromDb('toprated', 120),
    ...database.getRankingsFromDb('popular', 120),
    ...database.getRankingsFromDb('trending', 80)
  ];
  const semanticScores = new Map(
    (Array.isArray(input.semanticCandidates) ? input.semanticCandidates : [])
      .map(item => [Number(item?.anilistId) || 0, Number(item?.score) || 0])
      .filter(([id]) => id)
  );
  for (const id of semanticScores.keys()) {
    const meta = database.getAnimeMetaById(id);
    if (meta) pool.push(meta);
  }

  const preferenceGenres = intent.genres.length
    ? intent.genres
    : [
        ...explicitPreferences,
        ...profile.genres.slice(0, 5).map(item => item.name),
        ...safeJsonParse(contextMeta?.genres || '[]', [])
      ].filter(Boolean);
  for (const genre of [...new Set(preferenceGenres)]) {
    const page = database.getBrowseFromDb({ genre, ...(intent.season ? { season: intent.season } : {}), ...(intent.seasonYear ? { year: intent.seasonYear } : {}) }, 1, 80);
    pool.push(...(page.results || []));
  }
  if (intent.season && intent.seasonYear) {
    const page = database.getBrowseFromDb({ season: intent.season, year: intent.seasonYear }, 1, 160);
    pool.push(...(page.results || []));
  }

  const watched = new Set(profile.watchedIds);
  const disliked = new Set(profile.dislikedIds);
  const excluded = new Set((input.excludeIds || []).map(Number));
  if (contextMeta?.anilist_id) excluded.add(Number(contextMeta.anilist_id));
  const genreAffinity = new Map(profile.genres.map(item => [item.name, item.score]));
  const tagAffinity = new Map(profile.tags.map(item => [item.name, item.score]));
  const maxGenreAffinity = Math.max(1, ...genreAffinity.values());
  const maxTagAffinity = Math.max(1, ...tagAffinity.values());
  const contextGenres = safeJsonParse(contextMeta?.genres || '[]', []);
  const contextTags = safeJsonParse(contextMeta?.content_tags || '[]', []);

  const scored = uniqueById(pool).map(meta => {
    const id = Number(meta.anilist_id);
    const genres = safeJsonParse(meta.genres || '[]', []);
    const tags = canonicalGenres(safeJsonParse(meta.content_tags || '[]', []));
    if (!intent.allowWatched && watched.has(id)) return null;
    if (disliked.has(id) || excluded.has(id)) return null;
    if (intent.status && meta.status !== intent.status) return null;
    if (intent.excludedStatuses.includes(meta.status)) return null;
    if (intent.year && Number(meta.season_year) !== intent.year) return null;
    if (intent.excludedYears.includes(Number(meta.season_year))) return null;
    if (intent.season && String(meta.season || '').toUpperCase() !== intent.season) return null;
    if (intent.seasonYear && Number(meta.season_year) !== intent.seasonYear) return null;
    if (intent.excludedSeasons.some(item => item.seasonYear === Number(meta.season_year) &&
        item.season === String(meta.season || '').toUpperCase())) return null;
    if (intent.scoreMin && Number(meta.average_score || 0) < intent.scoreMin) return null;
    if (intent.scoreMax != null && Number(meta.average_score || 0) > intent.scoreMax) return null;
    const matchesGenre = genre => genres.includes(genre) || tags.includes(genre);
    if (!intent.allGenres.every(matchesGenre)) return null;
    if (!intent.anyGenreGroups.every(group => group.some(matchesGenre))) return null;
    if (intent.excludeTags.some(tag => genres.includes(tag) || tags.includes(tag))) return null;

    const profileGenreMatch = genres.reduce((sum, genre) => sum + (genreAffinity.get(genre) || 0), 0) / maxGenreAffinity;
    const profileTagMatch = tags.reduce((sum, tag) => sum + (tagAffinity.get(tag) || 0), 0) / maxTagAffinity;
    const explicitMatch = intent.genres.length
      ? overlapScore([...genres, ...tags], intent.genres)
      : 0;
    const rememberedMatch = overlapScore([...genres, ...tags], explicitPreferences);
    const contextMatch = contextMeta
      ? overlapScore(genres, contextGenres) * 0.7 + overlapScore(tags, contextTags) * 0.3
      : 0;
    const quality = Math.max(0, Math.min(1, Number(meta.average_score || 0) / 100));
    const popularity = Math.min(1, Math.log10(Math.max(10, Number(meta.popularity) || 10)) / 6);
    const playable = meta.oi_msg ? 1 : 0;
    const statusFit = profile.preferredStatus && meta.status === profile.preferredStatus ? 1 : 0;
    const freshness = meta.status === 'RELEASING' && Number(meta.next_airing_at) > 0 ? 1 : 0;
    const semanticMatch = semanticScores.get(id) || 0;
    const score = profileGenreMatch * 0.27 + profileTagMatch * 0.12 + explicitMatch * 0.2
      + contextMatch * 0.14 + quality * 0.13 + popularity * 0.06
      + playable * 0.05 + statusFit * 0.02 + freshness * 0.01
      + semanticMatch * 0.28 + rememberedMatch * 0.25;
    return { meta, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score);

  const limit = Math.max(1, Math.min(Number(input.limit) || 8, 12));
  const selected = [];
  const primaryGenreCounts = new Map();
  for (const item of scored) {
    const primary = safeJsonParse(item.meta.genres || '[]', [])[0] || 'other';
    if ((primaryGenreCounts.get(primary) || 0) >= 3 && selected.length >= 4) continue;
    selected.push(item.meta);
    primaryGenreCounts.set(primary, (primaryGenreCounts.get(primary) || 0) + 1);
    if (selected.length >= limit) break;
  }

  return {
    personalized: profile.personalized,
    profile,
    profileSummary: {
      topGenres: profile.genres.slice(0, 5),
      topTags: profile.tags.slice(0, 5),
      recentAnime: profile.recentAnime.slice(0, 5),
      signalCounts: profile.signalCounts
    },
    intent,
    cards: selected.map(meta => toCard(
      meta,
      recommendationReason(meta, profile, intent, contextMeta, semanticScores.get(Number(meta.anilist_id)) || 0)
    ))
  };
}

module.exports = { recommendAnime, toCard };
