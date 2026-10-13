// Missing provider counters stay unknown; estimates must not become cache misses.
function counter(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usageValue(usage, names) {
  for (const name of names) {
    const value = counter(usage?.[name]);
    if (value !== null) return value;
  }
  return null;
}

function modelUsage(usage = {}, estimates = {}) {
  const reportedInput = usageValue(usage, ['prompt_tokens', 'input_tokens', 'promptTokens', 'inputTokens']);
  const reportedOutput = usageValue(usage, ['completion_tokens', 'output_tokens', 'completionTokens', 'outputTokens']);
  const inputTokens = reportedInput ?? counter(estimates.inputTokens) ?? 0;
  const outputTokens = reportedOutput ?? counter(estimates.outputTokens) ?? 0;
  let cacheHitTokens = counter(usage.prompt_cache_hit_tokens)
    ?? counter(usage.prompt_tokens_details?.cached_tokens) ?? counter(usage.input_tokens_details?.cached_tokens);
  let cacheMissTokens = counter(usage.prompt_cache_miss_tokens);
  if (cacheHitTokens === null && cacheMissTokens !== null && reportedInput !== null && cacheMissTokens <= reportedInput) {
    cacheHitTokens = reportedInput - cacheMissTokens;
  }
  if (cacheMissTokens === null && cacheHitTokens !== null && reportedInput !== null && cacheHitTokens <= reportedInput) {
    cacheMissTokens = reportedInput - cacheHitTokens;
  }
  if (reportedInput !== null && ((cacheHitTokens !== null && cacheHitTokens > reportedInput)
    || (cacheMissTokens !== null && cacheMissTokens > reportedInput)
    || (cacheHitTokens !== null && cacheMissTokens !== null && cacheHitTokens + cacheMissTokens !== reportedInput))) {
    cacheHitTokens = null; cacheMissTokens = null;
  }
  return { inputTokens, outputTokens,
    totalTokens: usageValue(usage, ['total_tokens', 'totalTokens']) ?? inputTokens + outputTokens,
    tokensEstimated: reportedInput === null || reportedOutput === null,
    cacheHitTokens, cacheMissTokens };
}

module.exports = { modelUsage };
