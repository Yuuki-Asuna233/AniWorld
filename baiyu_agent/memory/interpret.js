const { MEMORY_CONTEXT_SCHEMA, MEMORY_INTERPRETATION_PROMPT, PENDING_DECISION_PROMPT, interpretMemoryResponse } = require('./semantics');
const { currentDateReference } = require('../shared/date-context');
const { throwIfAborted } = require('../shared/runtime');

// Contract correction retries interpretation only, never a memory/business mutation.
async function interpretRequest({ provider, message, userId, pendingAction, signal, maxTokens, call }) {
  const now = Date.now();
  const messages = [{ role: 'system', content: MEMORY_INTERPRETATION_PROMPT + '\n' + PENDING_DECISION_PROMPT },
    { role: 'user', content: JSON.stringify({ message, loggedIn: Boolean(userId), pendingAction: pendingAction
      ? { intent: pendingAction.intent, target: pendingAction.target, operationId: pendingAction.operationId } : null,
      referenceTime: { ...currentDateReference(new Date(now)), timestampMs: now, isoUtc: new Date(now).toISOString() } }) }];
  for (let attempt = 0; attempt < 2; attempt++) {
    throwIfAborted(signal);
    try {
      const response = await call(messages, [MEMORY_CONTEXT_SCHEMA], { maxTokens,
        toolChoice: provider.supportsForcedTools ? { type: 'function', function: { name: MEMORY_CONTEXT_SCHEMA.function.name } } : undefined,
        purpose: 'memory_interpretation' });
      return interpretMemoryResponse(response, message, now, pendingAction);
    }
    catch (error) {
      const contractError = error instanceof SyntaxError || error.message?.startsWith('MEMORY_INTERPRETATION_')
        || ['MODEL_NATIVE_TOOL_CALLS_REQUIRED', 'MODEL_EMPTY_RESPONSE'].includes(error.message);
      if (!contractError) throw error;
      if (attempt) throw new Error('MEMORY_INTERPRETATION_CONTRACT_FAILED');
      messages.push({ role: 'system', content: '上一次输出未满足解释契约。重新解释同一用户消息，只返回一次 interpret_memory_request 原生工具调用，严格遵守字段、原文引用和范围约束；没有明确意图时返回空 requests，需要澄清时明确说明。' });
    }
  }
}
module.exports = { interpretRequest };
