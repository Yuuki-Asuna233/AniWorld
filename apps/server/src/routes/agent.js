const { timingSafeEqual, randomUUID, createHash } = require('crypto');
const { AgentProvider } = require('../../../../baiyu_agent/providers/provider');
const { runAgent } = require('../../../../baiyu_agent/entry');
const { getAgentDiagnostics, recordAgentEvent } = require('../../../../baiyu_agent/diagnostics/diagnostics');
const { buildUserProfile, buildUserMemoryStore } = require('../../../../baiyu_agent/memory/profile');
const { getWebSearchConfig } = require('../../../../baiyu_agent/retrieval/web-search');
const { memoryConfig } = require('../../../../baiyu_agent/memory/memory');
const { AgentConversationStore } = require('../../../../baiyu_agent/memory/conversation-store');
const { getRagService } = require('../../../../baiyu_agent/retrieval/rag-service');
const { createAgentTelemetry } = require('../services/agent-telemetry');
const { stableJson } = require('../../../../baiyu_agent/shared/runtime');
const { emptyUserMemory } = require('../../../../baiyu_agent/memory/user-memory');
const { sessionState, rememberResult } = require('../../../../baiyu_agent/memory/session-state');
const { toolProgress } = require('../../../../baiyu_agent/agents/progress');
const activeRequests = new Map();

const ALLOWED_EVENTS = new Set([
  'detail_view', 'play_start', 'episode_complete', 'favorite', 'recommend_impression', 'recommend_click', 'not_interested'
]);
const ALLOWED_FEEDBACK = new Set(['like', 'dislike', 'not_interested', 'already_watched']);

function createRateLimiter() {
  const buckets = new Map();
  return function allow(key) {
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    for (const [id, bucket] of buckets) {
      if (now - bucket.startedAt > windowMs) buckets.delete(id);
    }
    const current = buckets.get(key);
    if (!current) {
      if (buckets.size >= 10000) return false;
      buckets.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count++;
    return current.count <= 30;
  };
}

function writeEvent(res, payload) {
  if (!res.writableEnded && !res.destroyed) {
    res.write(`${JSON.stringify(payload)}\n`);
    if (typeof res.flush === 'function') res.flush();
  }
}

function hasDiagnosticsAccess(req) {
  const expected = String(process.env.AGENT_DIAGNOSTICS_KEY || '').trim();
  const provided = String(req.get('x-agent-diagnostics-key') || '').trim();
  if (!expected || !provided) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length
    && timingSafeEqual(expectedBuffer, providedBuffer);
}

function buildMemoryProfile(database, userId) {
  const profile = buildUserProfile(database, userId);
  const snapshot = database.getAgentMemorySnapshot(userId);
  const store = emptyUserMemory();
  for (const item of snapshot.items) {
    const kind = item.kind.replace(/^preference_/, '');
    if (store.preferences[kind]) store.preferences[kind].push(item.value);
    else store.facts.push({ id: item.id, kind: item.kind, value: item.value, source: item.source });
  }
  const memoryStore = buildUserMemoryStore(
    database,
    userId,
    JSON.stringify(store)
  );
  return {
    personalized: Boolean(profile.personalized),
    genres: profile.genres || [],
    tags: profile.tags || [],
    preferredStatus: profile.preferredStatus || '',
    recentAnime: profile.recentAnime || [],
    negativeSignals: profile.negativeSignals || {},
    signalCounts: profile.signalCounts || {},
    memoryStore, preferences: memoryStore.preferences, memoryItems: snapshot.items, memoryRevision: snapshot.revision,
    recentQuestions: [],
    facts: memoryStore.facts,
    referencedTitles: memoryStore.titles
  };
}

function mountAgentRoutes(app, { database, requireAuth }) {
  const provider = new AgentProvider();
  const allowRequest = createRateLimiter();
  const conversations = new AgentConversationStore(database);
  const rag = getRagService(database);

  app.get('/api/agent/status', (req, res) => {
    const webSearch = getWebSearchConfig();
    res.json({
      available: true,
      modelConfigured: provider.isConfigured(),
      mode: provider.isConfigured() ? 'model' : 'local-fallback',
      disableThinking: Boolean(provider.disableThinking),
      auth: {
        loggedIn: Boolean(req.user?.id),
        userId: req.user?.id ? 'current' : ''
      },
      webSearch: {
        provider: webSearch.provider || '',
        configured: webSearch.provider === 'tavily' && Boolean(webSearch.tavilyKey),
        maxResults: webSearch.maxResults,
        strictDomains: Boolean(webSearch.strictDomains),
        allowedDomains: webSearch.allowedDomains
      },
      memory: memoryConfig(),
      rag: rag.status()
    });
  });

  app.post('/api/agent/chat', async (req, res) => {
    const userId = req.user?.id || null;
    const rateKey = userId ? `user:${userId}` : `ip:${req.ip}`;
    if (!allowRequest(rateKey)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });

    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: '请输入问题' });
    if (message.length > 2000) return res.status(400).json({ error: '单条消息不能超过 2000 字' });

    const requestedId = String(req.get('x-agent-request-id') || randomUUID());
    if (requestedId.length > 160 || activeRequests.has(requestedId) || [...activeRequests.values()].some(active =>
      userId ? active.userId === userId : active.sessionId === req.body?.sessionId)) {
      return res.status(409).json({ error: '当前对话仍在处理中，请稍后再试' });
    }
    const inputHash = createHash('sha256').update(stableJson({ message, sessionId: req.body?.sessionId || '', pageContext: req.body?.pageContext || {}, confirmationId: req.body?.confirmationId || '' })).digest('hex');
    const recovered = userId ? database.getAgentRequestResult(userId, requestedId, inputHash) : null;
    if (recovered?.error) return res.status(409).json({ error: '请求标识已使用或原会话已删除，请重新发起请求' });
    const { sessionId, history, sessionSummary, userMemorySummary, pendingAction, historyHasOlder, historyIncomplete, relatedMemories, summaryThroughId, compactionCandidates, contextSnapshot } = conversations.prepare({
      userId,
      sessionId: recovered?.sessionId || req.body?.sessionId,
      message,
    });

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    writeEvent(res, { type: 'session', sessionId });
    const requestId = requestedId;
    const runId = randomUUID();
    const controller = new AbortController();
    activeRequests.set(requestId, { controller, userId, sessionId, ip: req.ip });
    const telemetry = createAgentTelemetry({
      database,
      runId,
      userId,
      sessionId,
      model: provider.model,
      message,
      pageContext: req.body?.pageContext || {}
    });
    writeEvent(res, { type: 'run', runId });
    req.on('aborted', () => controller.abort());
    res.once('close', () => controller.abort());

    try {
      const result = recovered ? { ...recovered.result, memorySummary: sessionSummary, userMemorySummary, summaryThroughId,
        pendingAction: recovered.committed ? pendingAction : '', operationCompleted: !recovered.committed } : await runAgent({
        provider,
        conversationStore: conversations, contextSnapshot,
        requestId, inputHash, sessionId, summaryThroughId, compactionCandidates, confirmationId: req.body?.confirmationId,
        database,
        userId,
        history,
        sessionSummary,
        userMemorySummary,
        historyHasOlder,
        historyIncomplete,
        relatedMemories,
        message,
        pageContext: req.body?.pageContext || {},
        pendingAction,
        onDelta: text => writeEvent(res, { type: 'delta', text }),
        onAnswerStart: () => writeEvent(res, { type: 'answer_start' }),
        onProgress: event => writeEvent(res, { ...event, type: 'progress' }),
        onModelRequest: event => telemetry.modelRequest(event),
        onToolEvent: event => {
          if (event.type === 'tool_start') telemetry.toolStart(event);
          if (event.type === 'tool_result') telemetry.toolResult(event);
          if (event.type === 'tool_error') telemetry.toolError(event);
          writeEvent(res, toolProgress(event));
        },
        signal: controller.signal,
      });
      if (recovered && !recovered.committed) {
        result.sessionState = sessionState(contextSnapshot.state);
        const ref = rememberResult(result.sessionState, 'final_answer', { cards: result.cards || [], sourceTool: 'business_operation' });
        if (ref) result.answer += '\n作品清单：\n' + ref.items.map((item, index) => `${index + 1}.《${item.title}》`).join('\n');
      }
      if (controller.signal.aborted && !result.operationCompleted) throw new Error('REQUEST_ABORTED');
      if (!recovered?.committed) conversations.commit({
        userId, sessionId, history, sessionSummary, userMemorySummary, message, result, requestId, inputHash,
        memorySummary: result.memorySummary, userMemoryUpdate: result.userMemorySummary,
        pendingAction: result.pendingAction ?? pendingAction
      });
      database.flushDatabase();
      telemetry.finish({
        status: 'success',
        fallback: Boolean(result.fallback),
        answer: result.answer,
        cards: result.cards,
        sources: result.sources
      });
      recordAgentEvent('chat_done', {
        user: userId ? 'login' : 'guest',
        sessionId,
        fallback: Boolean(result.fallback),
        cards: result.cards?.length || 0,
        messageLength: message.length
      });
      if (!result.streamed) {
        // Local/recovered/failure results are complete facts, not model streams.
        // Start replaces any abandoned draft; never append a second answer.
        writeEvent(res, { type: 'answer_start' });
        writeEvent(res, { type: 'delta', text: result.answer });
      }
      if (result.cards?.length) writeEvent(res, { type: 'cards', items: result.cards });
      if (result.sources?.length) writeEvent(res, { type: 'sources', items: result.sources });
      if (Array.isArray(result.plan) && result.plan.length) writeEvent(res, { type: 'plan', items: result.plan });
      if (result.actions?.length) writeEvent(res, { type: 'actions', items: result.actions });
      if (result.suggestions?.length) writeEvent(res, { type: 'suggestions', items: result.suggestions });
      database.flushDatabase();
      writeEvent(res, { type: 'done', runId, fallback: Boolean(result.fallback), intent: result.intent || '',
        answer: result.answer, cards: result.cards || [], sources: result.sources || [], actions: result.actions || [], suggestions: result.suggestions || [] });
      if (result.maintenanceNeeded && !controller.signal.aborted) {
        try { conversations.maintain({ userId, sessionId, provider, targetId: result.maintenanceTarget }); }
        catch (error) { recordAgentEvent('maintenance_error', { error: error.message }); }
      }

    } catch (error) {
      console.error('[agent/chat]', error.message);
      telemetry.finish({
        status: controller.signal.aborted ? 'cancelled' : 'error',
        errorCode: error.message
      });
      recordAgentEvent('chat_error', { user: userId ? 'login' : 'guest', error: error.message });
      writeEvent(res, controller.signal.aborted
        ? { type: 'cancelled', error: '已停止本次请求' }
        : { type: 'error', error: error.message.startsWith('OPERATION_OUTCOME_UNKNOWN')
           ? '操作结果暂时无法确认，请先查看追番或历史状态。' : '动漫助手暂时不可用，请稍后重试' });
    } finally {
      activeRequests.delete(requestId);
      res.end();
    }
  });

  app.post('/api/agent/cancel', (req, res) => {
    const requestId = String(req.body?.requestId || '').trim();
    const active = activeRequests.get(requestId);
    if (!active || (active.userId
      ? Number(req.user?.id || 0) !== Number(active.userId)
      : active.ip !== req.ip)) {
      return res.status(404).json({ error: '请求不存在或已经结束' });
    }
    active.controller.abort();
    res.json({ success: true });
  });

  app.get('/api/agent/sessions', requireAuth, (req, res) => {
    res.json({ results: database.getAgentSessions(req.user.id, 20) });
  });

  app.get('/api/agent/diagnostics', requireAuth, (req, res) => {
    if (!hasDiagnosticsAccess(req)) {
      return res.status(403).json({ error: '无权访问 Agent 诊断信息' });
    }
    const profile = buildUserProfile(database, req.user.id);
    const webSearch = getWebSearchConfig();
    res.json({
      modelConfigured: provider.isConfigured(),
      mode: provider.isConfigured() ? 'model' : 'local-fallback',
      disableThinking: Boolean(provider.disableThinking),
      webSearch: {
        provider: webSearch.provider || '',
        configured: webSearch.provider === 'tavily' && Boolean(webSearch.tavilyKey),
        maxResults: webSearch.maxResults,
        strictDomains: Boolean(webSearch.strictDomains),
        allowedDomains: webSearch.allowedDomains
      },
      memory: memoryConfig(),
      rag: rag.status(),
      profileSummary: {
        personalized: profile.personalized,
        genres: profile.genres.slice(0, 6),
        tags: profile.tags.slice(0, 6),
        recentAnime: profile.recentAnime.slice(0, 6),
        preferredStatus: profile.preferredStatus,
        negativeSignals: profile.negativeSignals,
        signalCounts: profile.signalCounts
      },
      ...getAgentDiagnostics()
    });
  });

  app.get('/api/agent/memory', requireAuth, (req, res) => {
    const rawRows = database.getAgentMemorySummaries(req.user.id, 100);
    const profile = buildMemoryProfile(database, req.user.id);
    const rows = rawRows.map(item => {
      return {
      sessionId: item.id,
      title: item.title || '未命名对话',
      summary: item.summary || '',
      preferences: { positive: [], negative: [], constraints: [] },
      facts: [],
      titles: [],
      recentQuestions: [],
      updatedAt: item.updated_at
      };
    });
    res.json({ profile, results: rows });
  });

  const requireIdleUser = (req, res, next) => {
    if ([...activeRequests.values()].some(active => active.userId === req.user.id)) {
      return res.status(409).json({ error: '请先停止或等待当前对话完成，再删除记忆' });
    }
    next();
  };

  app.delete('/api/agent/memory/items/:memoryId', requireAuth, requireIdleUser, (req, res) => {
    try {
      const memory = database.getAgentMemorySnapshot(req.user.id);
      if (!memory.items.some(item => item.id === req.params.memoryId)) return res.status(404).json({ error: '记忆不存在' });
      const session = database.getAgentSessions(req.user.id, 1)[0];
      const receipt = database.applyAgentMemoryChange({ userId: req.user.id, sessionId: session?.id || '', changeId: randomUUID(), expectedRevision: memory.revision,
        change: { action: 'forget', ids: [req.params.memoryId] } });
      res.json({ success: true, ...receipt });
    } catch (error) { res.status(500).json({ error: '记忆删除未完成，请稍后重试。' }); }
  });

  // Read a durable result after a cancelled/disconnected stream without
  // rerunning tools. Ownership is verified by both the active map and DB query.
  app.get('/api/agent/requests/:requestId', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const requestId = String(req.params.requestId || '');
    if (!requestId || requestId.length > 160) return res.status(400).json({ error: '请求标识无效' });
    const active = activeRequests.get(requestId);
    let saved;
    try {
      saved = database.getAgentRequestResult(req.user.id, requestId);
      // Reconfirm persistence before treating an in-memory receipt as completed.
      // This never reruns the operation; a dirty database flush can still fail.
      if (saved?.result && !saved.error) database.flushDatabase();
    } catch (_) {
      return res.status(503).json({ status: 'unknown', error: '操作结果暂时无法确认，请查看追番或历史状态。' });
    }
    const result = saved?.result && !saved.error ? { ...saved.result, sessionId: saved.sessionId } : null;
    if (saved?.committed && result) return res.json({ status: 'completed', result });
    if (Number(active?.userId) === Number(req.user.id)) return res.json({ status: 'running',
      ...(result ? { operationCompleted: true, result } : {}) });
    if (!result) return res.status(404).json({ status: 'not_found' });
    return res.json({ status: 'operation_completed', result });
  });

  app.delete('/api/agent/memory', requireAuth, requireIdleUser, (req, res) => {
    const result = database.clearAgentMemory(req.user.id);
    if (result.error) return res.status(500).json({ error: result.error });
    database.flushDatabase();
    res.json({ success: true });
  });

  app.delete('/api/agent/memory/:id', requireAuth, requireIdleUser, (req, res) => {
    const result = database.clearAgentSessionMemory(req.params.id, req.user.id);
    if (result.error) return res.status(404).json({ error: '记忆不存在' });
    database.flushDatabase();
    res.json({ success: true });
  });

  app.get('/api/agent/sessions/:id/messages', requireAuth, (req, res) => {
    const session = database.getAgentSession(req.params.id, req.user.id);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    const results = database.getAgentMessages(session.id, 50).map(item => {
      let cards = [];
      try { cards = JSON.parse(item.cards_json || '[]'); } catch (e) {}
      return { id: item.id, role: item.role, content: item.content, cards, createdAt: item.created_at };
    });
    res.json({ session, results });
  });

  app.delete('/api/agent/sessions/:id', requireAuth, requireIdleUser, (req, res) => {
    const result = database.deleteAgentSession(req.params.id, req.user.id);
    if (result.error) return res.status(404).json({ error: '会话不存在' });
    database.flushDatabase();
    res.json({ success: true });
  });

  app.post('/api/agent/events', requireAuth, (req, res) => {
    const eventType = String(req.body?.eventType || '');
    const anilistId = Number(req.body?.anilistId) || 0;
    if (!ALLOWED_EVENTS.has(eventType) || !anilistId) {
      return res.status(400).json({ error: '无效的行为数据' });
    }
    const result = database.addUserAnimeEvent(req.user.id, {
      anilist_id: anilistId,
      event_type: eventType,
      value: Number(req.body?.value) || 1,
      context: JSON.stringify(req.body?.context || {}).slice(0, 500),
      agent_run_id: String(req.body?.runId || '').slice(0, 160)
    });
    if (result.error) return res.status(500).json({ error: result.error });
    res.json({ success: true });
  });

  app.post('/api/agent/feedback', requireAuth, (req, res) => {
    const action = String(req.body?.action || '');
    const anilistId = Number(req.body?.anilistId) || 0;
    if (!ALLOWED_FEEDBACK.has(action) || !anilistId) {
      return res.status(400).json({ error: '无效的反馈' });
    }
    const result = database.addRecommendationFeedback(req.user.id, {
      anilist_id: anilistId,
      action,
      reason: String(req.body?.reason || '').slice(0, 200),
      agent_run_id: String(req.body?.runId || '').slice(0, 160)
    });
    if (result.error) return res.status(500).json({ error: result.error });
    res.json({ success: true });
  });

  app.post('/api/agent/answer-feedback', requireAuth, (req, res) => {
    const rating = String(req.body?.rating || '');
    if (!['like', 'dislike', 'resolved', 'unresolved'].includes(rating)) {
      return res.status(400).json({ error: '无效的回答反馈' });
    }
    const result = database.addAgentAnswerFeedback({
      runId: req.body?.runId,
      userId: req.user.id,
      sessionId: req.body?.sessionId,
      rating,
      reason: req.body?.reason
    });
    if (result.error === 'missing_run_id') return res.status(400).json({ error: '缺少请求标识' });
    if (result.error) return res.status(500).json({ error: result.error });
    res.json({ success: true });
  });

  // Route registration happens before the asynchronous database initialization.
  // The bootstrap owns worker startup and drains it before closing the database.
  return {
    start: () => conversations.startMaintenance(provider),
    stop: () => conversations.stopMaintenance()
  };
}

module.exports = { mountAgentRoutes };
