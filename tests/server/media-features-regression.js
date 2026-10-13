const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const httpFetch = require('../../apps/server/src/services/http');
const {
  rewriteHlsManifest,
  isHlsManifest
} = require('../../apps/server/src/routes/video');
const {
  createSignature,
  isAllowedPath,
  fetchDanmakuResponse
} = require('../../apps/server/src/routes/danmaku');
const {
  reconcileAiringWithOi
} = require('../../apps/server/src/services/airing-reconcile');
const { mountOiPlaybackRoutes } = require('../../apps/server/src/routes/oiapi-playback');
const {
  currentYearFilter,
  getSectionMeta,
} = require('../../apps/server/src/routes/kazumi');
const {
  resolveCurrentOiSelection
} = require('../../apps/server/src/services/oi-helpers');

function fakeRequest() {
  return {
    protocol: 'http',
    headers: {},
    query: {
      referer: 'https://source.example/watch/1',
      userAgent: 'AniWorld-Test'
    },
    get(name) {
      assert.strictEqual(name, 'host');
      return '192.168.1.8:3000';
    }
  };
}

const manifest = [
  '#EXTM3U',
  '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"',
  '#EXT-X-STREAM-INF:BANDWIDTH=1280000',
  'variants/720p.m3u8',
  '#EXTINF:10,',
  '../segments/001.ts'
].join('\n');

const rewritten = rewriteHlsManifest(
  manifest,
  'https://media.example/show/master/index.m3u8',
  fakeRequest()
);

assert.match(
  rewritten,
  /url=https%3A%2F%2Fmedia\.example%2Fshow%2Fmaster%2Fkeys%2Fkey\.bin/
);
assert.match(
  rewritten,
  /url=https%3A%2F%2Fmedia\.example%2Fshow%2Fmaster%2Fvariants%2F720p\.m3u8/
);
assert.match(
  rewritten,
  /url=https%3A%2F%2Fmedia\.example%2Fshow%2Fsegments%2F001\.ts/
);
assert.match(
  rewritten,
  /referer=https%3A%2F%2Fsource\.example%2Fwatch%2F1/
);
assert.strictEqual(isHlsManifest('https://media.example/a.m3u8', {}), true);
assert.strictEqual(
  isHlsManifest('https://media.example/play', {
    'content-type': 'application/vnd.apple.mpegurl'
  }),
  true
);

assert.strictEqual(isAllowedPath('/api/v2/search/anime'), true);
assert.strictEqual(isAllowedPath('/api/v2/bangumi/123'), true);
assert.strictEqual(isAllowedPath('/api/v2/comment/456'), true);
assert.strictEqual(isAllowedPath('/api/v2/user/profile'), false);
assert.strictEqual(
  createSignature('app', 'key', '/api/v2/comment/1', 100),
  'lvckOeKziZyYU7fiPRGYRQqZWv0nzr5r2RPiFsiQNU0='
);

const yearFilter = currentYearFilter(new Date('2026-07-01T00:00:00Z'));
assert.deepStrictEqual(yearFilter, { year: 2026 });
const rankingCalls = [];
const recentHotRows = [{ anilist_id: 1 }, { anilist_id: 2 }];
const hotResult = getSectionMeta({
  getRankingsFromDb(type, limit, options) {
    rankingCalls.push({ type, limit, options });
    return type === 'yearpopular' ? recentHotRows : [];
  }
}, 'hot', 18);
assert.strictEqual(hotResult, recentHotRows);
assert.strictEqual(rankingCalls[0].type, 'yearpopular');
assert.strictEqual(rankingCalls[0].limit, 18);
assert.strictEqual(rankingCalls[0].options.year, new Date().getFullYear());

async function testAiringEpisodeCounts() {
  const updates = new Map();
  const database = {
    updateAnimeAiringState(id, state) {
      updates.set(id, state);
      return { success: true };
    }
  };
  const httpFetch = async () => ({
    status: 200,
    data: {
      code: 200,
      data: {
        ji: '12|周六16:35后',
        playlist: Array.from({ length: 12 }, (_, index) => `第${index + 1}集`)
      }
    }
  });

  await reconcileAiringWithOi(database, httpFetch, [
    {
      anilist_id: 900001,
      oi_msg: '总集数未公布',
      oi_index: 1,
      episodes: 12,
      status: 'RELEASING',
      next_airing_episode: 13,
      next_airing_at: Math.floor(Date.now() / 1000) + 3600
    },
    {
      anilist_id: 900002,
      oi_msg: '总集数已公布',
      oi_index: 1,
      episodes: 24,
      status: 'RELEASING',
      next_airing_episode: 13,
      next_airing_at: Math.floor(Date.now() / 1000) + 3600
    }
  ]);

  assert.strictEqual(updates.get(900001).episodes, 0);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(updates.get(900002), 'episodes'),
    false
  );
}

async function testOiIndexRefreshByExactTitle() {
  const title = 'Index Drift Regression Exact Title';
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return {
      status: 200,
      data: {
        code: 200,
        data: [
          { name: `${title} Sequel`, year: '2027' },
          { name: title, year: '2026' }
        ]
      }
    };
  };

  const refreshed = await resolveCurrentOiSelection(title, 1, fakeFetch);
  assert.strictEqual(refreshed.msg, title);
  assert.strictEqual(refreshed.index, 2);
  assert.strictEqual(refreshed.exact, true);
  assert.strictEqual(refreshed.refreshed, true);

  const cached = await resolveCurrentOiSelection(title, 2, fakeFetch);
  assert.strictEqual(cached.index, 2);
  assert.strictEqual(cached.refreshed, false);
  assert.strictEqual(calls, 1);
}

async function testRetiredPlaybackRoutes() {
  const routes = new Map();
  mountOiPlaybackRoutes({ get: (path, handler) => routes.set(path, handler) });
  for (const path of ['/api/oi/play', '/api/oi/probe', '/api/oi/sources']) {
    let statusCode;
    let payload;
    routes.get(path)({}, {
      set() {},
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; }
    });
    assert.strictEqual(statusCode, 410);
    assert.strictEqual(payload.code, 'SOURCE_REMOVED');
  }
}

async function testCompressedHttpResponse() {
  const server = http.createServer((req, res) => {
    const body = Buffer.from(JSON.stringify({ ok: true, comments: [1, 2] }));
    zlib.gzip(body, (error, compressed) => {
      if (error) {
        res.destroy(error);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip'
      });
      res.end(compressed);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const response = await httpFetch(`http://127.0.0.1:${address.port}/`, {
      headers: { 'Accept-Encoding': 'gzip' }
    });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.data, { ok: true, comments: [1, 2] });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testDanmakuRetryCacheAndDeduplication() {
  const retryTarget = new URL(
    'https://api.dandanplay.net/api/v2/comment/998877?withRelated=true'
  );
  let retryCalls = 0;
  const retryingFetch = async () => {
    retryCalls += 1;
    if (retryCalls === 1) return { status: 502, data: { error: 'temporary' } };
    return { status: 200, data: { comments: [{ m: 'ok' }] }, headers: {} };
  };
  const first = await fetchDanmakuResponse({
    target: retryTarget,
    pathname: retryTarget.pathname,
    headers: {},
    httpFetch: retryingFetch
  });
  assert.strictEqual(retryCalls, 2);
  assert.strictEqual(first.cacheStatus, 'miss');

  const cached = await fetchDanmakuResponse({
    target: retryTarget,
    pathname: retryTarget.pathname,
    headers: {},
    httpFetch: retryingFetch
  });
  assert.strictEqual(retryCalls, 2);
  assert.strictEqual(cached.cacheStatus, 'hit');

  const dedupeTarget = new URL(
    'https://api.dandanplay.net/api/v2/comment/998878?withRelated=true'
  );
  let dedupeCalls = 0;
  const slowFetch = async () => {
    dedupeCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 20));
    return { status: 200, data: { comments: [] }, headers: {} };
  };
  await Promise.all([
    fetchDanmakuResponse({
      target: dedupeTarget,
      pathname: dedupeTarget.pathname,
      headers: {},
      httpFetch: slowFetch
    }),
    fetchDanmakuResponse({
      target: dedupeTarget,
      pathname: dedupeTarget.pathname,
      headers: {},
      httpFetch: slowFetch
    })
  ]);
  assert.strictEqual(dedupeCalls, 1);
}

Promise.all([
  testAiringEpisodeCounts(),
  testOiIndexRefreshByExactTitle(),
  testRetiredPlaybackRoutes(),
  testCompressedHttpResponse(),
  testDanmakuRetryCacheAndDeduplication()
])
  .then(() => console.log('media features regression: ok'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
