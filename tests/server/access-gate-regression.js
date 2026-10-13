const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const {
  createAccessGate,
  isStrongPassword,
} = require('../../apps/server/src/middleware/access-gate');
const { rewriteHlsManifest } = require('../../apps/server/src/routes/video');

const PASSWORD = 'Aa1!Bb2@Cc3#Dd4$Ee';
const SECRET = 'test-only-access-gate-secret-with-at-least-32-characters';

async function main() {
  assert.strictEqual(PASSWORD.length, 18);
  assert.strictEqual(isStrongPassword(PASSWORD), true);
  assert.strictEqual(isStrongPassword('only-lowercase-123'), false);

  const app = express();
  app.use(express.json());
  const gate = createAccessGate({ jwt, password: PASSWORD, secret: SECRET });
  gate.mountRoutes(app);
  app.use(gate.middleware);
  app.get('/api/private', (_req, res) => res.json({ ok: true }));
  app.get('/api/video', (_req, res) => res.json({ ok: true }));
  app.get('/inside', (_req, res) => res.send('inside'));

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    let response = await fetch(`${base}/api/private`, { redirect: 'manual' });
    assert.strictEqual(response.status, 401);
    assert.strictEqual((await response.json()).error, 'ACCESS_REQUIRED');

    response = await fetch(`${base}/inside`, { redirect: 'manual' });
    assert.strictEqual(response.status, 302);
    assert.strictEqual(response.headers.get('location'), '/access.html?next=%2Finside');

    response = await fetch(`${base}/api/access/status`);
    assert.deepStrictEqual(await response.json(), { unlocked: false });

    response = await fetch(`${base}/api/access/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    assert.strictEqual(response.status, 401);

    response = await fetch(`${base}/api/access/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.strictEqual(response.status, 200);
    const unlocked = await response.json();
    assert.ok(unlocked.token);
    const payload = jwt.decode(unlocked.token);
    assert.strictEqual(payload.exp - payload.iat, 30 * 24 * 60 * 60);
    assert.ok(response.headers.get('set-cookie').includes('Max-Age=2592000'));
    const cookie = response.headers.get('set-cookie').split(';')[0];

    response = await fetch(`${base}/api/private`, {
      headers: { 'x-aniworld-access': unlocked.token },
    });
    assert.strictEqual(response.status, 200);

    response = await fetch(`${base}/api/private`, { headers: { cookie } });
    assert.strictEqual(response.status, 200);

    response = await fetch(
      `${base}/api/private?access_token=${encodeURIComponent(unlocked.token)}`
    );
    assert.strictEqual(response.status, 401);

    response = await fetch(
      `${base}/api/video?access_token=${encodeURIComponent(unlocked.token)}`
    );
    assert.strictEqual(response.status, 200);

    const rewritten = rewriteHlsManifest(
      '#EXTM3U\nsegment-01.ts',
      'https://media.example/show/master.m3u8',
      {
        protocol: 'http',
        headers: {},
        query: { access_token: unlocked.token },
        get: () => '127.0.0.1:3000',
      }
    );
    assert.ok(rewritten.includes('access_token='));
    assert.ok(rewritten.includes('segment-01.ts'));

    console.log('Access gate regression checks passed.');
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
