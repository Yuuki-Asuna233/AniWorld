const assert = require('assert');
const { configureTestDatabase } = require('./helpers/test-database');

const testDatabase = configureTestDatabase('rag-regression');

const database = require('../../apps/server/database');
const { normalizeVector } = require('../../baiyu_agent/retrieval/embedding-provider');
const {
  RagService,
  hybridScore,
  cosineSimilarity,
  vectorToBlob,
  blobToVector,
  rewriteRetrievalQuery
} = require('../../baiyu_agent/retrieval/rag-service');
const {
  splitLongText,
  buildAnimeMetaChunks,
  buildAnimeDetailChunks,
  buildWebChunks
} = require('../../baiyu_agent/retrieval/rag-chunker');

class FakeEmbeddingProvider {
  constructor() {
    this.model = 'fake-bge-m3';
    this.calls = 0;
  }

  isConfigured() { return true; }
  config() { return { configured: true, model: this.model, endpoint: 'fake://embeddings' }; }

  vector(text) {
    const value = String(text || '').toLowerCase();
    const groups = [
      ['action', '动作', '战斗'],
      ['fantasy', '奇幻', '异世界'],
      ['adventure', '冒险'],
      ['slice of life', 'iyashikei', '治愈', '日常'],
      ['romance', '恋爱', '爱情'],
      ['mystery', '悬疑', '推理'],
      ['comedy', '喜剧', '搞笑']
    ];
    const vector = groups.map(words => words.some(word => value.includes(word)) ? 1 : 0);
    vector.push(0.05);
    return normalizeVector(vector);
  }

  async embedDocuments(texts) {
    this.calls += texts.length;
    return texts.map(text => this.vector(text));
  }

  async embedQuery(text) {
    this.calls += 1;
    return this.vector(text);
  }
}

function parseGenres(row) {
  try { return JSON.parse(row.genres || '[]'); } catch (_) { return []; }
}

async function main() {
  await testDatabase.initialize(database);

  const longText = '这是第一段。'.repeat(140);
  const pieces = splitLongText(longText);
  assert.ok(pieces.length >= 2, 'long synopsis should be chunked');
  assert.ok(pieces.every(piece => piece.length <= 500), 'chunks should not exceed 500 chars');
  assert.ok(pieces.slice(0, -1).every(piece => piece.length >= 300), 'non-final chunks should normally reach 300 chars');

  const rows = database.getAnimeMetaForRag(0, 1000);
  const fantasy = rows.find(row => parseGenres(row).includes('Fantasy') && row.oi_msg);
  const action = rows.find(row => {
    const genres = parseGenres(row);
    return genres.includes('Action') && !genres.includes('Fantasy') && row.oi_msg && row.anilist_id !== fantasy?.anilist_id;
  });
  assert.ok(fantasy && action, 'fixture database should contain fantasy and action anime');

  const metaChunks = buildAnimeMetaChunks(fantasy);
  assert.ok(metaChunks.some(chunk => chunk.chunkType === 'metadata'));
  assert.ok(metaChunks.some(chunk => /Fantasy|奇幻/.test(chunk.chunkText)));
  const detailChunks = buildAnimeDetailChunks({
    anilistId: fantasy.anilist_id,
    title: fantasy.title_chinese || fantasy.title_romaji,
    description: longText,
    studios: ['Test Studio'],
    staff: [{ name: '测试监督', role: 'Director' }],
    characters: [{ name: '测试角色', role: 'MAIN', voiceActor: '测试声优' }]
  });
  assert.ok(detailChunks.some(chunk => chunk.chunkType === 'synopsis'));
  assert.ok(detailChunks.some(chunk => chunk.chunkType === 'staff'));
  assert.ok(detailChunks.some(chunk => chunk.chunkType === 'characters'));
  assert.strictEqual(buildWebChunks([{ title: '官方消息', url: 'https://example.com/a', content: longText, trustScore: 90 }])[0].sourceType, 'web');

  const blob = vectorToBlob([0.25, -0.5, 1]);
  assert.deepStrictEqual(Array.from(blobToVector(blob, 3), value => Number(value.toFixed(2))), [0.25, -0.5, 1]);
  assert.ok(cosineSimilarity([1, 0], [1, 0]) > 0.999);
  assert.strictEqual(Number(hybridScore(1, 1, 100).toFixed(2)), 1);
  assert.match(rewriteRetrievalQuery('帮我推荐一部治愈系校园番'), /治愈|Iyashikei/);

  database.clearRagIndex();
  const embedding = new FakeEmbeddingProvider();
  const rag = new RagService(database, {
    embeddingProvider: embedding,
    webSearch: async () => ({ configured: false, results: [] }),
    config: {
      enabled: true,
      candidateK: 12,
      finalK: 6,
      minScore: 0.35,
      autoIndex: false,
      autoIndexBatch: 10,
      externalTtlDays: 30
    }
  });
  const indexed = await rag.indexAnimeRows([fantasy, action]);
  assert.strictEqual(indexed.anime, 2);
  assert.ok(indexed.embedded >= 2);
  const callsAfterFirstIndex = embedding.calls;
  const repeated = await rag.indexAnimeRows([fantasy, action]);
  assert.strictEqual(repeated.embedded, 0, 'unchanged chunks must reuse stored embeddings');
  assert.ok(repeated.reused >= 2);
  assert.strictEqual(embedding.calls, callsAfterFirstIndex, 'incremental indexing must not call embedding for unchanged chunks');

  const semantic = await rag.retrieve('想看奇幻异世界作品', { allowWebFallback: false });
  assert.strictEqual(semantic.mode, 'hybrid');
  assert.strictEqual(semantic.lowConfidence, false);
  assert.strictEqual(semantic.results[0].anilistId, Number(fantasy.anilist_id));
  assert.ok(semantic.results[0].vectorScore > 0.5);
  assert.ok(semantic.results.length <= 6);

  const webRag = new RagService(database, {
    embeddingProvider: embedding,
    webSearch: async () => ({
      configured: true,
      results: [{
        title: '官方续作消息',
        url: 'https://example.com/official-news',
        content: '官方续作消息已经公开，具体日期以制作委员会公告为准。',
        trustScore: 95,
        publishedDate: '2026-07-15'
      }]
    }),
    config: { ...rag.config, minScore: 0.9 }
  });
  const external = await webRag.retrieve('官方续作消息', { allowWebFallback: true });
  assert.strictEqual(external.externalUsed, true);
  assert.strictEqual(external.lowConfidence, false);
  assert.strictEqual(external.sources[0].url, 'https://example.com/official-news');

  const exactTitle = fantasy.title_chinese || fantasy.title_romaji || fantasy.title_native;
  const exact = await rag.searchAnime(exactTitle, 12);
  assert.ok(exact.rows.some(row => Number(row.anilist_id) === Number(fantasy.anilist_id)));

  const noEmbedding = new RagService(database, {
    embeddingProvider: { model: '', isConfigured: () => false, config: () => ({ configured: false }) },
    config: { ...rag.config, enabled: true }
  });
  const fallback = await noEmbedding.retrieve(exactTitle);
  assert.strictEqual(fallback.mode, 'fts');
  assert.ok(fallback.exactRows.length > 0);

  const unavailableEmbedding = new RagService(database, {
    embeddingProvider: {
      model: embedding.model,
      isConfigured: () => true,
      config: () => ({ configured: true, model: embedding.model }),
      async embedQuery() { throw new Error('temporary embedding outage'); }
    },
    config: { ...rag.config, enabled: true }
  });
  const degraded = await unavailableEmbedding.retrieve(exactTitle);
  assert.strictEqual(degraded.mode, 'fts');
  assert.strictEqual(degraded.degraded, true);
  assert.ok(degraded.exactRows.length > 0);

  const stats = database.getRagIndexStats();
  assert.ok(stats.groups.some(group => group.embedding_model === embedding.model));
  console.log('[rag-regression] all checks passed');
}

main().then(() => process.exit(0)).catch(error => {
  console.error('[rag-regression] failed:', error);
  process.exit(1);
}).finally(() => {
  testDatabase.cleanup();
});
