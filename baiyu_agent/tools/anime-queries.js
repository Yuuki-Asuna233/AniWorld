const { resolveAnimeMetadataDetailed } = require('../../apps/server/src/services/anime-identity');
const { compactDetail } = require('./anime-data');
const { toCard } = require('../retrieval/recommender');

function compareAnime(args, { database }) {
  const inputs = (args.anilistIds || args.titles).map(input => {
    if (typeof input === 'number') {
      const meta = database.getAnimeMetaById(input);
      return { input, status: meta ? 'resolved' : 'not_found', meta };
    }
    const resolution = resolveAnimeMetadataDetailed(database, input, { limit: 12, minimumScore: 500 });
    return { input, status: resolution.selected && resolution.status !== 'ambiguous' ? 'resolved' : resolution.status,
      meta: resolution.status === 'ambiguous' ? null : resolution.selected,
      candidates: (resolution.candidates || []).slice(0, 3).map(item => compactDetail(item.meta)) };
  });
  const seen = new Set();
  for (const item of inputs) {
    if (!item.meta) continue;
    if (seen.has(item.meta.anilist_id)) { item.status = 'duplicate'; item.meta = null; }
    else seen.add(item.meta.anilist_id);
  }
  const resolved = inputs.filter(item => item.meta);
  return { count: resolved.length, requestedCount: inputs.length,
    partial: resolved.length !== inputs.length,
    inputs: inputs.map(({ meta, ...item }) => ({ ...item, ...(meta ? { anilistId: Number(meta.anilist_id) } : {}) })),
    items: resolved.map(({ meta }) => compactDetail(meta)),
    dataSource: 'local_catalog',
    cards: resolved.map(({ meta }) => toCard(meta, '参与本次对比')) };
}

function userLibrary(args, { database, userId }) {
  const page = database.getAgentUserLibrary(userId, args);
  const cards = [];
  const items = page.rows.map(row => {
    // Business state uses persisted identity. Never infer a canonical work from a fuzzy title.
    const anilistId = Number(row.anilist_id) || Number(String(row.anime_id || '').match(/^anilist_(\d+)$/)?.[1]) || 0;
    const meta = anilistId ? database.getAnimeMetaById(anilistId) : null;
    if (meta) cards.push(toCard(meta, args.list === 'favorites' ? '当前追番' : '观看历史'));
    const history = args.list === 'history' ? row : database.getHistoryProgress(userId, row.anime_id);
    return { animeId: row.anime_id, anilistId, title: row.anime_title,
      identityStatus: meta ? 'resolved' : 'legacy_unresolved',
      ...(history ? { episode: history.episode_number, episodeTitle: history.episode_title,
        progress: history.progress, positionSeconds: history.position_seconds, durationSeconds: history.duration_seconds,
        updatedAt: history.updated_at } : { progressAvailable: false }) };
  });
  return { list: args.list, scopedToUser: true, total: page.total, nextOffset: page.nextOffset, items, cards };
}

module.exports = { compareAnime, userLibrary };
