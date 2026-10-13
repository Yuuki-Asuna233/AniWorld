// Public releases play through client-side rules. Keep explicit responses for legacy callers.
function mountOiPlaybackRoutes(app) {
  for (const route of ['/api/oi/play', '/api/oi/probe', '/api/oi/sources']) {
    app.get(route, (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.status(410).json({
        code: 'SOURCE_REMOVED',
        error: '公开版已移除内置播放源，请在 Android / Windows 客户端选择 AGE、DM84 或 enlie'
      });
    });
  }
}

module.exports = { mountOiPlaybackRoutes };
