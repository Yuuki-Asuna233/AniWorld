const { canManageAnime, updateAnime } = require('../services/anime-admin');

function mountAnimeAdminRoutes(app, { database, cache, requireAuth }) {
  function adminOnly(req, res, next) {
    if (!req.user) return res.status(401).json({ error: '请先登录' });
    if (!canManageAnime(req, database)) return res.status(403).json({ error: '无权访问番剧管理' });
    next();
  }

  app.get('/api/admin/anime', requireAuth, adminOnly, (req, res) => {
    const result = database.getAdminAnimePage({
      query: req.query.query || req.query.q || '',
      year: req.query.year,
      month: req.query.month,
      status: req.query.status,
      page: req.query.page,
      perPage: req.query.perPage || req.query.limit
    });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  });

  app.get('/api/admin/anime/:anilistId', requireAuth, adminOnly, (req, res) => {
    const id = Number(req.params.anilistId);
    const anime = database.getAnimeMetaById(id);
    if (!anime) return res.status(404).json({ error: '番剧不存在' });
    res.set('Cache-Control', 'no-store');
    res.json({ anime });
  });

  app.patch('/api/admin/anime/:anilistId', requireAuth, adminOnly, (req, res) => {
    const result = updateAnime(database, cache, req.params.anilistId, req.body || {}, req.user);
    if (result.notFound) return res.status(404).json({ error: result.error });
    if (result.error) return res.status(400).json({ error: result.error });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  });

  app.get('/api/admin/anime/:anilistId/edits', requireAuth, adminOnly, (req, res) => {
    const id = Number(req.params.anilistId);
    if (!database.getAnimeMetaById(id)) return res.status(404).json({ error: '番剧不存在' });
    res.set('Cache-Control', 'no-store');
    res.json({ edits: database.getAnimeMetaEditHistory(id, req.query.limit) });
  });
}

module.exports = { mountAnimeAdminRoutes };
