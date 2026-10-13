const { randomUUID } = require('crypto');
const { toCard } = require('../retrieval/recommender');
const { INTENTS } = require('../agents/action-types');
const { resolveAnimeMetadataDetailed } = require('../../apps/server/src/services/anime-identity');

function animeIdFromMeta(meta) {
  if (Number(meta?.anilist_id) > 0) return `anilist_${Number(meta.anilist_id)}`;
  const msg = String(meta?.oi_msg || '').trim();
  const n = Number(meta?.oi_index) || 1;
  if (msg) return `oiapi_${msg.replace(/\//g, '_')}_${n}`;
  return `anilist_${Number(meta?.anilist_id) || 0}`;
}

function animeIdFromPageContext(pageContext = {}) {
  if (Number(pageContext.anilistId) > 0) return `anilist_${Number(pageContext.anilistId)}`;
  const msg = String(pageContext.msg || '').trim();
  const n = Number(pageContext.n || 1) || 1;
  if (msg) return `oiapi_${msg.replace(/\//g, '_')}_${n}`;
  const id = Number(pageContext.anilistId) || 0;
  return id ? `anilist_${id}` : '';
}

function playUrlFromMeta(meta, fallbackTitle = '') {
  const msg = String(meta?.oi_msg || '').trim();
  const n = Number(meta?.oi_index) || 1;
  if (msg) return `/anime.html?msg=${encodeURIComponent(msg)}&n=${n}`;
  const title = String(meta?.title_chinese || meta?.title_romaji || meta?.title_native || fallbackTitle || '').trim();
  return title ? `/search_anime.html?q=${encodeURIComponent(title)}` : '';
}

function playUrlFromPageContext(pageContext = {}) {
  const msg = String(pageContext.msg || '').trim();
  const n = Number(pageContext.n || 1) || 1;
  if (msg) return `/anime.html?msg=${encodeURIComponent(msg)}&n=${n}`;
  return '';
}

function refersToPage(message) {
  // Tool query is already an explicit title. An omitted query selects the
  // supplied page snapshot; prose must never be parsed again here.
  return !String(message || '').trim();
}

function findAnimeTarget({ database, message, pageContext = {} }) {
  const contextId = Number(pageContext.anilistId) || 0;
  const usePage = refersToPage(message);
  if (contextId && usePage) {
    const meta = database.getAnimeMetaById(contextId);
    if (meta) return { meta, source: 'page' };
  }

  const query = String(message || pageContext.title || pageContext.msg || '').trim();
  if (query) {
    const resolution = resolveAnimeMetadataDetailed(database, query, {
      limit: 30,
      minimumScore: 500
    });
    if (resolution.selected) {
      return { meta: resolution.selected, source: 'search', query, resolution };
    }
    return { meta: null, source: 'search', query, resolution };
  }
  return { meta: null, source: '', query, resolution: { status: 'not_found', candidates: [], confidence: 0 } };
}

function favoritePayloadFromMeta(meta, pageContext = {}) {
  const card = toCard(meta);
  const animeId = animeIdFromMeta(meta) || animeIdFromPageContext(pageContext);
  return {
    anilist_id: Number(meta.anilist_id) || Number(pageContext.anilistId) || 0,
    anime_id: animeId,
    anime_title: card.title || pageContext.title || '',
    anime_image: card.image || '',
    anime_msg: String(meta.oi_msg || pageContext.msg || ''),
    anime_n: Number(meta.oi_index || pageContext.n || 1) || 1,
    oi_index: Number(meta.oi_index || pageContext.n || 1) || 1
  };
}

function favoritePayloadFromPageContext(pageContext = {}) {
  const animeId = animeIdFromPageContext(pageContext);
  const title = String(pageContext.title || pageContext.msg || '').trim();
  const n = Number(pageContext.n || 1) || 1;
  return {
    anilist_id: Number(pageContext.anilistId) || 0,
    anime_id: animeId,
    anime_title: title,
    anime_image: String(pageContext.image || ''),
    anime_msg: String(pageContext.msg || ''),
    anime_n: n,
    oi_index: n
  };
}

function cardFromPagePayload(payload) {
  return { anilistId: payload.anilist_id || 0, animeId: payload.anime_id,
    title: payload.anime_title, image: payload.anime_image || '', score: 0,
    year: '', status: '', genres: [], episodes: 0,
    href: playUrlFromPageContext({ msg: payload.anime_msg, n: payload.anime_n }) };
}

function requireLogin(userId) {
  if (userId) return null;
  return {
    answer: '这个操作需要登录后才能帮你完成。你可以先去“我的”页面登录，登录后白羽就能帮你追番、改追番状态和删除你的观看历史。',
    cards: [],
    suggestions: ['去登录', '先推荐几部动漫', '查今天更新'],
    actions: [{ type: 'navigate', url: '/my.html', delayMs: 900 }],
    fallback: true
  };
}

function targetNotFound(message) {
  return {
    answer: `我还没能确认“${String(message || '').slice(0, 50)}”对应的站内作品。请补充中文、日文或罗马字完整标题。`,
    cards: [],
    suggestions: ['换成完整标题', '先搜索这部番', '推荐几部类似的'],
    fallback: true
  };
}

function targetAmbiguous(target, message) {
  const candidates = (target?.resolution?.candidates || []).slice(0, 3);
  const cards = candidates.map(item => toCard(item.meta, '可能的匹配')).filter(Boolean);
  const names = cards.map((card, index) => `${index + 1}.《${card.title}》`).join('；');
  return {
    answer: `我找到了多个可能的作品${names ? `：${names}` : ''}。请告诉我你要操作哪一部，再继续执行。`,
    cards,
    suggestions: cards.slice(0, 3).map(card => card.title),
    fallback: true,
    intent: target?.intent,
    ambiguous: true
  };
}

function confirmationAction({ intent, message, pageContext, meta, payload }) {
  const operationId = randomUUID();
  const target = payload || favoritePayloadFromMeta(meta, pageContext);
  const fixedPage = { anilistId: target.anilist_id, title: target.anime_title, msg: target.anime_msg, n: target.anime_n };
  const title = payload?.anime_title || (meta ? toCard(meta).title : '这部番');
  const label = intent === INTENTS.DELETE_HISTORY ? `删除《${title}》的观看历史` : `取消追番《${title}》`;
  return {
    answer: `这项操作会${label}，且可能无法恢复。请确认要继续吗？`,
    cards: meta ? [toCard(meta, '等待确认')] : [cardFromPagePayload(target)],
    suggestions: ['确认', '取消'],
    actions: [{
      type: 'confirm', operationId,
      intent,
      label,
      danger: intent === INTENTS.DELETE_HISTORY,
      confirmText: '确认',
      cancelText: '取消'
    }],
    pendingAction: JSON.stringify({ version: 2, operationId, intent, message: String(message || '').slice(0, 2000), pageContext: fixedPage, target, createdAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000 }),
    fallback: true,
    intent
  };
}

function executeAgentAction({ intent, message, database, userId, pageContext = {}, confirmed = false, boundPayload = null, playback = {} }) {
  const loginError = [INTENTS.FOLLOW_ANIME, INTENTS.UNFOLLOW_ANIME, INTENTS.DELETE_HISTORY].includes(intent)
    ? requireLogin(userId)
    : null;
  if (loginError) return { ...loginError, intent };

  const explicit = !refersToPage(message);
  if (explicit && !boundPayload) pageContext = {};
  const target = boundPayload
    ? { meta: database.getAnimeMetaById(boundPayload.anilist_id), source: 'confirmed' }
    : findAnimeTarget({ database, message, pageContext });
  target.intent = intent;
  const meta = target.meta;
  const contextPayload = boundPayload || favoritePayloadFromPageContext(pageContext);
  if (target.resolution?.status === 'ambiguous') {
    return targetAmbiguous(target, message);
  }
  if (!meta && ![INTENTS.NAVIGATE_PLAY, INTENTS.DELETE_HISTORY].includes(intent) && !contextPayload.anime_id) {
    return { ...targetNotFound(message), intent };
  }

  if (intent === INTENTS.FOLLOW_ANIME) {
    const payload = boundPayload || (meta ? favoritePayloadFromMeta(meta, pageContext) : contextPayload);
    if (!payload.anime_id || !payload.anime_title) return { ...targetNotFound(message), intent };
    const result = database.addFavorite(userId, payload);
    if (result.error) {
      return { error: result.error, errorCode: 'BUSINESS_WRITE_FAILED', answer: `追番失败：${result.error}`, cards: [], suggestions: ['再试一次', '打开播放页', '查看我的追番'], fallback: true, intent };
    }
    const title = payload.anime_title;
    const actions = [{ type: 'collect', operation: 'add', collectType: 2, anilistId: payload.anilist_id, animeId: payload.anime_id, title }];
    let answer = result.already ? `《${title}》已经在你的追番列表里啦。` : `好，已经帮你追番《${title}》。`;
    answer += '之后你可以问我“我的追番明天更新什么”。';
    return {
      answer,
      cards: meta ? [toCard(meta, result.already ? '已经在你的追番列表中' : '刚刚加入追番')] : [cardFromPagePayload(payload)],
      actions,
      suggestions: ['我的追番明天更新什么', '打开播放页', '推荐几部类似的'],
      fallback: true,
      intent
    };
  }

  if (intent === INTENTS.UNFOLLOW_ANIME) {
    const payload = boundPayload || (meta ? favoritePayloadFromMeta(meta, pageContext) : contextPayload);
    if (!payload.anime_id || !payload.anime_title) return { ...targetNotFound(message), intent };
    if (!confirmed) return confirmationAction({ intent, message, pageContext, meta, payload });
    const result = database.removeFavorite(userId, payload.anime_id);
    if (result.error) {
      return { error: result.error, errorCode: 'BUSINESS_WRITE_FAILED', answer: `取消追番失败：${result.error}`, cards: [], suggestions: ['再试一次', '查看我的追番'], fallback: true, intent };
    }
    return {
      answer: `已帮你把《${payload.anime_title}》从追番列表移除。`,
      cards: meta ? [toCard(meta, '已取消追番')] : [cardFromPagePayload(payload)],
      actions: [{ type: 'collect', operation: 'remove', anilistId: payload.anilist_id, animeId: payload.anime_id, title: payload.anime_title }],
      suggestions: ['推荐几部类似的', '查看我的追番', '查今天更新'],
      fallback: true,
      intent
    };
  }

  if (intent === INTENTS.DELETE_HISTORY) {
    const payload = boundPayload || (meta ? favoritePayloadFromMeta(meta, pageContext) : contextPayload);
    const animeId = payload?.anime_id || contextPayload.anime_id;
    if (!animeId) return { ...targetNotFound(message), intent };
    if (!confirmed) return confirmationAction({ intent, message, pageContext, meta, payload });
    const result = database.removeHistory(userId, animeId, { deferSave: true });
    if (result.error) {
      return { error: result.error, errorCode: 'BUSINESS_WRITE_FAILED', answer: `删除观看历史失败：${result.error}`, cards: [], suggestions: ['再试一次', '查看历史记录'], fallback: true, intent };
    }
    return {
      answer: `已经帮你删除${payload?.anime_title ? `《${payload.anime_title}》` : '这部番'}的观看历史记录。`,
      cards: meta ? [toCard(meta, '观看历史已删除')] : [cardFromPagePayload(payload)],
      actions: [{ type: 'history_remove', anilistId: payload?.anilist_id || contextPayload.anilist_id, animeId: payload?.anime_id || contextPayload.anime_id, title: payload?.anime_title || contextPayload.anime_title || '' }],
      suggestions: ['查看历史记录', '重新打开播放页', '推荐几部类似的'],
      fallback: true,
      intent
    };
  }

  if (intent === INTENTS.NAVIGATE_PLAY) {
    const url = meta ? playUrlFromMeta(meta, pageContext.title) : playUrlFromPageContext(pageContext);
    if (!url || !url.startsWith('/')) return { ...targetNotFound(message), intent };
    const title = meta ? toCard(meta).title : (pageContext.title || '这部番');
    const episode = playback?.episode ?? 1, resume = playback?.resume === true;
    return {
      answer: `已向客户端发出《${title}》${resume ? '继续观看' : playback?.episode ? `第${episode}集播放` : '从头播放'}请求。`,
      playback: { state: 'requested', episode: resume ? null : episode, resume },
      cards: meta ? [toCard(meta, '即将打开播放页')] : [cardFromPagePayload(contextPayload)],
      actions: [{ type: 'navigate', url, delayMs: 700 }, {
        type: 'play',
        title,
        anilistId: Number(meta?.anilist_id || pageContext.anilistId) || 0,
        episode,
        episodeExplicit: playback?.episode != null,
        resume,
        url,
      }],
      suggestions: [],
      fallback: true,
      intent
    };
  }

  return null;
}

module.exports = { executeAgentAction, findAnimeTarget, favoritePayloadFromMeta };
