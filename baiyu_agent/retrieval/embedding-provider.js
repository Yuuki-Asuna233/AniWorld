const { fetchJson, throwIfAborted } = require('../shared/runtime');
const { envInt } = require('../shared/utils');

function normalizeVector(values) {
  const vector = Array.from(values || [], Number);
  if (!vector.length || vector.some(value => !Number.isFinite(value))) {
    throw new Error('EMBEDDING_INVALID_VECTOR');
  }
  let normSquared = 0;
  for (const value of vector) normSquared += value * value;
  const norm = Math.sqrt(normSquared);
  if (!norm || !Number.isFinite(norm)) throw new Error('EMBEDDING_INVALID_VECTOR');
  return vector.map(value => value / norm);
}

class EmbeddingProvider {
  constructor(env = process.env, fetchImpl = globalThis.fetch) {
    // The endpoint must be explicit. Silently reusing LLM_BASE_URL can send a
    // large indexing job to a chat-only or billable endpoint by accident.
    this.baseUrl = String(env.EMBEDDING_BASE_URL || '').replace(/\/$/, '');
    const llmBaseUrl = String(env.LLM_BASE_URL || '').replace(/\/$/, '');
    const sameEndpoint = this.baseUrl && llmBaseUrl && this.baseUrl === llmBaseUrl;
    this.apiKey = String(env.EMBEDDING_API_KEY || (sameEndpoint ? env.LLM_API_KEY : '') || '');
    this.model = String(env.EMBEDDING_MODEL || '').trim();
    this.timeoutMs = envInt('EMBEDDING_TIMEOUT_MS', 30000, 3000, 120000, env);
    this.batchSize = envInt('EMBEDDING_BATCH_SIZE', 32, 1, 128, env);
    this.dimensions = envInt('EMBEDDING_DIMENSIONS', 0, 0, 8192, env);
    this.queryPrefix = String(env.EMBEDDING_QUERY_PREFIX || '');
    this.documentPrefix = String(env.EMBEDDING_DOCUMENT_PREFIX || '');
    this.fetchImpl = fetchImpl;
  }

  // Preserve the model-named index used by stored vectors. Changing embedding
  // endpoint, dimensions or prefixes requires an explicit index rebuild.
  get indexKey() { return this.model; }

  isConfigured() {
    return Boolean(this.baseUrl && this.model && this.fetchImpl);
  }

  endpoint() {
    if (/\/embeddings$/i.test(this.baseUrl)) return this.baseUrl;
    return `${this.baseUrl}/embeddings`;
  }

  async request(inputs, signal) {
    if (!this.isConfigured()) throw new Error('EMBEDDING_NOT_CONFIGURED');
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const payload = { model: this.model, input: inputs };
    if (this.dimensions > 0) payload.dimensions = this.dimensions;
    const { data } = await fetchJson(this.endpoint(), {
      method: 'POST', headers, signal, body: JSON.stringify(payload)
    }, { timeoutMs: this.timeoutMs, attempts: 3, fetchImpl: this.fetchImpl });
    const items = Array.isArray(data?.data) ? data.data.slice().sort((a, b) => Number(a.index) - Number(b.index)) : [];
    if (items.length !== inputs.length || items.some((item, index) => Number(item.index) !== index)) throw new Error('EMBEDDING_COUNT_MISMATCH');
    const vectors = items.map(item => normalizeVector(item.embedding));
    const dimensions = this.dimensions || vectors[0].length;
    if (vectors.some(vector => vector.length !== dimensions)) throw new Error('EMBEDDING_DIMENSION_MISMATCH');
    return vectors;
  }

  async embed(inputs, { type = 'document', signal } = {}) {
    const values = Array.isArray(inputs) ? inputs : [inputs];
    const prefix = type === 'query' ? this.queryPrefix : this.documentPrefix;
    const prepared = values.map(value => `${prefix}${String(value || '').trim()}`);
    const output = [];
    for (let offset = 0; offset < prepared.length; offset += this.batchSize) {
      throwIfAborted(signal);
      output.push(...await this.request(prepared.slice(offset, offset + this.batchSize), signal));
    }
    return output;
  }

  async embedQuery(text, options = {}) { return (await this.embed([text], { ...options, type: 'query' }))[0]; }
  async embedDocuments(texts, options = {}) { return this.embed(texts, { ...options, type: 'document' }); }

  config() {
    return {
      configured: this.isConfigured(),
      model: this.model,
      indexKey: this.indexKey,
      endpoint: this.baseUrl ? this.endpoint() : '',
      batchSize: this.batchSize,
      dimensions: this.dimensions || null
    };
  }
}

module.exports = { EmbeddingProvider, normalizeVector };
