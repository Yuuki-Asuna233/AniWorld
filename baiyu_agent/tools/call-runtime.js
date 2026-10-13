const { executeCheckedTool } = require('./executor');
const { normalizeResult } = require('./contracts');
const { scopedSignal, throwIfAborted, stableJson } = require('../shared/runtime');
const { encodeWithinBudget } = require('../shared/json-budget');
const { memoryConfig } = require('../memory/memory');
const { agentConfig } = require('../core/config');
const { readPending, ACTION_TOOL_INTENTS } = require('./action-tools');
const { recordAgentEvent } = require('../diagnostics/diagnostics');

function nativeCalls(raw, usedIds) {
  if (!Array.isArray(raw)) throw new Error('MODEL_TOOL_CALLS_INVALID');
  const batch = new Set();
  for (const call of raw) {
    if (!call || call.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 200
      || usedIds.has(call.id) || batch.has(call.id) || !/^[a-zA-Z0-9_-]+$/.test(call.function?.name || '')
      || typeof call.function?.arguments !== 'string') throw new Error('MODEL_TOOL_CALLS_INVALID');
    batch.add(call.id);
  }
  for (const id of batch) usedIds.add(id);
  return raw;
}

class ToolCallRuntime {
  constructor(registry, options, state) {
    this.registry = registry; this.options = options; this.state = state;
    this.config = agentConfig(); this.sequence = 0; this.cache = new Map(); this.receipts = new Map();
    this.usedIds = new Set(); this.awaitingThisTurn = false;
    this.contextVersion = options.memoryManager.contextVersion;
  }
  invalidate() {
    this.cache.clear();
    delete this.options.memoryManager.recommendationProfileVersion;
    this.contextVersion = this.options.memoryManager.contextVersion;
  }
  observe(operation) {
    try { return operation(); }
    catch (_) { recordAgentEvent('tool_trace_error', { requestId: this.options.requestId }); return null; }
  }
  async execute(call, { contextChanged = false, contextVersion: plannedVersion = this.contextVersion } = {}) {
    const { memoryManager: manager, signal, conversationStore } = this.options;
    manager.refresh();
    contextChanged ||= plannedVersion !== manager.contextVersion;
    if (this.contextVersion !== manager.contextVersion) {
      this.invalidate();
      this.contextVersion = manager.contextVersion;
      contextChanged = true;
    }
    const name = call.function.name, spec = this.registry.spec(name);
    const sequence = ++this.sequence;
    const eventBase = { userId: this.options.userId, sessionId: this.options.sessionId,
      requestId: this.options.requestId, epoch: manager.snapshot.memory.epoch };
    let args = {}, result, errorReported = false;
    try {
      args = this.registry.normalizeArguments(name, JSON.parse(call.function.arguments));
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('TOOL_ARGUMENTS_INVALID');
      const fingerprint = name + ':' + stableJson(args);
      const previous = this.cache.get(fingerprint);
      const receipt = this.receipts.get(fingerprint);
      const pending = readPending(this.state.pendingAction);
      if (sequence > this.config.maxToolCalls) result = { error: '本轮工具次数已达到上限。', errorCode: 'TOOL_LIMIT' };
      else if (contextChanged && spec?.effect !== 'control') result = { error: '上下文已更新，请按新状态重新调用。', policyRejected: true };
      else if (manager.controlPending && ['recommend_anime', 'get_user_profile', ...Object.keys(ACTION_TOOL_INTENTS)].includes(name)) {
        result = { error: '请先完成记忆控制请求，或澄清目标。', policyRejected: true };
      } else if (receipt) result = { ...receipt, actions: [], replayed: true };
      else if (spec?.effect === 'business' && (this.awaitingThisTurn || (pending && pending.intent !== ACTION_TOOL_INTENTS[name]))) {
        result = { error: '已有待确认操作；本轮可继续查询，其他操作需确认或取消后再发起。', policyRejected: true };
      } else if (spec?.cache && previous?.result) result = previous.result;
      else if (spec?.cache && spec.effect === 'read' && previous?.promise) result = await previous.promise;
      else if (previous?.attempts >= 2) result = { error: '相同调用已失败两次，请更换条件或明确说明无法完成。', errorCode: 'TOOL_RETRY_LIMIT' };
      else {
        const attempt = { attempts: previous?.attempts || 0 };
        this.cache.set(fingerprint, attempt);
        this.observe(() => this.options.onToolEvent?.({ type: 'tool_start', name, args, sequence }));
        this.observe(() => conversationStore.event({ ...eventBase, kind: 'tool_call', payload: { name, callId: call.id, status: 'started' } }));
        const scope = scopedSignal(signal, spec?.timeoutMs || this.config.toolTimeoutMs);
        attempt.promise = (async () => {
          try {
            const userMemorySummary = manager.view(this.options.message,
              { forRecommendation: ['recommend_anime', 'get_user_profile'].includes(name) });
            const stale = plannedVersion !== manager.contextVersion;
            if (stale) this.invalidate();
            let value = normalizeResult(stale && spec?.effect !== 'control'
              ? { error: '上下文已更新，请按新状态重新调用。', policyRejected: true }
              : await executeCheckedTool({ registry: this.registry, name, args, context: {
              ...this.options, signal: scope.signal, pendingAction: this.state.pendingAction,
              userMemorySummary
            } }));
            if ((spec?.effect === 'business' && ['completed', 'awaiting_confirmation'].includes(value.status)) ||
                (spec?.effect === 'control' && ['memory_updated', 'task_started'].includes(value.status))) {
              this.receipts.set(fingerprint, value);
              this.awaitingThisTurn ||= value.status === 'awaiting_confirmation';
              this.invalidate(); // User state and recommendation inputs may have changed.
            }
            const artifact = this.observe(() => conversationStore.artifact({ ...eventBase, epoch: manager.snapshot.memory.epoch, payload: value }));
            if (artifact?.id) value = { ...value, artifactId: artifact.id };
            if (!['error', 'rejected'].includes(value.outcome)) {
              attempt.attempts = 0;
              if (spec?.cache) attempt.result = value;
            } else attempt.attempts++;
            return value;
          } catch (error) {
            attempt.attempts++;
            throw error;
          } finally {
            scope.dispose();
            attempt.promise = null;
          }
        })();
        result = await attempt.promise;
      }
    } catch (error) {
      throwIfAborted(signal);
      if (error.message.startsWith('OPERATION_OUTCOME_UNKNOWN')) throw error;
      result = { error: error.message, errorCode: 'TOOL_EXECUTION_FAILED' };
      this.observe(() => this.options.onToolEvent?.({ type: 'tool_error', name, args, error: error.message, sequence }));
      errorReported = true;
    }
    result = normalizeResult(result);
    if (!errorReported) this.observe(() => this.options.onToolEvent?.({ type: 'tool_result', name, args, result, sequence }));
    this.observe(() => conversationStore.event({ ...eventBase, epoch: manager.snapshot.memory.epoch, kind: 'tool_result',
      payload: { name, callId: call.id, status: result.outcome, ...(result.artifactId ? { artifactId: result.artifactId } : {}),
        result: JSON.parse(encodeWithinBudget(result, memoryConfig().toolResultTokenBudget)) } }));
    return result;
  }
}

module.exports = { ToolCallRuntime, nativeCalls };
