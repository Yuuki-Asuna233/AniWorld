const { hkDateKey } = require('../shared/date-context');
const { TIME_ZONE, OFFSET_MS } = require('../shared/business-time');
const { toCard } = require('../retrieval/recommender');
const { compactCard } = require('./anime-data');
const DAY_MS = 86400000;

function resolveScheduleDate(value, now = new Date()) {
  const raw = String(value || '').trim();
  const offsets = { today: 0, tomorrow: 1, after_tomorrow: 2 };
  return Object.hasOwn(offsets, raw) ? hkDateKey(new Date(now.getTime() + offsets[raw] * DAY_MS)) : raw;
}

function scheduleWindow(date, now = new Date()) {
  const dateKey = resolveScheduleDate(date, now);
  const start = dateKey ? Date.parse(dateKey + 'T00:00:00Z') - OFFSET_MS : now.getTime();
  if (!Number.isFinite(start)) throw new Error('SCHEDULE_DATE_INVALID');
  return { date: dateKey, from: Math.floor(start / 1000),
    until: Math.floor((start + (dateKey ? DAY_MS : 7 * DAY_MS)) / 1000), timeZone: TIME_ZONE };
}

function trackedAnime(database, userId, includeHistory) {
  const favorites = database.getFavorites(userId);
  const history = includeHistory ? database.getHistory(userId, 120) : [];
  const ids = new Set();
  let unresolvedCount = 0;
  for (const row of [...favorites, ...history]) {
    const id = Number(row.anilist_id) || Number(String(row.anime_id || '').match(/^anilist_(\d+)$/)?.[1]) || 0;
    if (id && database.getAnimeMetaById(id)) ids.add(id);
    else unresolvedCount++;
  }
  return { ids: [...ids], unresolvedCount, signalCounts: { favorites: favorites.length, history: history.length } };
}

function airingSchedule(args, { database, userId }, personal = false) {
  if (personal && !userId) return { requiresLogin: true, items: [], cards: [] };
  const window = scheduleWindow(args.date);
  const offset = args.offset || 0, limit = Math.max(1, Math.min(args.limit || 12, 20));
  const tracked = personal ? trackedAnime(database, userId, args.includeHistory !== false) : null;
  // Scope and time filtering happen before the database limit, including personal queries.
  const page = database.getAgentAiringSchedule({ ...window, query: args.query || '',
    anilistIds: tracked?.ids, offset, limit: limit + 1 });
  const rows = page.slice(0, limit);
  const cards = rows.map(row => toCard(row,
    `预计 ${new Date(row.next_airing_at * 1000).toLocaleString('zh-CN', { timeZone: TIME_ZONE })} 放送`));
  return { ...window, cards, dataSource: 'local_airing_schedule',
    nextOffset: page.length > limit ? offset + rows.length : null,
    items: rows.map((row, index) => ({ ...compactCard(cards[index]),
      nextEpisode: row.next_airing_episode || 0, airingAt: row.next_airing_at,
      elapsed: row.next_airing_at <= Math.floor(Date.now() / 1000) })),
    ...(tracked ? { scopedToUser: true, trackedCount: tracked.ids.length,
      historyWindow: args.includeHistory !== false ? 120 : 0,
      unresolvedCount: tracked.unresolvedCount, partial: tracked.unresolvedCount > 0,
      signalCounts: tracked.signalCounts } : {}) };
}

module.exports = { airingSchedule, resolveScheduleDate };
