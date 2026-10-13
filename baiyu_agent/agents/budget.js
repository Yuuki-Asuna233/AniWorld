const { memoryConfig } = require('../memory/memory');

function contextBudget(provider, outputTokens = provider?.maxTokens || 2000) {
  const c = memoryConfig();
  const capacity = Math.min(c.contextTokenBudget, provider?.contextWindow || c.contextTokenBudget);
  const safety = Math.min(c.safetyReserve, Math.floor(capacity * 0.1));
  const input = capacity - outputTokens - safety;
  const active = input - Math.min(c.toolReserve, Math.floor(capacity * 0.1));
  if (active < 500) throw new Error('CONTEXT_CAPACITY_TOO_SMALL');
  const high = Math.min(c.highWatermark, Math.floor(active * 0.88));
  return { capacity, input, active, high, low: Math.min(c.lowWatermark, Math.floor(high * 0.67)), safety, outputTokens };
}

module.exports = { contextBudget };
