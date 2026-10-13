const { isAgentAdmin } = require('../services/agent-telemetry');

function mountAgentAdminRoutes(app, { database, requireAuth }) {
  function adminOnly(req, res, next) {
    if (!req.user) return res.status(401).json({ error: '请先登录' });
    if (!isAgentAdmin(req, database)) return res.status(403).json({ error: '无权访问 Agent 管理数据' });
    next();
  }

  app.get('/api/admin/agent/overview', requireAuth, adminOnly, (req, res) => {
    const days = Math.max(1, Math.min(Number(req.query.days) || 7, 90));
    res.json({
      ...database.getAgentAdminOverview(days),
      trend: database.getAgentAdminTrend(days),
      tools: database.getAgentAdminToolUsage(days),
      models: database.getAgentAdminModelUsage(days),
      runs: database.getAgentAdminRuns({ days, limit: 50 })
    });
  });

  app.get('/api/admin/agent/runs/:runId', requireAuth, adminOnly, (req, res) => {
    const run = database.getAgentAdminRun(req.params.runId);
    if (!run) return res.status(404).json({ error: '运行记录不存在' });
    res.json({ run });
  });
}

module.exports = { mountAgentAdminRoutes };
