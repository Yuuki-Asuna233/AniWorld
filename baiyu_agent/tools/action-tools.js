const { executeAgentAction, favoritePayloadFromMeta } = require('../actions/actions');
const { INTENTS } = require('../agents/action-types');
const { agentConfig } = require('../core/config');
const { throwIfAborted, stableJson } = require('../shared/runtime');
const { createHash } = require('crypto');

const ACTION_TOOL_INTENTS = {
  follow_anime: INTENTS.FOLLOW_ANIME, unfollow_anime: INTENTS.UNFOLLOW_ANIME,
  delete_watch_history: INTENTS.DELETE_HISTORY, open_anime_playback: INTENTS.NAVIGATE_PLAY
};

function readPending(raw) {
  try {
    const pending = JSON.parse(raw);
    return pending.version === 2 && pending.target?.anime_id && pending.operationId
      && pending.expiresAt > Date.now() ? pending : null;
  } catch (_) { return null; }
}

function executeActionTool(name, args, context) {
  throwIfAborted(context.signal);
  const intent = ACTION_TOOL_INTENTS[name];
  const pending = readPending(context.pendingAction);
  const destructive = ['unfollow_anime', 'delete_watch_history'].includes(name);
  if (context.confirmationId && context.confirmationId !== pending?.operationId) {
    return { error: '确认操作已失效，请重新发起操作。', policyRejected: true };
  }
  const confirmed = destructive && args.confirmed === true && pending?.intent === intent
    && !context.memoryManager?.interpretation?.clarification
    && context.memoryManager?.interpretation?.pendingDecision?.action === 'confirm';
  if (context.confirmationId && !confirmed) return { error: '回复与待确认操作不一致，请重新发起操作。', policyRejected: true };
  if (!confirmed && !args.anilistId && !args.resultId && !args.query
    && args.usePageContext !== true) {
    return { error: '不能将未指定目标的操作自动绑定到页面；请提供确定作品或清单引用。', policyRejected: true };
  }
  if (!confirmed && args.usePageContext && !context.pageContext?.anilistId) {
    const msg = String(context.pageContext?.msg || '').trim();
    let sourceUrl = false;
    try { const url = new URL(msg); sourceUrl = ['http:', 'https:'].includes(url.protocol); } catch (_) {}
    if (!msg || sourceUrl || (msg === 'AniWorld' && context.pageContext?.title !== msg)) {
      return { policyRejected: true, error: '页面作品身份不完整，请更新客户端或明确作品标题，不能使用源名称或地址作为作品标识。' };
    }
  }
  let referencedTarget;
  if (!confirmed && args.anilistId) {
    const meta = context.database.getAnimeMetaById(args.anilistId);
    if (!meta) return { error: '该作品 ID 不存在，请先确认作品。', policyRejected: true };
    referencedTarget = favoritePayloadFromMeta(meta);
  }
  if (!confirmed && (args.resultId || args.resultIndex != null)) {
    const current = context.displayResults?.results.get(args.resultId);
    const list = current ? { items: current.cards } : context.memoryManager?.state.resultRefs.find(item => item.resultId === args.resultId);
    const ref = Number.isInteger(args.resultIndex) ? list?.items[args.resultIndex - 1] : null;
    const meta = ref ? context.database.getAnimeMetaById(ref.anilistId) : null;
    if (!meta || args.query) return { error: '清单引用已失效、序号有误或与标题混用，请重新确认作品。', policyRejected: true };
    referencedTarget = favoritePayloadFromMeta(meta);
  }
  const referencedPage = referencedTarget ? { anilistId: referencedTarget.anilist_id, title: referencedTarget.anime_title,
    msg: referencedTarget.anime_msg, n: referencedTarget.anime_n } : context.pageContext;
  const input = {
    intent, database: context.database, userId: context.userId,
    message: confirmed ? pending.message : String(args.query || ''),
    pageContext: confirmed ? pending.pageContext : referencedPage,
    boundPayload: confirmed ? pending.target : referencedTarget || null,
    playback: name === 'open_anime_playback' ? { episode: args.episode, resume: args.resume === true } : null,
    confirmed: confirmed || !agentConfig().requireConfirmationForActions
  };
  const execute = () => {
    const result = executeAgentAction(input);
    // Action receipts carry their own target metadata. A later query may choose
    // a different display list; local mirroring must not depend on that list.
    if (Array.isArray(result?.actions)) result.actions = result.actions.map(action => {
      const card = ['collect', 'play', 'history_remove'].includes(action.type)
        ? result.cards?.find(item => action.animeId ? item.animeId === action.animeId
          || (Number(action.anilistId) > 0 && Number(item.anilistId) === Number(action.anilistId))
          : Number(item.anilistId) === Number(action.anilistId)) : null;
      return card ? { ...action, card } : action;
    });
    return result;
  };
  const operationId = confirmed ? pending.operationId : `${context.requestId}:${name}:` +
    createHash('sha256').update(stableJson({ args, page: referencedPage })).digest('hex').slice(0, 24);
  const result = context.userId && context.requestId && context.sessionId && context.database.executeAgentOperation
    ? context.database.executeAgentOperation({
      operationId,
      requestId: context.requestId, inputHash: context.inputHash, userId: context.userId, sessionId: context.sessionId, intent
    }, execute) : execute();
  const applied = result?.actions?.some(action => ['collect', 'history_remove', 'play'].includes(action.type));
  if (applied) result.pendingAction = '';
  return { ...result, operationId: result?.pendingAction ? readPending(result.pendingAction)?.operationId : operationId,
    status: result?.pendingAction ? 'awaiting_confirmation' : result?.error ? 'failed' : applied ? 'completed' : 'needs_input' };
}

module.exports = { executeActionTool, ACTION_TOOL_INTENTS, readPending };
