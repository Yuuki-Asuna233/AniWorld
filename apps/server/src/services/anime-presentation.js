function statusFromOiLabel(value) {
  const text = String(value || '').trim();
  if (/即将|未开播|未放送/.test(text)) return 'NOT_YET_RELEASED';
  if (/连载|更新中|放送中/.test(text)) return 'RELEASING';
  if (/完结|完結|已完/.test(text)) return 'FINISHED';
  return '';
}

function resolveAnimeEditionPresentation(title) {
  const value = String(title || '');
  const isReZeroSeason4 = /(?:Re\s*[:：]?\s*)?从零开始的异世界生活.*第\s*四\s*季/i.test(value);
  if (!isReZeroSeason4) return null;
  if (/(?:丧失篇|喪失編)/.test(value)) {
    return { airDate: '2026-04-08', episodes: 11, status: 'FINISHED' };
  }
  if (/(?:夺还篇|奪還編)/.test(value)) {
    const now = Date.now();
    const startsAt = Date.parse('2026-08-12T00:00:00+09:00');
    const finishesAt = Date.parse('2026-10-01T00:00:00+09:00');
    const status = now < startsAt
      ? 'NOT_YET_RELEASED'
      : now < finishesAt ? 'RELEASING' : 'FINISHED';
    return { airDate: '2026-08-12', episodes: 8, status };
  }
  return null;
}

module.exports = {
  statusFromOiLabel,
  resolveAnimeEditionPresentation
};
