const { dbMetaToResult } = require('../../apps/server/src/utils/db-helpers');
const { toCard } = require('../retrieval/recommender');

function compactCard(card) {
  const { anilistId, title, score, year, status, genres, episodes, reason } = card;
  return { anilistId, title, score, year, status, genres, episodes, reason };
}

function compactDetail(meta) {
  const result = dbMetaToResult(meta);
  return { anilistId: Number(meta.anilist_id) || 0, title: result.title, romajiTitle: result.romajiTitle,
    nativeTitle: result.nativeTitle, score: result.score, popularity: Number(meta.popularity) || 0,
    year: result.year, season: result.season, status: result.status, format: result.format,
    genres: result.genres, contentTags: result.contentTags, episodes: result.episodes,
    nextAiring: result.nextAiring, playable: result.oiResolved, href: toCard(meta).href };
}

module.exports = { compactCard, compactDetail };
