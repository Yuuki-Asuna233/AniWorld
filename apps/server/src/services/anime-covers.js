// Shared poster policy for catalogue APIs, saved lists and agent cards.
// Identity matching never changes a result's ID or playback selection.
const { resolveAnimeMetadata } = require('./anime-identity');

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function metadataForCover(item, database) {
  if (!database) return null;
  try {
    let id = Number(item.anilistId || item.anilist_id || item.aniId) || 0;
    const storedId = text(item.anime_id || item.id);
    if (!id && storedId.startsWith('anilist_')) id = Number(storedId.slice(8)) || 0;
    // Provider IDs and client title hashes are not AniList IDs.
    if (Number.isSafeInteger(id) && id > 0) return database.getAnimeMetaById(id) || null;
    const title = item.oiMsg || item.anime_msg || item.title || item.anime_title || item.name;
    return resolveAnimeMetadata(database, title, {
      year: item.year || item.seasonYear || item.aniSeasonYear,
      requireYear: true,
      minimumScore: 1000
    });
  } catch (_) {
    return null;
  }
}

function animeCoverFields(item = {}, { database, metadata } = {}) {
  const meta = metadata || metadataForCover(item, database);
  const candidates = [...new Set([
    meta?.cover_image, item.image, item.cover, item.anime_image,
    item.coverFallback, item.cover_fallback, item.images?.large, item.images?.fallback
  ].map(text).filter(Boolean))];
  return { image: candidates[0] || '', coverFallback: candidates[1] || '' };
}

function animeCoverImages(fields) {
  return {
    large: fields.image, common: fields.image, medium: fields.image,
    small: fields.image, grid: fields.image, fallback: fields.coverFallback
  };
}

function withAnimeCovers(items, database) {
  return items.map(item => ({ ...item, ...animeCoverFields(item, { database }) }));
}

module.exports = { animeCoverFields, animeCoverImages, metadataForCover, withAnimeCovers };
