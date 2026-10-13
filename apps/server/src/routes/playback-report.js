// 播放诊断上报接口（App 直连模式下使用）。
//
// 直连时，播放请求由 App 直接打到上游 CDN，不经过本服务器，
// 所以 `video.js` 的代理日志天然为空。为了让服务器侧也能观察
// "哪些设备加载不出来"，App 在播放成功 / 失败时主动 POST 到这里，
// 服务端统一记录一条带时间戳的诊断日志。
//
// 设计要点：
// - 放在访问网关之前挂载，不受 access_token 限制（失败上报也可能伴随鉴权问题）。
// - 字段全部做长度截断 + 去除换行/引号，防止日志注入伪造。
// - 按来源 IP 做简单限流，避免被刷爆日志。

function sanitize(value, max) {
  return String(value == null ? '' : value)
    .replace(/["\r\n]/g, ' ')
    .slice(0, max);
}

const reportBuckets = new Map();
function rateOk(ip) {
  const now = Date.now();
  if (reportBuckets.size >= 5000 && !reportBuckets.has(ip)) {
    for (const [key, times] of reportBuckets) {
      if (!times.length || now - times.at(-1) >= 10000) reportBuckets.delete(key);
    }
    if (reportBuckets.size >= 5000) return false;
  }
  const arr = reportBuckets.get(ip) || [];
  const recent = arr.filter((t) => now - t < 10000);
  if (recent.length >= 30) {
    reportBuckets.set(ip, recent);
    return false;
  }
  recent.push(now);
  reportBuckets.set(ip, recent);
  return true;
}

function mountPlaybackReportRoutes(app) {
  app.post('/api/playback-report', (req, res) => {
    const ip = sanitize(req.ip, 64);
    if (!rateOk(ip)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }
    const b = req.body || {};
    const fields = {
      result: sanitize(b.result, 16),
      sourceHost: sanitize(b.sourceHost, 256),
      anime: sanitize(b.anime, 256),
      episode: sanitize(b.episode, 64),
      videoType: sanitize(b.videoType, 64),
      os: sanitize(b.os, 32),
      osVersion: sanitize(b.osVersion, 128),
      player: sanitize(b.player, 32),
      error: sanitize(b.error, 1024),
      appVersion: sanitize(b.appVersion, 32),
      buildNumber: sanitize(b.buildNumber, 32),
    };

    const ts = new Date().toISOString();
    const errPart = fields.error ? ` error="${fields.error}"` : '';
    const metrics = Object.fromEntries(['readyMs', 'startupMs', 'visibleMs', 'openMs', 'resolveMs', 'prepareMs', 'engineReadyMs',
      'instanceReused', 'diskCache', 'bufferMs', 'stallCount', 'aheadSeconds', 'attempt', 'inputBytesPerSecond', 'diskBytes']
      .filter(key => Number.isFinite(Number(b[key])))
      .map(key => [key, Math.max(0, Math.min(2 ** 40, Number(b[key])))]));
    // 用空格分隔的 key=value，便于 grep 与后续解析。
    console.log(
      `[playback-report] ts=${ts} ip=${ip} result=${fields.result} ` +
        `host=${fields.sourceHost} codec=${fields.videoType} ` +
        `os=${fields.os} osVer=${fields.osVersion} player=${fields.player} ` +
        `anime=${fields.anime} ep=${fields.episode} app=${fields.appVersion} build=${fields.buildNumber} metrics=${JSON.stringify(metrics)}${errPart}`,
    );
    res.json({ ok: true });
  });
}

module.exports = { mountPlaybackReportRoutes };
