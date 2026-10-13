const crypto = require('crypto');

const COOKIE_NAME = 'aniworld_access';
const HEADER_NAME = 'x-aniworld-access';
const DEFAULT_TOKEN_TTL = '30d';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function isStrongPassword(password) {
  return typeof password === 'string' &&
    password.length === 18 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password);
}

function validateAccessGateConfig({ password, secret }) {
  if (!isStrongPassword(password)) {
    throw new Error(
      'ACCESS_GATE_PASSWORD must be exactly 18 characters and include uppercase, lowercase, number and symbol.'
    );
  }
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('ACCESS_GATE_SECRET must contain at least 32 characters.');
  }
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch (_) {
      cookies[key] = value;
    }
  }
  return cookies;
}

function secureEqual(left, right) {
  const leftHash = crypto.createHash('sha256').update(String(left)).digest();
  const rightHash = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function isMediaTokenPath(pathname) {
  return pathname === '/api/video' || pathname.startsWith('/api/video/');
}

function extractToken(req) {
  const headerToken = String(req.headers[HEADER_NAME] || '').trim();
  if (headerToken) return headerToken;

  const cookieToken = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (cookieToken) return cookieToken;

  // DLNA renderers cannot attach custom headers, so only the video proxy may
  // accept a token in the URL. Other endpoints deliberately reject query tokens.
  if (isMediaTokenPath(req.path)) {
    return String(req.query.access_token || '').trim();
  }
  return '';
}

function createAccessGate({ jwt, password, secret, tokenTtl = DEFAULT_TOKEN_TTL }) {
  validateAccessGateConfig({ password, secret });
  const attempts = new Map();

  function verifyToken(token) {
    if (!token) return false;
    try {
      const payload = jwt.verify(token, secret, {
        algorithms: ['HS256'],
        issuer: 'aniworld-access-gate',
        audience: 'aniworld-clients',
      });
      return payload && payload.scope === 'access_gate';
    } catch (_) {
      return false;
    }
  }

  function issueToken() {
    return jwt.sign(
      { scope: 'access_gate' },
      secret,
      {
        algorithm: 'HS256',
        expiresIn: tokenTtl,
        issuer: 'aniworld-access-gate',
        audience: 'aniworld-clients',
      }
    );
  }

  function cookieOptions(req, { persistent = false } = {}) {
    return {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure,
      path: '/',
      ...(persistent ? { maxAge: COOKIE_MAX_AGE_MS } : {}),
    };
  }

  function pruneAttempts(now) {
    if (attempts.size < 500) return;
    for (const [key, value] of attempts) {
      if (now - value.windowStart >= ATTEMPT_WINDOW_MS) attempts.delete(key);
    }
  }

  function attemptState(ip, now) {
    const current = attempts.get(ip);
    if (!current || now - current.windowStart >= ATTEMPT_WINDOW_MS) {
      const fresh = { count: 0, windowStart: now };
      attempts.set(ip, fresh);
      return fresh;
    }
    return current;
  }

  function mountRoutes(app) {
    app.get('/api/access/status', (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ unlocked: verifyToken(extractToken(req)) });
    });

    app.post('/api/access/unlock', (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const now = Date.now();
      const ip = getClientIp(req);
      pruneAttempts(now);
      if (!attempts.has(ip) && attempts.size >= 10000) {
        return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS', message: '请求过于频繁，请稍后再试' });
      }
      const state = attemptState(ip, now);
      if (state.count >= MAX_ATTEMPTS) {
        const retryAfter = Math.max(
          1,
          Math.ceil((ATTEMPT_WINDOW_MS - (now - state.windowStart)) / 1000)
        );
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({
          error: 'TOO_MANY_ATTEMPTS',
          message: '尝试次数过多，请稍后再试',
          retryAfter,
        });
      }

      const candidate = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!secureEqual(candidate, password)) {
        state.count += 1;
        return res.status(401).json({
          error: 'INVALID_ACCESS_PASSWORD',
          message: '访问密码错误',
          attemptsRemaining: Math.max(0, MAX_ATTEMPTS - state.count),
        });
      }

      attempts.delete(ip);
      const token = issueToken();
      res.cookie(COOKIE_NAME, token, cookieOptions(req, { persistent: true }));
      return res.json({ success: true, token });
    });

    app.post('/api/access/logout', (req, res) => {
      res.clearCookie(COOKIE_NAME, cookieOptions(req));
      res.json({ success: true });
    });
  }

  function middleware(req, res, next) {
    if (
      req.path === '/access.html' ||
      req.path === '/api/access/status' ||
      req.path === '/api/access/unlock' ||
      req.path === '/api/access/logout'
    ) {
      return next();
    }
    if (verifyToken(extractToken(req))) return next();

    res.setHeader('Cache-Control', 'no-store');
    const protectedApi =
      req.path.startsWith('/api/') || req.path.startsWith('/kazumi/');
    if (protectedApi || req.method !== 'GET') {
      return res.status(401).json({
        error: 'ACCESS_REQUIRED',
        message: '请输入访问密码后继续',
      });
    }

    const nextUrl = req.originalUrl && req.originalUrl !== '/'
      ? `?next=${encodeURIComponent(req.originalUrl)}`
      : '';
    return res.redirect(302, `/access.html${nextUrl}`);
  }

  return { mountRoutes, middleware, verifyToken, issueToken };
}

module.exports = {
  COOKIE_NAME,
  createAccessGate,
  isStrongPassword,
  validateAccessGateConfig,
};
