// Runtime policy is declared alongside each capability, not inferred from model text.
const specs = {
  resolve_anime: {}, search_anime: {}, retrieve_anime_knowledge: {}, get_anime_detail: {},
  lookup_external_anime_info: {}, web_search_anime_evidence: {}, compare_anime: {},
  get_user_profile: { cache: false }, recommend_anime: { readBarrier: true }, get_airing_schedule: {},
  get_my_airing_schedule: { auth: true }, get_user_library: { auth: true, cache: false },
  get_page_context: {}, search_memory: { cache: false }, query_context_evidence: { cache: false },
  follow_anime: { effect: 'business', auth: true, cache: false },
  unfollow_anime: { effect: 'business', auth: true, cache: false },
  delete_watch_history: { effect: 'business', auth: true, cache: false },
  open_anime_playback: { effect: 'business', cache: false },
  update_memory: { effect: 'control', cache: false }, start_task: { effect: 'control', cache: false },
  load_skill: { effect: 'context', cache: false }, present_anime_results: { effect: 'presentation', cache: false }
};
const TOOL_SPECS = Object.freeze(Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name,
  Object.freeze({ name, effect: 'read', auth: false, cache: true, ...spec })])));

function argumentError(name, args) {
  if (['resolve_anime', 'search_anime', 'retrieve_anime_knowledge', 'web_search_anime_evidence'].includes(name)
    && !args.query?.trim()) return '检索条件不能为空。';
  if (name === 'recommend_anime' && !args.intent?.trim()) return '推荐条件不能为空。';
  if (name === 'recommend_anime' && ((args.scoreMode === 'none' && ((args.scoreMin != null && args.scoreMin !== 0) || args.scoreMax != null))
    || (args.scoreMin != null && args.scoreMax != null && args.scoreMin > args.scoreMax))) return '评分条件冲突：不限制时省略上下限，最低分不能高于最高分。';
  if (name === 'compare_anime') {
    if (Boolean(args.titles) === Boolean(args.anilistIds)) return 'titles 与 anilistIds 必须且只能提供一组。';
    const values = args.titles || args.anilistIds;
    if (values.some(value => typeof value === 'string' && !value.trim())
      || new Set(values.map(value => typeof value === 'string' ? value.trim() : value)).size !== values.length) return '比较作品不能为空或重复。';
  }
  if (name === 'lookup_external_anime_info' && Boolean(args.anilistId) === Boolean(args.query?.trim())) return '必须且只能提供 anilistId 或完整标题 query。';
  if (name === 'query_context_evidence') {
    const count = [args.query?.trim(), args.eventId, args.artifactId].filter(Boolean).length;
    if (count !== 1) return '必须且只能提供 query、eventId、artifactId 中的一项。';
    if (args.query && args.offset !== undefined) return '搜索模式不能使用 offset。';
    if (!args.query && (args.sessionId !== undefined || args.limit !== undefined)) return '原文读取模式不能使用 sessionId 或 limit。';
    const expected = args.query ? 'search_history' : args.eventId ? 'read_message' : 'read_artifact';
    if (args.mode !== expected) return 'mode 必须与 query、eventId 或 artifactId 对应。';
  }
  if (name === 'open_anime_playback' && args.episode != null && args.resume === true) return '指定集数与续播历史不能同时使用。';
  if (TOOL_SPECS[name]?.effect === 'business') {
    if (args.confirmed && (args.query || args.anilistId || args.resultId || args.usePageContext)) return '确认已有操作时不能指定新目标。';
    if (args.usePageContext && (args.query || args.anilistId || args.resultId)) return '页面引用不能与其他目标混用。';
    if (Boolean(args.resultId) !== (args.resultIndex !== undefined)) return 'resultId 与 resultIndex 必须同时提供。';
    if ([Boolean(args.query?.trim()), Boolean(args.anilistId), Boolean(args.resultId)].filter(Boolean).length > 1) return '标题、作品 ID 和清单引用不能混用。';
    if (args.query !== undefined && !args.query.trim()) return 'query 不能为空；引用当前页面时请省略。';
  }
  if (name === 'search_memory' && args.query && args.memoryIds) return '关键词搜索与按 ID 读取不能混用。';
  if (['get_airing_schedule', 'get_my_airing_schedule'].includes(name) && args.date) {
    if (!['today', 'tomorrow', 'after_tomorrow'].includes(args.date)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) return '日期必须是相对日期或 YYYY-MM-DD。';
      const date = new Date(args.date + 'T00:00:00Z');
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== args.date) return '日期不存在。';
    }
  }
  return '';
}

function toolOutcome(result = {}) {
  if (result.requiresLogin) return 'requires_login';
  if (result.policyRejected) return 'rejected';
  if (result.error) return 'error';
  if (result.status === 'awaiting_confirmation') return 'awaiting_confirmation';
  if (result.status === 'ambiguous' || result.status === 'needs_input') return 'needs_input';
  if (result.status === 'not_found' || result.found === false) return 'not_found';
  if (result.lowConfidence || result.partial) return 'partial';
  if ((Array.isArray(result.items) && !result.items.length)
    || (Array.isArray(result.results) && !result.results.length)) return 'empty';
  return 'success';
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('TOOL_RESULT_INVALID');
  return { ...result, outcome: toolOutcome(result) };
}

module.exports = { TOOL_SPECS, argumentError, normalizeResult, toolOutcome };
