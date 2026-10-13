function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('REQUEST_ABORTED');
}

function scopedSignal(parent, timeoutMs, code = 'REQUEST_TIMEOUT') {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason || new Error('REQUEST_ABORTED'));
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(code)), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, dispose() {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  } };
}

function delay(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason || new Error('REQUEST_ABORTED')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function retryable(error) {
  if (error?.status) return [408, 429].includes(error.status) || error.status >= 500;
  return error?.name === 'TypeError' || ['ECONNRESET', 'ETIMEDOUT', 'REQUEST_TIMEOUT'].includes(error?.code || error?.message);
}

async function retry(operation, { signal, attempts = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    try { return await operation(); }
    catch (error) {
      throwIfAborted(signal);
      if (attempt + 1 >= attempts || !retryable(error)) throw error;
      const backoff = Math.min(error.retryAfterMs || 400 * 2 ** attempt, 5000);
      await delay(backoff + Math.floor(Math.random() * 200), signal);
    }
  }
}

async function fetchJson(url, options = {}, { timeoutMs = 10000, attempts = 2, fetchImpl = globalThis.fetch } = {}) {
  return retry(async () => {
    const scope = scopedSignal(options.signal, timeoutMs);
    try {
      throwIfAborted(scope.signal);
      const response = await fetchImpl(url, { ...options, signal: scope.signal });
      // Error responses may be HTML; preserve their HTTP status for retry classification.
      const data = response.ok ? await response.json() : await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(`HTTP_${response.status}: ${data?.error?.message || data?.message || ''}`);
        error.status = response.status;
        const after = response.headers.get('retry-after');
        error.retryAfterMs = Number(after) * 1000 || Math.max(0, Date.parse(after) - Date.now()) || 0;
        throw error;
      }
      return { ok: true, status: response.status, data };
    } catch (error) {
      throwIfAborted(scope.signal);
      throw error;
    } finally { scope.dispose(); }
  }, { signal: options.signal, attempts });
}

function stableJson(value) {
  return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

module.exports = { throwIfAborted, scopedSignal, retry, fetchJson, stableJson };
