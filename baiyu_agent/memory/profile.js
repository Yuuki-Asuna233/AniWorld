const { safeJsonParse } = require('../../apps/server/src/utils/db-helpers');
const { parseUserMemory } = require('./user-memory');

const EVENT_WEIGHTS = {
  detail_view: 0.5,
  play_start: 1,
  episode_complete: 4,
  favorite: 5,
  recommend_click: 1,
  not_interested: -6
};

function resolveMeta(database, row) {
  // Persisted identity is authoritative; unresolved legacy rows do not teach
  // the profile facts about a fuzzy title candidate or another season.
  const canonicalId = Number(row?.anilist_id)
    || Number(String(row?.anime_id || '').match(/^anilist_(\d+)$/)?.[1]) || 0;
  return canonicalId ? database.getAnimeMetaById(canonicalId) : null;
}

function addAffinity(map, values, weight) {
  for (const value of values || []) {
    if (!value) continue;
    map.set(value, (map.get(value) || 0) + weight);
  }
}

function sortedAffinity(map, limit = 8) {
  return [...map.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, score]) => ({ name, score: Number(score.toFixed(2)) }));
}

function buildUserProfile(database, userId) {
  if (!userId) {
    return {
      personalized: false,
      genres: [],
      tags: [],
      recentAnime: [],
      watchedIds: [],
      dislikedIds: [],
      preferredStatus: ''
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const favorites = database.getFavorites(userId);
  const history = database.getHistory(userId, 80);
  const events = database.getUserAnimeEvents(userId, 250);
  const feedback = database.getRecommendationFeedback(userId, 250);
  const genreAffinity = new Map();
  const tagAffinity = new Map();
  const animeWeights = new Map();
  const metaById = new Map();
  const exclusions = database.getRecommendationExclusions(userId);
  const watchedIds = new Set(exclusions.watchedIds);
  const dislikedIds = new Set(exclusions.dislikedIds);
  const alreadyWatchedIds = new Set(exclusions.alreadyWatchedIds);
  let finishedSignals = 0;
  let releasingSignals = 0;

  function applyMeta(meta, weight, timestamp) {
    if (!meta) return;
    const ageDays = Math.max(0, (now - (Number(timestamp) || now)) / 86400);
    const decayed = weight * Math.exp(-ageDays / 60);
    const id = Number(meta.anilist_id);
    if (id) {
      metaById.set(id, meta);
      animeWeights.set(id, (animeWeights.get(id) || 0) + decayed);
    }
    addAffinity(genreAffinity, safeJsonParse(meta.genres || '[]', []), decayed);
    addAffinity(tagAffinity, safeJsonParse(meta.content_tags || '[]', []), decayed * 0.7);
    if (meta.status === 'FINISHED') finishedSignals += Math.max(0, decayed);
    if (meta.status === 'RELEASING') releasingSignals += Math.max(0, decayed);
  }

  for (const item of favorites) {
    const meta = resolveMeta(database, item);
    applyMeta(meta, 5, item.created_at);
    if (meta?.anilist_id) watchedIds.add(Number(meta.anilist_id));
  }

  for (const item of history) {
    const meta = resolveMeta(database, item);
    const progress = Number(item.progress) || 0;
    const weight = progress >= 80 ? 4 : progress >= 20 ? 2 : 1;
    applyMeta(meta, weight, item.updated_at);
    if (meta?.anilist_id) watchedIds.add(Number(meta.anilist_id));
    if (meta?.anilist_id && progress >= 80) alreadyWatchedIds.add(Number(meta.anilist_id));
  }

  for (const event of events) {
    const id = Number(event.anilist_id) || 0;
    if (!id) continue;
    const meta = database.getAnimeMetaById(id);
    const baseWeight = EVENT_WEIGHTS[event.event_type] ?? Number(event.value) ?? 0;
    applyMeta(meta, baseWeight, event.created_at);
    if (event.event_type === 'not_interested') dislikedIds.add(id);
  }

  for (const item of feedback) {
    const id = Number(item.anilist_id) || 0;
    if (id && ['not_interested', 'dislike', 'already_watched'].includes(item.action)) {
      dislikedIds.add(id);
    }
    if (id && item.action === 'already_watched') alreadyWatchedIds.add(id);
  }

  const recentAnime = [...animeWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, weight]) => {
      const meta = metaById.get(id) || database.getAnimeMetaById(id);
      return {
        id,
        title: meta?.title_chinese || meta?.title_romaji || meta?.title_native || String(id),
        weight: Number(weight.toFixed(2))
      };
    });

  const genres = sortedAffinity(genreAffinity);
  const tags = sortedAffinity(tagAffinity);

  return {
    personalized: favorites.length > 0 || history.length > 0 || events.length > 0,
    genres,
    tags,
    recentAnime,
    watchedIds: [...watchedIds],
    dislikedIds: [...dislikedIds],
    alreadyWatchedIds: [...alreadyWatchedIds],
    preferredStatus: finishedSignals > releasingSignals * 1.4 ? 'FINISHED' : '',
    negativeSignals: {
      disliked: dislikedIds.size,
      alreadyWatched: alreadyWatchedIds.size
    },
    diversity: {
      genreCount: genres.length,
      tagCount: tags.length,
      topGenres: genres.slice(0, 4).map(item => item.name)
    },
    signalCounts: {
      favorites: favorites.length,
      history: history.length,
      events: events.length,
      feedback: feedback.length
    }
  };
}

function buildUserMemoryStore(database, userId, storedMemory = '') {
  const behavior = buildUserProfile(database, userId);
  const memory = parseUserMemory(storedMemory);
  return {
    preferences: memory.preferences,
    facts: memory.facts,
    titles: memory.titles,
    behavior: {
      personalized: Boolean(behavior.personalized),
      genres: behavior.genres || [],
      tags: behavior.tags || [],
      recentAnime: behavior.recentAnime || [],
      preferredStatus: behavior.preferredStatus || '',
      negativeSignals: behavior.negativeSignals || {},
      diversity: behavior.diversity || {},
      signalCounts: behavior.signalCounts || {}
    }
  };
}

module.exports = { buildUserProfile, buildUserMemoryStore, resolveMeta };
