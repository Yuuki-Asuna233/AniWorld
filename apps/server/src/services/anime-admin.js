const { isAgentAdmin } = require('./agent-telemetry');
const { deleteCache } = require('./cache');

function invalidateAnimeCaches(cache) {
  if (!cache) return;
  for (const key of ['airing_schedule_v3', 'airing_schedule_v4', 'oi_today_v4', 'oi_calendar_v4']) {
    deleteCache(cache, key);
  }
  // Cover edits must not leave search, details or category snapshots pointing
  // at the previous image while uncached subject endpoints already show it.
  for (const key of Object.keys(cache)) {
    if (['search_', 'details_', 'browse_', 'rankings_', 'oi_trending', 'oi_classic', 'oi_newseason']
      .some(prefix => key.startsWith(prefix))) deleteCache(cache, key);
  }
}

function canManageAnime(req, database) {
  return !!req.user && isAgentAdmin(req, database);
}

function updateAnime(database, cache, anilistId, updates, user) {
  const result = database.updateAnimeMetaByAdmin(anilistId, updates, {
    userId: user?.id,
    editorName: user?.username || user?.email || ''
  });
  if (result.success && result.changed) invalidateAnimeCaches(cache);
  return result;
}

module.exports = {
  canManageAnime,
  invalidateAnimeCaches,
  updateAnime
};
