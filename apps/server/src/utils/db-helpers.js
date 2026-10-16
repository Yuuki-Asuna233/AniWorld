// Database helper utilities
const { animeCoverFields } = require('../services/anime-covers');

function dbMetaToResult(m) {
  const totalEpisodes = Number(m.episodes) || 0;
  const nextEpisode = Number(m.next_airing_episode) || 0;
  const hasValidNextAiring = m.next_airing_at > 0
    && nextEpisode > 0
    && m.status !== 'FINISHED';

  return {
    id: 'anilist_' + m.anilist_id,
    title: m.title_chinese || m.title_romaji || m.title_native || '',
    romajiTitle: m.title_romaji || '',
    englishTitle: m.title_romaji || '',
    nativeTitle: m.title_native || '',
    ...animeCoverFields({}, { metadata: m }),
    score: m.average_score || 0,
    episodes: m.episodes || '?',
    status: m.status || 'UNKNOWN',
    genres: safeJsonParse(m.genres || '[]', []),
    contentTags: safeJsonParse(m.content_tags || '[]', []),
    year: m.season_year || '',
    season: m.season || '',
    format: m.format || '',
    startDate: safeJsonParse(m.start_date, null),
    synopsis: '',
    nextAiring: hasValidNextAiring ? {
      episode: nextEpisode,
      time: m.next_airing_at || 0
    } : null,
    source: 'anilist',
    oiResolved: !!(m.oi_msg && m.oi_index),
    oiMsg: m.oi_msg || '',
    oiIndex: m.oi_index || 1
  };
}

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

function hasDbDataForYear(database, minYear) {
  const count = database.getAnimeMetaCount();
  return count > 100;
}

module.exports = { dbMetaToResult, safeJsonParse, hasDbDataForYear };
