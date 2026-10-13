function createRateLimiter({ windowMs, limit, maxKeys = 10000 }) {
  const buckets = new Map();
  return (req, res, next) => {
    if (req.method === 'GET') return next();
    const now = Date.now();
    for (const [key, value] of buckets) {
      if (value.expires <= now) buckets.delete(key);
    }
    const key = req.ip || req.socket.remoteAddress;
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= maxKeys) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
      bucket = { count: 0, expires: now + windowMs };
      buckets.set(key, bucket);
    }
    if (++bucket.count > limit) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    next();
  };
}

module.exports = { createRateLimiter };
