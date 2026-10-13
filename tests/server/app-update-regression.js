const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mountAppUpdateRoutes } = require('../../apps/server/src/routes/app-update');
const { createAccessGate } = require('../../apps/server/src/middleware/access-gate');

async function main() {
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aniworld-release-'));
  const oldName = 'AniWorld_android_2.1.8.apk';
  const latestName = 'AniWorld_android_2.2.0.apk';
  const windowsName = 'AniWorld_windows_2.2.0.zip';
  fs.writeFileSync(path.join(releaseDir, oldName), 'old-apk');
  fs.writeFileSync(path.join(releaseDir, latestName), 'latest-apk-content');
  fs.writeFileSync(path.join(releaseDir, windowsName), 'latest-windows-content');

  const app = express();
  mountAppUpdateRoutes(app, { releaseDir });
  app.use(express.json());
  const gate = createAccessGate({
    jwt,
    password: 'Aa1!Bb2@Cc3#Dd4$Ee',
    secret: 'test-only-access-gate-secret-with-at-least-32-characters',
  });
  gate.mountRoutes(app);
  app.use(gate.middleware);
  app.get('/api/private', (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    let response = await fetch(`${base}/kazumi/v1/app/latest`);
    assert.strictEqual(response.status, 200);
    const metadata = await response.json();
    assert.strictEqual(metadata.tag_name, '2.2.0');
    assert.strictEqual(metadata.assets.length, 2);
    assert.strictEqual(metadata.assets[0].name, latestName);
    assert.strictEqual(metadata.assets[1].name, windowsName);
    assert.strictEqual(
      metadata.assets[0].digest,
      `sha256:${crypto.createHash('sha256').update('latest-apk-content').digest('hex')}`
    );
    assert.strictEqual(
      metadata.assets[1].digest,
      `sha256:${crypto.createHash('sha256').update('latest-windows-content').digest('hex')}`
    );

    response = await fetch(metadata.assets[0].browser_download_url);
    assert.strictEqual(response.status, 200);
    assert.match(response.headers.get('cache-control') || '', /no-store/);
    assert.strictEqual(
      response.headers.get('x-checksum-sha256'),
      crypto.createHash('sha256').update('latest-apk-content').digest('hex')
    );
    assert.strictEqual(await response.text(), 'latest-apk-content');

    response = await fetch(metadata.assets[1].browser_download_url);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(await response.text(), 'latest-windows-content');

    response = await fetch(`${base}/api/private`);
    assert.strictEqual(response.status, 401);

    response = await fetch(`${base}/app-releases/not-an-apk.txt`);
    assert.strictEqual(response.status, 404);
    console.log('App update regression checks passed.');
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    fs.rmSync(releaseDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
