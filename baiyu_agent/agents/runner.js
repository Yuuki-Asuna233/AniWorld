const { toolRegistry } = require('../index');
const { ToolCallRuntime, nativeCalls } = require('../tools/call-runtime');
const { strictToolSchemas } = require('../tools/schemas');
const { DisplayResults } = require('./display');
const {
  memoryConfig,
  estimateTokens
} = require('../memory/memory');
const { compactConversation } = require('../memory/compaction');
const { MemoryManager } = require('../memory/manager');
const { interpretRequest } = require('../memory/interpret');
const { memoryReceiptText } = require('../memory/receipts');
const { rememberResult } = require('../memory/session-state');
const { pageSnapshot, readPageContext } = require('./page-context');
const { contextBudget } = require('./budget');
const { stripToolProtocol } = require('../core/message');
const { recordAgentEvent } = require('../diagnostics/diagnostics');
const { scopedSignal, throwIfAborted } = require('../shared/runtime');
const { encodeWithinBudget } = require('../shared/json-budget');
const { readPending, ACTION_TOOL_INTENTS } = require('../tools/action-tools');
const { agentConfig } = require('../core/config');
const { buildMessages, trimRuntimeMessages, contextTokenCount, dataMessage, sessionStateMessage, skillMessage } = require('./context');

function toolSchemasForModel(options = {}) {
  const schemas = [...toolRegistry.available(options)].sort((a, b) => a.function.name.localeCompare(b.function.name));
  return options.provider?.strictTools ? strictToolSchemas(schemas) : schemas;
}

function normalizeContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map(part => typeof part === 'string' ? part : part?.text || '').join('').trim();
  }
  return '';
}

function limitAnswer(text) {
  return normalizeContent(text).slice(0, agentConfig().maxAnswerChars);
}

function sourceListFromSearch(search, limit = 4) {
  return (Array.isArray(search?.results) ? search.results : []).slice(0, limit).map(item => ({
    title: item.title,
    url: item.url,
    host: item.host,
    trustLabel: item.trustLabel,
    trustScore: item.trustScore,
    publishedDate: item.publishedDate || ''
  }));
}

function mergeToolResult(state, name, result) {
  if (name === 'web_search_anime_evidence') state.sources.push(...sourceListFromSearch(result));
  if (Array.isArray(result?.sources)) {
    for (const source of result.sources.slice(0, 4)) {
      if (source?.url && !state.sources.some(item => item.url === source.url)) state.sources.push(source);
    }
  }
  if (Array.isArray(result?.actions)) state.actions.push(...result.actions);
  if (result?.pendingAction !== undefined) state.pendingAction = result.pendingAction;
  if (typeof result?.intent === 'string') state.intent = result.intent;
}

function responseFromState(state, answer, { streamed = false, fallback = false, authoritative = false } = {}) {
  return {
    answer: (authoritative ? normalizeContent(answer) : stripToolProtocol(limitAnswer(answer))) || '我暂时没能组织出可靠的回答，请换一种方式描述你的问题。',
    cards: state.cards,
    sources: state.sources,
    actions: state.actions,
    pendingAction: state.pendingAction,
    suggestions: [],
    fallback,
    streamed,
    intent: state.intent || ''
  };
}

function wireMessages(messages) {
  return messages.map(({ role, content, tool_calls, tool_call_id, reasoning_content }) => ({ role, content,
    ...(reasoning_content ? { reasoning_content } : {}),
    ...(tool_calls ? { tool_calls } : {}), ...(tool_call_id ? { tool_call_id } : {}) }));
}

async function modelCall(provider, messages, tools, options, round, onDelta, request = {}) {
  const budget = contextBudget(provider, request.maxTokens || provider.maxTokens);
  trimRuntimeMessages(messages, tools.length && request.toolChoice !== 'none' ? budget.active : budget.input, tools);
  const wire = wireMessages(messages);
  const event = { round, model: provider.model, inputChars: JSON.stringify({ messages: wire, tools }).length,
    stage: onDelta ? 'answer' : 'tools', purpose: request.purpose || (onDelta ? 'answer' : 'tool_planning'),
    estimatedInputTokens: contextTokenCount(wire, tools), tools: tools.length,
    contextCapacity: budget.capacity, memoryEpoch: options.memoryManager.snapshot.memory.epoch };
  const started = Date.now();
  let firstTextMs = null;
  const publish = onDelta ? text => {
    const accepted = onDelta(text);
    if (text && accepted !== false && firstTextMs === null) firstTextMs = Date.now() - started;
  } : () => {};
  options.conversationStore.event({ userId: options.userId, sessionId: options.sessionId, requestId: options.requestId,
    epoch: options.memoryManager.snapshot.memory.epoch, kind: 'context_budget', payload: {
      capacity: budget.capacity, estimatedInput: event.estimatedInputTokens,
      toolSchemaCost: estimateTokens(JSON.stringify(tools)), high: budget.high, low: budget.low } });
  options.onModelRequest?.({ ...event, phase: 'start' });
  try {
    // Tool selection text is provisional. Only the explicit answer stage
    // publishes text; a late tool call cannot invalidate visible prose.
    const response = provider.chatStream
      ? await provider.chatStream({ messages: wire, tools, signal: options.signal, maxTokens: request.maxTokens, toolChoice: request.toolChoice, onDelta: publish })
      : await provider.chat({ messages: wire, tools, signal: options.signal, maxTokens: request.maxTokens, toolChoice: request.toolChoice });
    options.onModelRequest?.({ ...event, phase: 'complete', durationMs: Date.now() - started, usage: response.usage,
      firstTokenMs: response.firstTokenMs ?? null, firstTextMs,
      outputChars: normalizeContent(response.content).length, estimatedOutputTokens: estimateTokens(JSON.stringify({ content: response.content, tool_calls: response.tool_calls })) });
    return { ...response, streamed: Boolean(onDelta && provider.chatStream) };
  } catch (error) {
    options.onModelRequest?.({ ...event, phase: 'error', durationMs: Date.now() - started, firstTextMs, errorCode: error.message });
    throw error;
  }
}

function visibleSessionState(manager) {
  return manager.controlPending ? {
    animeRefs: manager.state.animeRefs, resultRefs: manager.state.resultRefs
  } : manager.state;
}
function assemble(options, manager, historyBudget) {
  const isolated = manager.controlPending;
  const messages = buildMessages({ ...options, sessionState: visibleSessionState(manager), userMemorySummary: isolated ? '' : manager.view(),
    history: isolated ? [] : options.history.filter(item => item.id > manager.snapshot.memory.historyFloorId),
    sessionSummary: isolated ? '' : manager.snapshot.summary, summaryThroughId: manager.snapshot.throughId,
    relatedMemories: [], historyBudget,
    pageContextAvailable: readPageContext(options.pageContext).available });
  if (manager.interpretation?.pendingDecision?.action === 'confirm') messages.splice(messages.length - 1, 0,
    dataMessage('pending_decision', manager.interpretation.pendingDecision));
  if (manager.pendingProposals.length || manager.interpretation?.clarification || manager.interpretation?.taskSourceQuote) messages.splice(messages.length - 1, 0,
    dataMessage('memory_request_plan', { proposals: manager.pendingProposals, clarification: manager.interpretation?.clarification || '',
      taskSourceQuote: manager.taskStartedThisTurn ? '' : manager.interpretation?.taskSourceQuote || '',
      instruction: '先处理这些提案；taskSourceQuote 非空时先 start_task。upsert 先读取相关候选，存在同一概念旧条目则传其 ID 修订，否则新增。update_memory 只传 proposalId 和已读取的目标 ID；语义依据已记录，不能自行增加提案。无关键词命中时分页浏览 search_memory，按完整语义选择目标；不唯一时澄清。' }));
  return messages;
}

async function runModelAgent(options) {
  const { provider, signal, memoryManager: manager, displayResults: display } = options;
  const pending = readPending(options.pendingAction);
  const state = { cards: [], sources: [], actions: [], pendingAction: pending ? options.pendingAction : '', intent: '' };
  let messages = assemble(options, manager, options.historyBudget);
  let contextVersion = manager.contextVersion;
  const contextChanged = () => { manager.refresh(); return manager.contextVersion !== contextVersion; };
  const rebuildMessages = () => {
    const next = assemble({ ...options, pendingAction: state.pendingAction }, manager, options.historyBudget);
    contextVersion = manager.contextVersion;
    return next;
  };
  const modelTools = toolSchemasForModel(options);
  const runtime = new ToolCallRuntime(toolRegistry, options, state);
  const config = agentConfig(), controlReceipts = [], businessReceipts = new Map();
  let actionCards = [], operationCompleted = false;
  const finish = (answer, extra = {}) => {
    manager.refresh();
    const selected = display.final();
    state.cards = selected.sourceTool ? selected.cards : actionCards;
    const committedMutation = result => result.status === 'completed'
      && result.actions?.some(action => ['collect', 'history_remove'].includes(action.type));
    const visibleReceipts = [...businessReceipts.values()].filter(result => !signal?.aborted || committedMutation(result));
    const memoryReceipts = [...new Map(controlReceipts.filter(result => result.status === 'memory_updated')
      .map(result => [result.changeId || result.artifactId, result])).values()];
    const receipts = [...(manager.pendingCancelled ? ['已取消待确认的操作。'] : []), ...memoryReceipts.map(memoryReceiptText),
      ...visibleReceipts.map(result => result.answer)].filter(Boolean);
    if (signal?.aborted) {
      state.actions = state.actions.filter(action => ['collect', 'history_remove'].includes(action.type));
      if (runtime.awaitingThisTurn) state.pendingAction = '';
      const seen = new Set();
      state.cards = visibleReceipts.flatMap(result => result.cards || []).filter(card => {
        if (seen.has(card.anilistId)) return false;
        seen.add(card.anilistId); return true;
      });
    }
    const ref = rememberResult(manager.state, 'final_answer', { cards: state.cards,
      sourceTool: signal?.aborted ? 'business_operation' : selected.sourceTool || 'business_operation' });
    let body = manager.controlPending ? manager.interpretation?.clarification
      || '任务或记忆更新尚未完成，请明确需要处理的目标或范围。' : stripToolProtocol(normalizeContent(answer));
    if (receipts.includes(body)) body = '';
    const manifest = ref ? '\n作品清单：\n' + ref.items.map((item, index) => `${index + 1}.《${item.title}》`).join('\n') : '';
    // The receipt and numbered manifest are runtime facts, independent of model prose.
    const prefix = receipts.join('\n');
    const available = Math.max(0, config.maxAnswerChars - prefix.length - manifest.length - 4);
    const finalAnswer = [prefix, body.slice(0, available)].filter(Boolean).join('\n\n') + manifest;
    return { ...responseFromState(state, finalAnswer, { ...extra, authoritative: true }), operationCompleted,
      memoryReceipts, suggestions: visibleReceipts.at(-1)?.suggestions || [],
      sessionState: manager.state, memoryEpoch: manager.snapshot.memory.epoch,
      suppressHistory: Boolean(manager.suppressHistory), summaryThroughId: manager.snapshot.throughId,
      memorySummary: manager.snapshot.summary, evictedMessages: messages.evicted || [],
      maintenanceNeeded: Boolean(messages.historyIncomplete) };
  };
  const answer = async round => {
    if (manager.controlPending) return finish('');
    options.onProgress?.({ phase: 'answering', text: '白羽正在整理回答…' });
    options.onAnswerStart?.();
    let changed = false, emitted = 0;
    const finalMessages = [...messages,
      dataMessage('final_operation_receipts', {
        memory: controlReceipts.slice(-8), operations: [...businessReceipts.values()] }),
      { role: 'system', content: '现在进入最终作答阶段。工具调用已经结束，直接回答当前用户；只根据已获得的证据和操作回执作答，不再请求工具，不声称未执行的操作已完成。运行时会附上操作回执和作品清单，正文不要重复回执或另编清单。' },
      ...(round >= config.maxToolRounds || runtime.sequence >= config.maxToolCalls
        ? [{ role: 'system', content: '本轮工具执行预算已用完。只能解释已有结果，明确缺少证据或尚未完成的部分。' }] : [])];
    finalMessages.evicted = [...(messages.evicted || [])];
    finalMessages.historyIncomplete = Boolean(messages.historyIncomplete);
    // Retain schemas only when the provider supports an explicit execution ban.
    const finalTools = provider.supportsToolChoiceNone ? modelTools : [];
    const response = await modelCall(provider, finalMessages, finalTools, options, round, text => {
      throwIfAborted(signal);
      changed ||= contextChanged();
      if (changed) return false;
      const delta = String(text).slice(0, Math.max(0, config.maxAnswerChars - emitted));
      emitted += delta.length;
      if (delta) options.onDelta?.(delta);
      return Boolean(delta && options.onDelta);
    }, { toolChoice: finalTools.length ? 'none' : undefined });
    changed ||= contextChanged();
    if (changed) {
      options.onAnswerStart?.(); // Retract the old-epoch draft before replanning.
      messages = rebuildMessages();
      runtime.invalidate(); display.clear();
      return null;
    }
    if (response.tool_calls?.length) throw new Error('MODEL_FINAL_TOOL_CALLS_INVALID');
    messages = finalMessages;
    return finish(response.content, { streamed: response.streamed });
  };
  try {
    for (let round = 0; round <= config.maxToolRounds; round++) {
      throwIfAborted(signal);
      if (contextChanged()) { messages = rebuildMessages(); runtime.invalidate(); display.clear(); }
      if (manager.interpretation?.clarification) return finish(manager.interpretation.clarification);
      const tools = round < config.maxToolRounds && runtime.sequence < config.maxToolCalls ? modelTools : [];
      options.onProgress?.({ phase: 'planning', text: round ? '白羽正在核对查询结果…' : '白羽正在理解你的问题…' });
      if (!tools.length) {
        const result = await answer(round);
        if (result) return result;
        continue;
      }
      const response = await modelCall(provider, messages, tools, options, round);
      if (contextChanged()) { messages = rebuildMessages(); runtime.invalidate(); display.clear(); continue; }
      const calls = nativeCalls(response.tool_calls || [], runtime.usedIds);
      if (!calls.length) {
        const result = await answer(round);
        if (result) return result;
        continue;
      }
      const exchange = { role: 'assistant', content: normalizeContent(response.content) || null, tool_calls: calls,
        ...(response.reasoning_content ? { reasoning_content: response.reasoning_content } : {}) };
      messages.push(exchange);
      let rebuild = false;
      const loadedSkills = [];
      const previousState = sessionStateMessage({ ...options, sessionState: visibleSessionState(manager), pendingAction: state.pendingAction }).content;
      const apply = (call, raw) => {
        const name = call.function.name;
        const result = display.register(name, raw);
        if (['memory_updated', 'task_started'].includes(result.status)) {
          controlReceipts.push(result); rebuild = true; manager.changed = false;
          if (result.status === 'memory_updated' && result.changed) operationCompleted = true;
          runtime.invalidate(); display.clear(); state.cards = []; state.sources = [];
          // Committed business actions must survive a memory-context rebuild.
        }
        if (name === 'load_skill' && result.status === 'skill_loaded' && !options.activeSkills.has(result.name)) {
          options.activeSkills.set(result.name, result.instructions);
          loadedSkills.push(result.instructions);
        }
        mergeToolResult(state, name, result);
        rememberResult(manager.state, name, result);
        if (ACTION_TOOL_INTENTS[name] && ['completed', 'awaiting_confirmation'].includes(result.status)) {
          const key = result.operationId || call.id;
          if (!result.replayed) {
            businessReceipts.set(key, result);
            actionCards = result.cards || [];
          }
          if (result.status === 'completed' && !result.replayed
            && result.actions?.some(action => ['collect', 'history_remove'].includes(action.type))) {
            operationCompleted = true;
            manager.state.completedOperations = [...manager.state.completedOperations,
              { operationId: result.operationId, tool: name, status: 'completed' }].slice(-4);
          }
        }
        // Skill bodies are trusted project configuration, not duplicated tool data.
        const toolResult = name === 'load_skill' && result.status === 'skill_loaded'
          ? { ...result, instructions: undefined } : result;
        messages.push({ role: 'tool', tool_call_id: call.id, content: encodeWithinBudget(toolResult, memoryConfig().toolResultTokenBudget) });
      };
      // Consecutive independent reads may overlap; writes, context and presentation are barriers.
      for (let index = 0; index < calls.length;) {
        throwIfAborted(signal);
        const call = calls[index];
        if (!rebuild && toolRegistry.spec(call.function.name)?.effect === 'read'
          && !toolRegistry.spec(call.function.name)?.readBarrier) {
          const group = [];
          while (index < calls.length && group.length < config.readConcurrency
            && toolRegistry.spec(calls[index].function.name)?.effect === 'read'
            && !toolRegistry.spec(calls[index].function.name)?.readBarrier) group.push(calls[index++]);
          const results = await Promise.all(group.map(item => runtime.execute(item, { contextVersion })));
          results.forEach((result, offset) => apply(group[offset], result));
        } else {
          index++;
          apply(call, await runtime.execute(call, { contextChanged: rebuild, contextVersion }));
        }
      }
      exchange.exchangeComplete = true;
      exchange.requiredEvidence = true;
      if (rebuild) {
        messages = rebuildMessages();
        messages.splice(messages.length - 1, 0, dataMessage('control_and_operation_receipts', {
          memory: controlReceipts.slice(-8), operations: [...businessReceipts.values()] }));
      } else {
        // Preserve native assistant/tool adjacency; append context only after all results.
        for (const instructions of loadedSkills) messages.push(skillMessage(instructions));
        const latestState = sessionStateMessage({ ...options, sessionState: visibleSessionState(manager), pendingAction: state.pendingAction });
        if (latestState.content !== previousState) messages.push(latestState);
      }
    }
  } catch (error) {
    if (error.message.startsWith('OPERATION_OUTCOME_UNKNOWN')) throw error;
    if (operationCompleted) return finish(signal?.aborted
      ? '已停止后续任务；以上操作在停止前已经完成。'
      : '后续任务未能完整完成；以上操作回执仍然有效。', { fallback: true });
    throwIfAborted(signal);
    if (businessReceipts.size || controlReceipts.some(result => result.status === 'memory_updated')) {
      return finish('后续任务未能完整完成；以上操作回执仍然有效。', { fallback: true });
    }
    throw error;
  }
  return finish('已达到本轮执行上限，其余任务尚未完成。', { fallback: true });
}
async function localFallback() {
  return { answer: '当前没有配置可用的模型服务，请先配置 LLM_BASE_URL 和 LLM_MODEL。',
    cards: [], sources: [], actions: [], suggestions: [], fallback: true, intent: '' };
}

async function runAgent(options) {
  const scope = scopedSignal(options.signal, agentConfig().runTimeoutMs);
  let modelSequence = -1;
  const onModelRequest = event => { if (event.phase === 'start') modelSequence++; options.onModelRequest?.({ ...event, round: modelSequence }); };
  let manager;
  try {
    manager = new MemoryManager(options);
    const prepared = { ...options, pageContext: pageSnapshot(options.pageContext), memoryManager: manager,
      displayResults: new DisplayResults(), activeSkills: new Map(), signal: scope.signal, onModelRequest };
    throwIfAborted(scope.signal);
    const pending = readPending(options.pendingAction);
    const local = answer => ({ ...responseFromState({ cards: [], sources: [], actions: [], pendingAction: pending ? options.pendingAction : '' }, answer),
      sessionState: manager.state, memoryEpoch: manager.snapshot.memory.epoch });
    if (options.confirmationId && options.confirmationId !== pending?.operationId) return local('该确认操作已失效，请重新发起操作。');
    if (!options.provider?.isConfigured?.()) return { ...await localFallback(), sessionState: manager.state, pendingAction: options.pendingAction };
    // Interpret before exposing old prose/preferences. Never infer authorization from a keyword fallback.
    options.onProgress?.({ phase: 'planning', text: '白羽正在理解你的要求和记忆范围…' });
    const interpretationBudget = contextBudget(options.provider);
    manager.setInterpretation(await interpretRequest({ provider: options.provider, message: options.message,
      userId: options.userId, pendingAction: pending, signal: scope.signal,
      maxTokens: Math.min(6000, Math.floor(interpretationBudget.capacity / 4)),
      call: (messages, tools, request) => modelCall(options.provider, messages, tools, prepared, -1, null, request) }));
    if (!manager.interpretation.clarification && manager.interpretation.pendingDecision.action === 'cancel') {
      manager.pendingCancelled = true;
      prepared.pendingAction = '';
    }
    const budget = contextBudget(options.provider), tools = toolSchemasForModel(prepared);
    let preview = assemble(prepared, manager);
    const rawFirst = preview.find(item => item.id)?.id || 0;
    const missingSources = options.compactionCandidates?.filter(item => item.id < rawFirst) || [];
    if (!manager.controlPending && (contextTokenCount(preview, tools) > budget.high || missingSources.length)) {
      options.onProgress?.({ phase: 'compacting', text: '白羽正在整理对话上下文…' });
      const fixed = contextTokenCount(assemble({ ...prepared, history: [] }, manager), tools);
      prepared.historyBudget = Math.max(1000, budget.low - fixed);
      const low = assemble(prepared, manager, prepared.historyBudget);
      const firstId = low.find(item => item.id)?.id || Infinity;
      const targetId = Math.max(manager.snapshot.throughId, ...options.history.filter(item => item.id < firstId).map(item => item.id),
        ...missingSources.map(item => item.id));
      const compacted = await compactConversation({ provider: options.provider, conversationStore: options.conversationStore,
        userId: options.userId, sessionId: options.sessionId, targetId, signal: scope.signal, onModelRequest });
      manager.refresh();
      preview = assemble(prepared, manager, prepared.historyBudget);
      prepared.historyIncomplete = !compacted.progressed || options.conversationStore.compactionSources(options.userId, options.sessionId, manager.snapshot.throughId).some(item => item.id < firstId);
    }
    const result = await runModelAgent(prepared);
    result.maintenanceNeeded ||= contextTokenCount(preview, tools) + estimateTokens(result.answer) > budget.high;
    result.maintenanceTarget = Math.max(0, ...(result.evictedMessages || []).map(item => item.id));
    delete result.evictedMessages;
    return result;
  } catch (error) {
    if (error.message.startsWith('OPERATION_OUTCOME_UNKNOWN')) throw error;
    throwIfAborted(scope.signal);
    recordAgentEvent('model_error', { error: error.message });
    const answer = error.message.startsWith('CONTEXT_') ? '本次输入与必要上下文超过可用预算，请缩小问题范围后继续。'
      : error.message === 'MEMORY_INTERPRETATION_CONTRACT_FAILED' ? '未能可靠理解本轮的记忆与任务范围，请换一种说法后重试。'
      : error.message === 'MODEL_NATIVE_TOOL_CALLS_REQUIRED' ? '当前模型服务未能完成工具调用，请稍后重试或联系管理员。' : '本次回答未能完整生成，请稍后重试。';
    return { ...await localFallback(), answer, sessionState: manager?.state || options.contextSnapshot?.state || {}, pendingAction: manager?.pendingCancelled ? '' : options.pendingAction,
      memoryEpoch: manager?.snapshot.memory.epoch, suppressHistory: Boolean(manager?.suppressHistory) };
  } finally { scope.dispose(); }
}

module.exports = { runAgent, localFallback };
