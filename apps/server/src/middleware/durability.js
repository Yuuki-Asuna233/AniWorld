// A successful mutation response promises durable storage, not just a RAM update.
function createDurabilityMiddleware(database) {
  return (req, res, next) => {
    if (req.path === '/api/agent/cancel') return next();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const fail = error => {
      console.error('[DB] Request persistence failed:', error.message);
      res.status(503);
      return send({ error: '数据暂时无法保存，请稍后重试' });
    };
    const send = res.json.bind(res);
    res.json = body => {
      try { database.flushDatabase(); }
      catch (error) { return fail(error); }
      return send(body);
    };
    try { database.flushDatabase(); next(); }
    catch (error) { fail(error); }
  };
}

module.exports = { createDurabilityMiddleware };
