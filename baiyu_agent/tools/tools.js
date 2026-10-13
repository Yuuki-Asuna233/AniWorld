const { buildUserMemoryStore } = require('../memory/profile');
const { recommendAnime, toCard } = require('../retrieval/recommender');
const { recordAgentEvent } = require('../diagnostics/diagnostics');
const { searchAnimeEvidence } = require('../retrieval/web-search');
const { getRagService } = require('../retrieval/rag-service');
const { resolveAnimeMetadataDetailed } = require('../../apps/server/src/services/anime-identity');
const { executeActionTool, ACTION_TOOL_INTENTS } = require('./action-tools');
const { TOOL_SCHEMAS } = require('./schemas');

const { lookupAniList } = require('./external-info');
const { throwIfAborted } = require('../shared/runtime');
const { readPageContext } = require('../agents/page-context');
const { compactCard, compactDetail } = require('./anime-data');
const { compareAnime, userLibrary } = require('./anime-queries');
const { loadSkill } = require('../skills/catalog');
const { auditArguments } = require('../shared/audit');
const { airingSchedule, resolveScheduleDate } = require('./airing-schedule');
const { toolOutcome } = require('./contracts');

function compactRetrieval(retrieval) {
  return {
    mode: retrieval.mode,
    configured: retrieval.configured,
    indexed: retrieval.indexed,
    query: retrieval.query,
    rewrittenQuery: retrieval.rewrittenQuery || '',
    lowConfidence: Boolean(retrieval.lowConfidence),
    threshold: retrieval.threshold,
    externalUsed: Boolean(retrieval.externalUsed),
    externalAttempted: Boolean(retrieval.externalAttempted),
    requiresVerification: Boolean(retrieval.requiresVerification),
    degraded: Boolean(retrieval.degraded),
    externalError: retrieval.externalError || '',
    scanned: retrieval.scanned || 0,
    candidateCount: retrieval.candidateCount || 0,
    partial: Boolean(retrieval.partial),
    chunks: (retrieval.results || []).map(item => ({
      anilistId: item.anilistId,
      chunkType: item.chunkType,
      text: item.chunkText,
      matchType: item.matchType || 'semantic',
      score: Number(item.score || 0).toFixed(4),
      vectorScore: Number(item.vectorScore || 0).toFixed(4),
      keywordScore: Number(item.keywordScore || 0).toFixed(4),
      sourceTitle: item.sourceTitle,
      sourceUrl: item.sourceUrl,
      sourceType: item.sourceType,
      trustScore: item.trustScore,
      publishedAt: item.publishedAt || ''
    })),
    sources: retrieval.sources || []
  };
}

async function executeTool(name, args = {}, context) {
  const { database, userId } = context;
  const started = Date.now();
  try {
    let result;
    if (name === 'get_page_context') {
      result = readPageContext(context.pageContext);
    } else if (name === 'load_skill') {
      result = loadSkill(args.name);
    } else if (name === 'present_anime_results') {
      result = context.displayResults.present(args);
    } else if (name === 'start_task') {
      result = context.memoryManager.startTask(args);
    } else if (name === 'get_user_library') {
      result = userLibrary(args, context);
    } else if (name === 'search_memory') {
      result = context.memoryManager.list(args);
    } else if (name === 'query_context_evidence') {
      result = { mode: args.mode, ...(args.mode === 'search_history'
        ? { items: context.memoryManager.history(args.query, args.sessionId, args.limit || 3) }
        : context.memoryManager.readHistory(args)) };
    } else if (name === 'update_memory') {
      result = context.memoryManager.apply(args);
    } else if (name === 'resolve_anime') {
      const query = String(args.query || '').trim().slice(0, 120);
      const resolution = resolveAnimeMetadataDetailed(database, query, {
        limit: Math.max(1, Math.min(Number(args.limit) || 12, 12)),
        minimumScore: 500,
        season: Number(args.season) || 0,
        year: Number(args.year) || 0
      });
      const candidates = (resolution.candidates || []).slice(0, 5).map(item => ({
        ...compactCard(toCard(item.meta)),
        matchScore: item.score,
        exact: Boolean(item.exact)
      }));
      result = {
        query,
        matchStatus: resolution.status,
        status: resolution.status,
        confidence: resolution.confidence,
        margin: resolution.margin,
        selected: resolution.selected ? compactDetail(resolution.selected) : null,
        candidates,
        cards: candidates,
        items: candidates
      };
    } else if (name === 'search_anime') {
      const query = String(args.query || '').trim().slice(0, 100);
      const limit = Math.max(1, Math.min(Number(args.limit) || 8, 12));
      const rag = getRagService(database);
      const search = query ? await rag.searchAnime(query, limit, { signal: context.signal }) : { rows: [], retrieval: { mode: 'fts', results: [] } };
      const semanticScores = new Map((search.retrieval?.results || [])
        .filter(item => item.anilistId)
        .map(item => [Number(item.anilistId), Number(item.score) || 0]));
      const cards = search.rows.map(row => toCard(
        row,
        semanticScores.has(Number(row.anilist_id)) ? '标题与语义混合检索匹配' : '与你搜索的标题相符'
      ));
      result = {
        total: cards.length,
        cards,
        items: cards.map(compactCard),
        retrieval: compactRetrieval(search.retrieval || {}),
        identityGuaranteed: false
      };
    } else if (name === 'retrieve_anime_knowledge') {
      const query = String(args.query || '').trim().slice(0, 500);
      const limit = Math.max(1, Math.min(Number(args.limit) || 6, 8));
      const rag = getRagService(database);
      const retrieval = await rag.retrieve(query, {
        finalK: limit, knowledge: true, anilistId: args.anilistId,
        allowWebFallback: args.allowWebFallback !== false, signal: context.signal
      });
      const seen = new Set();
      const cards = [];
      for (const chunk of retrieval.results || []) {
        const id = Number(chunk.anilistId) || 0;
        if (!id || seen.has(id)) continue;
        const meta = database.getAnimeMetaById(id);
        if (!meta) continue;
        seen.add(id);
        cards.push(toCard(meta, chunk.matchType === 'title' ? '本地作品资料' : '知识库相关资料'));
      }
      result = {
        found: (retrieval.results || []).length > 0,
        lowConfidence: Boolean(retrieval.lowConfidence),
        partial: Boolean(retrieval.partial),
        retrieval: compactRetrieval(retrieval),
        cards,
        sources: retrieval.sources || []
      };
    } else if (name === 'get_anime_detail') {
      const meta = database.getAnimeMetaById(Number(args.anilistId) || 0);
      if (!meta) result = { found: false };
      else {
        const card = toCard(meta);
        result = { found: true, card, item: compactDetail(meta) };
      }
    } else if (name === 'lookup_external_anime_info') {
      if (args.query) {
        const resolution = resolveAnimeMetadataDetailed(database, args.query, { limit: 12, minimumScore: 500 });
        result = resolution.selected && resolution.status !== 'ambiguous'
          ? await lookupAniList({ anilistId: Number(resolution.selected.anilist_id) }, context.signal)
          : { found: false, status: resolution.status, candidates: (resolution.candidates || []).slice(0, 3).map(item => compactDetail(item.meta)),
            message: '未找到唯一站内身份，请先确认具体作品；站外未知作品可用网页搜索核实。' };
      } else result = await lookupAniList(args, context.signal);
    } else if (name === 'web_search_anime_evidence') {
      result = await searchAnimeEvidence({
        query: String(args.query || '').trim(),
        purpose: args.purpose, maxResults: args.maxResults, signal: context.signal
      });
    } else if (name === 'compare_anime') {
      result = await compareAnime(args, context);
    } else if (name === 'get_user_profile') {
      result = {
        memoryStore: buildUserMemoryStore(database, userId, context.userMemorySummary),
        profileVersion: context.memoryManager?.contextVersion || 0
      };
      if (context.memoryManager) context.memoryManager.recommendationProfileVersion = context.memoryManager.contextVersion;
    } else if (name === 'recommend_anime') {
      if (context.memoryManager && context.memoryManager.snapshot.memory.items.some(item => item.kind === 'preference_positive')
        && (context.memoryManager.recommendationProfileVersion !== context.memoryManager.contextVersion
          || args.profileVersion !== context.memoryManager.contextVersion)) {
        return { policyRejected: true, errorCode: 'PROFILE_REQUIRED',
          prerequisite: 'get_user_profile', error: '请先 get_user_profile 读取有效偏好，再传其 profileVersion 和结构化推荐条件。' };
      }
      const semantic = await getRagService(database)
        .recommendationCandidates(args.intent, 12, { signal: context.signal })
        .catch(error => { throwIfAborted(context.signal); return { candidates: [], retrieval: null }; });
      const recommended = recommendAnime(database, userId, { ...args, semanticCandidates: semantic.candidates });
      result = { personalized: recommended.personalized, intent: recommended.intent,
        profileSummary: recommended.profileSummary, cards: recommended.cards,
        items: recommended.cards.map(compactCard),
        retrieval: semantic.retrieval ? compactRetrieval(semantic.retrieval) : null };
    } else if (name === 'get_airing_schedule') {
      result = airingSchedule(args, context);
    } else if (name === 'get_my_airing_schedule') {
      result = airingSchedule(args, context, true);
    } else if (ACTION_TOOL_INTENTS[name]) {
      result = await executeActionTool(name, args, context);
    } else {
      throw new Error(`UNKNOWN_TOOL: ${name}`);
    }
    recordAgentEvent('tool', {
      name,
      ok: toolOutcome(result) === 'success',
      outcome: toolOutcome(result),
      ms: Date.now() - started,
      args: auditArguments(args),
      cards: Array.isArray(result?.cards) ? result.cards.length : 0,
      items: Array.isArray(result?.items) ? result.items.length : undefined
    });
    return result;
  } catch (error) {
    recordAgentEvent('tool', { name, ok: false, ms: Date.now() - started, args: auditArguments(args), error: error.message });
    throw error;
  }
}

module.exports = { TOOL_SCHEMAS, executeTool, resolveScheduleDate, lookupAniList };
