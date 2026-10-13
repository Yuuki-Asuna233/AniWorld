// Auth middleware

function createAuthMiddleware(JWT_SECRET, database) {
  return function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }
    const token = authHeader.split(' ')[1];
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      const user = database.getUserById(decoded.id);
      req.user = user && decoded.version === user.token_version
        ? { id: user.id, email: user.email, username: user.username }
        : null;
    } catch (e) {
      req.user = null;
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  next();
}

module.exports = { createAuthMiddleware, requireAuth };
