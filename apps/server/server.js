// AniWorld Backend - minimal bootstrap.
const express = require('express');
const compression = require('compression');
const path = require('path');
const { loadEnvFile } = require('./src/utils/env');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const WEB_ROOT = path.join(PROJECT_ROOT, 'apps', 'web');
const DATA_ROOT = path.join(PROJECT_ROOT, 'data');

loadEnvFile(path.join(PROJECT_ROOT, '.env'));

const database = require('./database');

const httpFetch = require('./src/services/http');
const { sendVerificationEmail } = require('./src/services/email');
const { cache } = require('./src/services/cache');

const { createAuthMiddleware, requireAuth } = require('./src/middleware/auth');
const { createAccessGate, parseAccessGateEnabled } = require('./src/middleware/access-gate');
const { createDurabilityMiddleware } = require('./src/middleware/durability');

const { mountVideoRoutes } = require('./src/routes/video');
const { mountAnimeRoutes } = require('./src/routes/anime');
const { mountOiapiRoutes } = require('./src/routes/oiapi');
const { mountAuthRoutes } = require('./src/routes/auth');
const { mountUserRoutes } = require('./src/routes/user');
const { mountAgentRoutes } = require('./src/routes/agent');
const { mountAgentAdminRoutes } = require('./src/routes/agent-admin');
const { mountAnimeAdminRoutes } = require('./src/routes/anime-admin');
const { mountKazumiRoutes } = require('./src/routes/kazumi');
const { mountDanmakuRoutes } = require('./src/routes/danmaku');
const { mountAppUpdateRoutes } = require('./src/routes/app-update');
const { mountPlaybackReportRoutes } = require('./src/routes/playback-report');
const { schedulePeriodicSync } = require('./src/services/sync');
const { startRagAutoIndexer } = require('../../baiyu_agent/retrieval/rag-service');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32 || /replace-with|anime_site_jwt_secret/i.test(JWT_SECRET)) {
  throw new Error('JWT_SECRET must be a unique random secret of at least 32 characters');
}
const JWT_EXPIRES = '7d';
const authMiddleware = createAuthMiddleware(JWT_SECRET, database);
const accessGate = createAccessGate({
  enabled: parseAccessGateEnabled(process.env.ACCESS_GATE_ENABLED),
  jwt: require('jsonwebtoken'),
  password: process.env.ACCESS_GATE_PASSWORD,
  secret: process.env.ACCESS_GATE_SECRET,
  tokenTtl: process.env.ACCESS_GATE_TOKEN_TTL || '30d'
});

// Trust only explicitly configured proxy addresses; direct clients cannot spoof IPs.
app.set('trust proxy', process.env.TRUST_PROXY || false);
app.use(compression({ level: 6, threshold: 1024 }));
app.use(express.json({ limit: '10mb' }));
mountAppUpdateRoutes(app, {
  releaseDir: process.env.APP_RELEASE_DIR || path.join(DATA_ROOT, 'releases')
});
mountPlaybackReportRoutes(app);
accessGate.mountRoutes(app);
app.use(accessGate.middleware);
app.use(createDurabilityMiddleware(database));
app.use('/api/auth', authMiddleware);
app.use('/api/user', authMiddleware);
app.use('/api/agent', authMiddleware);
app.use('/api/admin/agent', authMiddleware);
app.use('/api/admin/anime', authMiddleware);
app.use('/api/comments', authMiddleware);
app.use('/api/oi/meta/sync', authMiddleware);

const multer = require('multer');
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});

mountVideoRoutes(app);
mountDanmakuRoutes(app, { httpFetch });
mountAnimeRoutes(app, { database, cache });
mountOiapiRoutes(app, { database, httpFetch, cache, requireAuth });
mountAuthRoutes(app, {
  database,
  jwt: require('jsonwebtoken'),
  bcrypt: require('bcryptjs'),
  sendVerificationEmail,
  avatarUpload,
  JWT_SECRET,
  JWT_EXPIRES,
  requireAuth
});
mountUserRoutes(app, { database, requireAuth });
const agentRuntime = mountAgentRoutes(app, { database, requireAuth });
mountAgentAdminRoutes(app, { database, requireAuth });
mountAnimeAdminRoutes(app, { database, cache, requireAuth });
mountKazumiRoutes(app, { database, httpFetch, cache });

app.get('/search.html', (req, res) => {
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(301, '/search_anime.html' + query);
});

app.use('/uploads', (req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  if (!/^\/avatars\/avatar_[\w-]+\.(?:png|jpg|jpeg|gif|webp)$/i.test(req.path)) {
    return res.sendStatus(404);
  }
  next();
}, express.static(path.join(DATA_ROOT, 'uploads')));
app.use(express.static(WEB_ROOT, {
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (/\.(js|css|png|jpg|jpeg|webp|svg|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/kazumi/') || req.path.includes('.')) return next();
  res.sendFile(path.join(WEB_ROOT, 'index.html'));
});

database.initDatabase().then(() => {
  const server = app.listen(PORT, '0.0.0.0', () => {
    agentRuntime.start();
    console.log(`AniWorld Backend running at http://localhost:${PORT}`);
    console.log(`  Anime Meta in DB: ${database.getAnimeMetaCount()}`);
    schedulePeriodicSync(database, httpFetch);
    startRagAutoIndexer(database);
    console.log('  [INFO] Background metadata sync enabled (starts after 60s, then every 12h)');
    console.log('  [INFO] Stop the API before running independent full/manual sync: npm run sync');
    if (!process.env.SMTP_USER) {
      console.log('  [WARN] SMTP is not configured; verification codes will be printed to the console.');
    }
  });
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const maintenanceStopped = agentRuntime.stop();
      let closed = false;
      const shutdown = async () => {
        if (closed) return;
        closed = true;
        try { await maintenanceStopped; database.closeDatabase(); process.exit(0); }
        catch (error) { console.error('[DB] Shutdown failed:', error.message); process.exit(1); }
      };
      server.close(shutdown);
      setTimeout(() => { server.closeAllConnections(); shutdown(); }, 30000).unref();
    });
  }
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
