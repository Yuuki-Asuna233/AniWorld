const { isAgentAdmin } = require('./agent-telemetry');
const { deleteCache } = require('./cache');

function invalidateAnimeCaches(cache) {
  if (!cache) return;
  for (const key of ['airing_schedule_v3', 'airing_schedule_v4', 'oi_today_v4', 'oi_calendar_v4']) {
    deleteCache(cache, key);
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
