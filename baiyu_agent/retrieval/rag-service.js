const { throwIfAborted } = require('../shared/runtime');
const { EmbeddingProvider } = require('./embedding-provider');
const {
  buildAnimeMetaChunks,
  buildAnimeDetailChunks,
  buildWebChunks,
  cleanText
} = require('./rag-chunker');
const { searchAnimeEvidence } = require('./web-search');
const { envInt } = require('../shared/utils');
const { VectorIndexView } = require('./vector-index-view');
const { entityKnowledge } = require('./entity-knowledge');

const instances = new WeakMap();

const QUERY_EXPANSIONS = {
  治愈: 'Iyashikei Slice of Life', 校园: 'school school life', 日常: 'Slice of Life',
  异世界: 'isekai another world Fantasy', 奇幻: 'Fantasy', 冒险: 'Adventure',
  战斗: 'Action battle', 动作: 'Action', 搞笑: 'Comedy', 喜剧: 'Comedy',
  恋爱: 'Romance', 爱情: 'Romance', 悬疑: 'Mystery', 推理: 'Mystery',
  科幻: 'Sci-Fi science fiction', 机甲: 'Mecha', 音乐: 'Music',
  运动: 'Sports', 百合: 'Yuri', 后宫: 'Harem', 恐怖: 'Horror',
  超自然: 'Supernatural', 心理: 'Psychological'
};

function ragConfig(env = process.env) {
  const minScoreRaw = Number(env.RAG_MIN_SCORE);
  return {
    enabled: !['0', 'false', 'no'].includes(String(env.RAG_ENABLED || 'true').toLowerCase()),
    candidateK: envInt('RAG_CANDIDATE_K', 12, 4, 50, env),
    finalK: envInt('RAG_FINAL_K', 6, 1, 10, env),
    minScore: Number.isFinite(minScoreRaw) ? Math.max(0, Math.min(minScoreRaw, 1)) : 0.42,
    autoIndex: ['1', 'true', 'yes'].includes(String(env.RAG_AUTO_INDEX || '').toLowerCase()),
    autoIndexBatch: envInt('RAG_AUTO_INDEX_BATCH', 24, 1, 200, env),
    externalTtlDays: envInt('RAG_EXTERNAL_TTL_DAYS', 30, 1, 365, env)
  };
}

function vectorToBlob(vector) {
  const float = Float32Array.from(vector || []);
  return new Uint8Array(float.buffer.slice(0));
}

function blobToVector(blob, dimensions = 0) {
  if (!blob) return new Float32Array(0);
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const count = bytes.byteLength / 4;
  if (!Number.isInteger(count) || (dimensions > 0 && dimensions !== count)) throw new Error('EMBEDDING_DIMENSION_MISMATCH');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const output = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    output[index] = view.getFloat32(index * 4, true);
    if (!Number.isFinite(output[index])) throw new Error('EMBEDDING_INVALID_VECTOR');
  }
  return output;
}

function cosineSimilarity(left, right) {
  if (left?.length !== right?.length) throw new Error('EMBEDDING_DIMENSION_MISMATCH');
  const length = left?.length || 0;
  if (!length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index++) {
    const a = Number(left[index]) || 0;
    const b = Number(right[index]) || 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function hybridScore(vectorScore, keywordScore, trustScore) {
  return Math.max(0, Math.min(1, Number(vectorScore) || 0)) * 0.65
    + Math.max(0, Math.min(1, Number(keywordScore) || 0)) * 0.25
    + Math.max(0, Math.min(100, Number(trustScore) || 0)) / 100 * 0.10;
}

function expandQuery(query) {
  const text = cleanText(query);
  const additions = [];
  for (const [word, expansion] of Object.entries(QUERY_EXPANSIONS)) {
    if (text.includes(word)) additions.push(expansion);
  }
  return [...new Set([text, ...additions])].filter(Boolean).join(' ');
}

function rewriteRetrievalQuery(query) { return cleanText(query); }

function lexicalTokens(value) {
  const text = cleanText(value).toLowerCase();
  const tokens = new Set();
  for (const word of text.match(/[a-z0-9][a-z0-9+._:-]*/g) || []) {
    if (word.length > 1) tokens.add(word);
  }
  for (const sequence of text.match(/[\u3400-\u9fff]{1,}/g) || []) {
    if (sequence.length === 1) tokens.add(sequence);
    else {
      tokens.add(sequence);
      for (let index = 0; index < sequence.length - 1; index++) tokens.add(sequence.slice(index, index + 2));
    }
  }
  return [...tokens];
}

function lexicalScore(query, document) {
  const queryText = cleanText(query).toLowerCase();
  const documentText = cleanText(document).toLowerCase();
  if (!queryText || !documentText) return 0;
  if (documentText.includes(queryText)) return 1;
  const queryTokens = lexicalTokens(expandQuery(queryText));
  if (!queryTokens.length) return 0;
  const documentTokens = new Set(lexicalTokens(documentText));
  let matchedWeight = 0;
  let totalWeight = 0;
  for (const token of queryTokens) {
    const weight = token.length >= 3 ? 1.5 : 1;
    totalWeight += weight;
    if (documentTokens.has(token) || documentText.includes(token)) matchedWeight += weight;
  }
  return totalWeight ? Math.min(1, matchedWeight / totalWeight) : 0;
}

function sourceFromResult(item) {
  return {
    title: item.sourceTitle || item.source_title || '',
    url: item.sourceUrl || item.source_url || '',
    trustScore: Number(item.trustScore ?? item.trust_score) || 0,
    publishedDate: item.publishedAt || item.published_at || '',
    sourceType: item.sourceType || item.source_type || ''
  };
}

class RagService {
  constructor(database, options = {}) {
    this.database = database;
    this.embedding = options.embeddingProvider || new EmbeddingProvider();
    this.webSearch = options.webSearch || searchAnimeEvidence;
    this.config = options.config || ragConfig();
    this.vectorView = new VectorIndexView(database, blobToVector,
      envInt('RAG_DECODE_CACHE_MB', 64, 0, 256) * 1024 * 1024);
  }

  isConfigured() {
    return this.config.enabled && this.embedding.isConfigured();
  }

  status() {
    return {
      enabled: this.config.enabled,
      embedding: this.embedding.config ? this.embedding.config() : {
        configured: this.embedding.isConfigured(), model: this.embedding.model || ''
      },
      retrieval: {
        candidateK: this.config.candidateK,
        finalK: this.config.finalK,
        minScore: this.config.minScore,
        decodedCache: { usedBytes: this.vectorView.bytes, maxBytes: this.vectorView.maxBytes,
          pages: this.vectorView.pages.size, queuedScans: this.vectorView.waiting.length, maxConcurrentScans: 1 },
        weights: { vector: 0.65, keyword: 0.25, sourceTrust: 0.10 }
      },
      index: this.database.getRagIndexStats()
    };
  }

  get indexKey() { return this.embedding.model; }

  existingChunkMap(anilistId, sourceType) {
    const rows = this.database.getRagChunksByAnime(anilistId, sourceType, this.indexKey);
    return new Map(rows.map(row => [row.id, row]));
  }

  async indexPreparedGroups(groups) {
    const task = (this.indexChain || Promise.resolve()).then(() => this.writePreparedGroups(groups));
    this.indexChain = task.catch(() => {});
    return task;
  }

  async writePreparedGroups(groups) {
    if (!this.isConfigured()) throw new Error('EMBEDDING_NOT_CONFIGURED');
    const stale = [];
    const indexedGroups = [];
    for (const group of groups) {
      group.existing = this.existingChunkMap(group.anilistId, group.sourceType);
      for (const chunk of group.chunks) {
        const current = group.existing.get(chunk.id);
        if (!current || current.content_hash !== chunk.contentHash || !current.embedding?.length) stale.push(chunk);
      }
    }
    const vectors = stale.length
      ? await this.embedding.embedDocuments(stale.map(chunk => chunk.chunkText))
      : [];
    const vectorById = new Map(stale.map((chunk, index) => [chunk.id, vectors[index]]));
    this.database.prepareRagIndexWrite?.();
    let embedded = 0;
    let reused = 0;
    for (const group of groups) {
      if (group.sourceType === 'anime_meta' && this.database.getRagQueueGeneration(group.anilistId) !== group.generation) continue;
      const completed = group.chunks.map(chunk => {
        const current = group.existing.get(chunk.id);
        const vector = vectorById.get(chunk.id);
        if (vector) embedded++;
        else reused++;
        return {
          ...chunk,
          embeddingModel: this.indexKey,
          embeddingDimensions: vector?.length || Number(current?.embedding_dimensions) || 0,
          embedding: vector ? vectorToBlob(vector) : current.embedding,
          createdAt: Number(current?.created_at) || undefined
        };
      });
      const result = this.database.replaceAnimeRagChunks(
        group.anilistId, group.sourceType, this.indexKey, completed
      );
      if (result.error) throw new Error(result.error);
      indexedGroups.push(group);
    }
    const completedMetaIds = indexedGroups
      .filter(group => group.sourceType === 'anime_meta')
      .map(group => ({ anilistId: group.anilistId, generation: group.generation }));
    if (completedMetaIds.length) this.database.completePendingRagAnime(completedMetaIds);
    return { anime: indexedGroups.length, chunks: indexedGroups.reduce((sum, group) => sum + group.chunks.length, 0), embedded, reused };
  }

  async indexAnimeRows(rows = []) {
    const groups = rows.map(meta => ({
      anilistId: Number(meta.anilist_id) || 0,
      sourceType: 'anime_meta',
      generation: String(meta._rag_generation ?? this.database.getRagQueueGeneration(Number(meta.anilist_id))),
      chunks: buildAnimeMetaChunks(meta)
    })).filter(group => group.anilistId && group.chunks.length);
    return this.indexPreparedGroups(groups);
  }

  async indexAnimeDetail(detail) {
    const chunks = buildAnimeDetailChunks(detail);
    const anilistId = Number(detail?.anilistId || detail?.anilist_id) || 0;
    if (!anilistId || !chunks.length || !this.isConfigured()) return { anime: 0, chunks: 0, skipped: true };
    return this.indexPreparedGroups([{ anilistId, sourceType: 'anilist_detail', chunks }]);
  }

  async indexAnimeDetails(details = []) {
    const groups = details.map(detail => ({
      anilistId: Number(detail?.anilistId || detail?.anilist_id) || 0,
      sourceType: 'anilist_detail',
      chunks: buildAnimeDetailChunks(detail)
    })).filter(group => group.anilistId && group.chunks.length);
    if (!groups.length) return { anime: 0, chunks: 0, embedded: 0, reused: 0 };
    return this.indexPreparedGroups(groups);
  }

  async indexAll({ pageSize = 100, maxAnime = 0, enrich = false, detailLoader, onProgress } = {}) {
    if (!this.isConfigured()) throw new Error('EMBEDDING_NOT_CONFIGURED');
    let afterId = 0;
    let processed = 0;
    let totals = { anime: 0, detailAnime: 0, chunks: 0, embedded: 0, reused: 0, enrichmentErrors: 0 };
    while (true) {
      const remaining = maxAnime > 0 ? Math.max(0, maxAnime - processed) : pageSize;
      if (maxAnime > 0 && remaining === 0) break;
      const rows = this.database.getAnimeMetaForRag(afterId, Math.min(pageSize, remaining || pageSize));
      if (!rows.length) break;
      const result = await this.indexAnimeRows(rows);
      for (const key of ['anime', 'chunks', 'embedded', 'reused']) totals[key] += Number(result[key]) || 0;
      if (enrich && detailLoader) {
        try {
          const details = await detailLoader(rows.map(row => Number(row.anilist_id)).filter(Boolean));
          const detailResult = await this.indexAnimeDetails(details);
          totals.detailAnime += Number(detailResult.anime) || 0;
          for (const key of ['chunks', 'embedded', 'reused']) totals[key] += Number(detailResult[key]) || 0;
        } catch (error) {
          totals.enrichmentErrors++;
          console.warn(`[RAG] AniList detail enrichment skipped for batch ending at ${afterId}: ${error.message}`);
        }
      }
      processed += rows.length;
      afterId = Number(rows[rows.length - 1].anilist_id) || afterId;
      if (onProgress) onProgress({ processed, afterId, ...totals });
      if (rows.length < Math.min(pageSize, remaining || pageSize)) break;
    }
    this.database.saveToFile();
    return totals;
  }

  async indexPending(limit = this.config.autoIndexBatch) {
    if (!this.isConfigured()) return { skipped: true, reason: 'EMBEDDING_NOT_CONFIGURED' };
    const rows = this.database.getPendingRagAnime(limit);
    if (!rows.length) return { anime: 0, chunks: 0, embedded: 0, reused: 0 };
    return this.indexAnimeRows(rows);
  }

  async *chunkPages(options = {}) {
    yield* this.vectorView.scan(this.indexKey, options);
  }

  selectFinal(ranked, finalK) {
    const counts = new Map();
    const selected = [];
    for (const item of ranked) {
      const key = item.anilistId || item.sourceUrl || item.id;
      if ((counts.get(key) || 0) >= 2) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
      selected.push(item);
      if (selected.length >= finalK) break;
    }
    return selected;
  }

  async rankQuery(query, options, exactScores) {
    if (!this.database.getRagChunkPage(this.indexKey, '', 1).length) return { ranked: [], scanned: 0 };
    const vector = await this.embedding.embedQuery(expandQuery(query), { signal: options.signal });
    return this.vectorView.run(options.signal, () => this.rankVector(query, vector, options, exactScores));
  }

  async rankVector(query, vector, options, exactScores) {
    const ranked = [];
    const version = this.database.getRagIndexVersion();
    const queryTokens = lexicalTokens(expandQuery(query).toLowerCase());
    let scanned = 0;
    for await (const page of this.chunkPages(options)) {
      for (const row of page) {
        if (options.anilistId && Number(row.anilist_id) !== Number(options.anilistId)) continue;
        if (++scanned % 200 === 0) { await new Promise(resolve => setImmediate(resolve)); throwIfAborted(options.signal); }
        const document = row.document;
        const keywordScore = Math.max((exactScores.get(Number(row.anilist_id)) || 0) / 100,
          queryTokens.length ? queryTokens.filter(token => document.includes(token)).length / queryTokens.length : 0);
        const vectorScore = Math.max(0, cosineSimilarity(vector, row.vector));
        const score = hybridScore(vectorScore, keywordScore, row.trust_score);
        if (score < this.config.minScore) continue;
        const item = { id: row.id, anilistId: Number(row.anilist_id) || 0, chunkType: row.chunk_type,
          chunkText: row.chunk_text, sourceType: row.source_type, sourceUrl: row.source_url,
          sourceTitle: row.source_title, publishedAt: row.published_at, trustScore: Number(row.trust_score) || 0,
          vectorScore, keywordScore, score };
        ranked.push(item);
        const diverse = this.selectFinal(ranked.sort((a, b) => b.score - a.score), options.candidateK);
        ranked.splice(0, ranked.length, ...diverse);
      }
    }
    if (version !== this.database.getRagIndexVersion()) throw new Error('RAG_INDEX_CHANGED');
    return { ranked, scanned };
  }

  async retrieve(query, options = {}) {
    throwIfAborted(options.signal);
    const cleanQuery = cleanText(query).slice(0, 500);
    const candidateK = Math.max(4, Math.min(Number(options.candidateK) || this.config.candidateK, 50));
    const finalK = Math.max(1, Math.min(Number(options.finalK) || this.config.finalK, 10));
    if (options.knowledge && options.anilistId) {
      const bound = entityKnowledge(this.database, this.indexKey, options.anilistId, cleanQuery, finalK, lexicalScore);
      if (bound) return { ...bound, configured: this.isConfigured(), threshold: this.config.minScore };
    }
    const titleSearch = options.knowledge ? this.database.searchAnimeMetaByAnyTitle : this.database.searchAnimeMetaByTitle;
    const boundMeta = options.anilistId ? this.database.getAnimeMetaById(options.anilistId) : null;
    const exactRows = options.anilistId ? boundMeta ? [boundMeta] : []
      : cleanQuery ? titleSearch.call(this.database, cleanQuery, candidateK) : [];
    const exactScores = new Map(exactRows.map(row => [Number(row.anilist_id), Number(row.match_score) || 0]));
    let selected = [], rewrittenQuery = '', externalUsed = false, externalAttempted = false,
      externalError = '', degraded = false, scanned = 0;
    if (cleanQuery && this.isConfigured()) {
      try {
        const first = await this.rankQuery(cleanQuery, { ...options, candidateK }, exactScores);
        selected = this.selectFinal(first.ranked, finalK);
        scanned = first.scanned;
      } catch (error) {
        throwIfAborted(options.signal);
        degraded = true;
        externalError = error.message;
      }
    }
    // Deliver actual facts from title matches even without a usable vector index.
    if (!selected.length) selected = this.selectFinal(exactRows.flatMap(meta => buildAnimeMetaChunks(meta).map(chunk => ({
      ...chunk, score: Math.min(1, (Number(meta.match_score) || 60) / 100), vectorScore: 0,
      keywordScore: Math.min(1, (Number(meta.match_score) || 60) / 100), matchType: 'title'
    }))), finalK);
    if (!selected.length && cleanQuery && options.allowWebFallback) {
      try {
        externalAttempted = true;
        const search = await this.webSearch({ query: cleanQuery, purpose: 'stable', maxResults: 5, signal: options.signal });
        externalAttempted = search.attempted !== false;
        if (search.error) externalError = search.error;
        const trusted = (search.results || []).filter(item => Number(item.trustScore) >= 70);
        const provisional = trusted.length ? trusted : (search.results || []).filter(item => Number(item.trustScore) >= 45).slice(0, 2);
        selected = this.selectFinal(buildWebChunks(provisional)
          .map(chunk => ({ ...chunk, score: lexicalScore(cleanQuery, chunk.chunkText), matchType: 'web', vectorScore: 0, keywordScore: 0 }))
          .filter(chunk => chunk.score >= 0.15), finalK);
        externalUsed = selected.length > 0;
        // Web search is usable without embeddings; optional indexing never delays this request.
      } catch (error) { throwIfAborted(options.signal); externalError = error.message; }
    }
    const requiresVerification = selected.some(item => item.sourceType === 'web' && Number(item.trustScore) < 70);
    const sources = [...new Map(selected.filter(item => item.sourceUrl).map(item => [item.sourceUrl, sourceFromResult(item)])).values()];
    return { configured: this.isConfigured(), indexed: scanned > 0, mode: externalUsed ? 'web' : selected.some(item => item.vectorScore > 0) ? 'hybrid' : 'fts',
      query: cleanQuery, rewrittenQuery, lowConfidence: !selected.length || requiresVerification,
      degraded, externalUsed, externalAttempted, requiresVerification, externalError, threshold: this.config.minScore,
      candidateCount: selected.length, scanned, results: selected, exactRows, sources };
  }

  async searchAnime(query, limit = 8, options = {}) {
    const retrieval = await this.retrieve(query, { ...options, finalK: Math.min(limit, this.config.finalK), allowWebFallback: false });
    const rows = [];
    const seen = new Set();
    const add = meta => {
      const id = Number(meta?.anilist_id) || 0;
      if (!id || seen.has(id)) return;
      seen.add(id);
      rows.push(meta);
    };
    for (const row of retrieval.exactRows || []) add(row);
    // Exact title rows are safe to retain, but semantic/vector candidates must
    // never bypass the confidence gate just because a fuzzy FTS row exists.
    if (!retrieval.lowConfidence) {
      for (const result of retrieval.results || []) add(this.database.getAnimeMetaById(result.anilistId));
    }
    return { rows: rows.slice(0, limit), retrieval };
  }

  async recommendationCandidates(query, limit = 12, options = {}) {
    const retrieval = await this.retrieve(query, { ...options, finalK: Math.min(limit, 10), allowWebFallback: false });
    if (retrieval.lowConfidence) return { candidates: [], retrieval };
    const bestByAnime = new Map();
    for (const result of retrieval.results || []) {
      if (!result.anilistId) continue;
      const existing = bestByAnime.get(result.anilistId);
      if (!existing || result.score > existing.score) {
        bestByAnime.set(result.anilistId, { anilistId: result.anilistId, score: result.score });
      }
    }
    return { candidates: [...bestByAnime.values()].sort((a, b) => b.score - a.score).slice(0, limit), retrieval };
  }
}

function getRagService(database) {
  if (!instances.has(database)) instances.set(database, new RagService(database));
  return instances.get(database);
}

function startRagAutoIndexer(database) {
  const service = getRagService(database);
  if (!service.config.autoIndex || !service.isConfigured()) return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await service.indexPending();
      if (result.anime) console.log(`[RAG] Incrementally indexed ${result.anime} anime / ${result.chunks} chunks`);
    } catch (error) {
      console.warn('[RAG] Incremental indexing failed:', error.message);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 3000).unref?.();
  const timer = setInterval(tick, 5 * 60 * 1000);
  timer.unref?.();
  return timer;
}

module.exports = {
  RagService,
  getRagService,
  startRagAutoIndexer,
  ragConfig,
  vectorToBlob,
  blobToVector,
  cosineSimilarity,
  hybridScore,
  lexicalScore,
  expandQuery,
  rewriteRetrievalQuery
};
