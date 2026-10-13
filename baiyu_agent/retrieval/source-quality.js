const TRUSTED_DOMAINS = [
  { pattern: /(^|\.)shinkaiworks\.com$/i, label: '官方/创作者', score: 98 },
  { pattern: /(^|\.)ghibli\.jp$/i, label: '官方/工作室', score: 98 },
  { pattern: /(^|\.)re-zero-anime\.jp$/i, label: '作品官网', score: 98 },
  { pattern: /(^|\.)kadokawa\.co\.jp$/i, label: '官方/出版社', score: 94 },
  { pattern: /(^|\.)aniplex\.co\.jp$/i, label: '官方/发行', score: 94 },
  { pattern: /(^|\.)toho\.co\.jp$/i, label: '官方/发行', score: 92 },
  { pattern: /(^|\.)crunchyroll\.com$/i, label: '发行/新闻', score: 88 },
  { pattern: /(^|\.)animenewsnetwork\.com$/i, label: '动漫新闻', score: 86 },
  { pattern: /(^|\.)anilist\.co$/i, label: '资料库', score: 78 },
  { pattern: /(^|\.)myanimelist\.net$/i, label: '资料库', score: 76 },
  { pattern: /(^|\.)(?:bangumi\.tv|bgm\.tv|chii\.in)$/i, label: '资料库', score: 72 }
];

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch (_) {
    return '';
  }
}

function scoreSource(url) {
  const host = hostnameOf(url);
  const matched = TRUSTED_DOMAINS.find(item => item.pattern.test(host));
  if (matched) return { host, trustLabel: matched.label, trustScore: matched.score };
  if (/\.go\.jp$|\.or\.jp$|\.co\.jp$/i.test(host)) return { host, trustLabel: '日本机构/商业站点', trustScore: 64 };
  return { host, trustLabel: '普通网页', trustScore: 45 };
}

function enrichSearchResults(results = []) {
  return results.map((item, index) => {
    const source = scoreSource(item.url);
    const searchScore = Math.max(0, Math.min(Number(item.score || 0) * 20, 20));
    return {
      ...item,
      host: source.host,
      trustLabel: source.trustLabel,
      trustScore: source.trustScore,
      rankScore: source.trustScore + searchScore - index
    };
  }).sort((a, b) => Number(b.rankScore || 0) - Number(a.rankScore || 0));
}

function reliableResults(results = [], minScore = 70) {
  return enrichSearchResults(results).filter(item => Number(item.trustScore || 0) >= minScore);
}

module.exports = {
  scoreSource,
  enrichSearchResults,
  reliableResults
};
