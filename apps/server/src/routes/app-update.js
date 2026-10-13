const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APK_NAME_PATTERN = /^(?:AniWorld|Kazumi)[-_]android.*?(\d+\.\d+\.\d+).*\.apk$/i;
const WINDOWS_ZIP_NAME_PATTERN = /^(?:AniWorld|Kazumi)[-_]windows.*?(\d+\.\d+\.\d+).*\.zip$/i;
const RELEASE_NAME_PATTERN = /^(?:AniWorld|Kazumi)[-_](?:android|windows).*?(\d+\.\d+\.\d+).*\.(?:apk|zip)$/i;

function parseVersionFromName(name) {
  const match = RELEASE_NAME_PATTERN.exec(String(name || ''));
  if (!match) return null;
  return {
    text: match[1],
    parts: match[1].split('.').map(Number),
  };
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.parts[index] || 0) - (right.parts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function findLatestByPattern(releaseDir, pattern, extension) {
  if (!fs.existsSync(releaseDir)) return null;
  return fs.readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => {
      const version = pattern.exec(entry.name)?.[1];
      if (!version) return null;
      const parsedVersion = {
        text: version,
        parts: version.split('.').map(Number),
      };
      pattern.lastIndex = 0;
      const filePath = path.join(releaseDir, entry.name);
      return { name: entry.name, filePath, version: parsedVersion, stat: fs.statSync(filePath) };
    })
    .filter(Boolean)
    .sort((left, right) => compareVersions(right.version, left.version))[0] || null;
}

function findLatestApk(releaseDir) {
  return findLatestByPattern(releaseDir, APK_NAME_PATTERN, '.apk');
}

function findLatestWindowsZip(releaseDir) {
  return findLatestByPattern(releaseDir, WINDOWS_ZIP_NAME_PATTERN, '.zip');
}

function findLatestRelease(releaseDir) {
  if (!fs.existsSync(releaseDir)) return null;
  return fs.readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const version = parseVersionFromName(entry.name);
      if (!version) return null;
      const filePath = path.join(releaseDir, entry.name);
      return { name: entry.name, filePath, version, stat: fs.statSync(filePath) };
    })
    .filter(Boolean)
    .sort((left, right) => compareVersions(right.version, left.version))[0] || null;
}

function absoluteUrl(req, pathname) {
  const proto = String(req.protocol || 'http')
    .split(',')[0]
    .trim();
  return `${proto}://${req.get('host')}${pathname}`;
}

async function toReleaseAsset(req, file, readDigest) {
  if (!file) return null;
  const encodedName = encodeURIComponent(file.name);
  const downloadPath = `/app-releases/${encodedName}`;
  const downloadUrl = absoluteUrl(req, downloadPath);
  const digest = await readDigest(file);
  return {
    name: file.name,
    size: file.stat.size,
    digest: `sha256:${digest}`,
    browser_download_url: downloadUrl,
    mirror_download_url: downloadUrl,
  };
}

function createDigestReader() {
  const cache = new Map();
  return async function sha256(file) {
    const key = `${file.filePath}:${file.stat.size}:${file.stat.mtimeMs}`;
    if (cache.has(key)) return cache.get(key);
    const pending = new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const input = fs.createReadStream(file.filePath);
      input.on('error', reject);
      input.on('data', (chunk) => hash.update(chunk));
      input.on('end', () => resolve(hash.digest('hex')));
    });
    cache.clear();
    cache.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      cache.delete(key);
      throw error;
    }
  };
}

function mountAppUpdateRoutes(app, options = {}) {
  const releaseDir = path.resolve(
    options.releaseDir || path.join(process.cwd(), 'data', 'releases')
  );
  fs.mkdirSync(releaseDir, { recursive: true });
  const readDigest = createDigestReader();

  // This endpoint intentionally sits outside the access gate. It contains no
  // anime data and lets an already installed legacy APK upgrade into a build
  // that supports the gate.
  app.get('/kazumi/v1/app/latest', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const platform = String(req.query.platform || '');
      if (platform && !['windows', 'android'].includes(platform)) return res.status(400).json({ error: 'Unsupported update platform' });
      const latest = platform === 'windows' ? findLatestWindowsZip(releaseDir)
        : platform === 'android' ? findLatestApk(releaseDir) : findLatestRelease(releaseDir);
      if (!latest) {
        return res.json({
          tag_name: '0.0.0',
          body: '暂无可用更新',
          html_url: '',
          published_at: '',
          assets: [],
        });
      }

      const assets = [];
      const latestApk = findLatestApk(releaseDir);
      const latestWindowsZip = findLatestWindowsZip(releaseDir);
      for (const file of [latestApk, latestWindowsZip].filter(file => file && file.version.text === latest.version.text && (!platform || file.name.toLowerCase().includes(platform)))) {
        const asset = await toReleaseAsset(req, file, readDigest);
        if (asset) assets.push(asset);
      }

      return res.json({
        tag_name: latest.version.text,
        body: String(process.env.APP_UPDATE_NOTES || 'AniWorld 新版本可用'),
        html_url: String(process.env.APP_UPDATE_RELEASE_URL || ''),
        published_at: latest.stat.mtime.toISOString(),
        assets,
      });
    } catch (error) {
      console.error('[app-update] Failed to build release metadata:', error.message);
      return res.status(500).json({ error: 'Update metadata unavailable' });
    }
  });

  app.get('/app-releases/:file', async (req, res) => {
    const fileName = path.basename(String(req.params.file || ''));
    if (!RELEASE_NAME_PATTERN.test(fileName)) return res.status(404).end();
    const filePath = path.resolve(releaseDir, fileName);
    if (path.dirname(filePath) !== releaseDir || !fs.existsSync(filePath)) {
      return res.status(404).end();
    }
    try {
      const stat = fs.statSync(filePath);
      const digest = await readDigest({ filePath, stat });
      res.setHeader(
        'Content-Type',
        fileName.toLowerCase().endsWith('.apk')
          ? 'application/vnd.android.package-archive'
          : 'application/zip'
      );
      // APKs may be re-uploaded after a failed deployment. Prevent device,
      // carrier and reverse-proxy caches from serving bytes that no longer
      // match the digest returned by /kazumi/v1/app/latest.
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
      res.setHeader('X-Checksum-SHA256', digest);
      return res.download(filePath, fileName);
    } catch (error) {
      console.error('[app-update] Failed to serve release:', error.message);
      return res.status(500).json({ error: 'Release download unavailable' });
    }
  });

  return { releaseDir };
}

module.exports = {
  APK_NAME_PATTERN,
  RELEASE_NAME_PATTERN,
  WINDOWS_ZIP_NAME_PATTERN,
  compareVersions,
  findLatestApk,
  findLatestRelease,
  findLatestWindowsZip,
  mountAppUpdateRoutes,
  parseVersionFromName,
};
