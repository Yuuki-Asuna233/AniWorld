const { buildAnimeMetaChunks } = require('./rag-chunker');

function entityKnowledge(database, indexKey, anilistId, query, limit, lexicalScore) {
  const meta = database.getAnimeMetaById(anilistId);
  const stored = ['anilist_detail', 'anime_meta'].flatMap(type =>
    database.getRagChunksByAnime(anilistId, type, indexKey));
  const chunks = stored.length ? stored.map(row => ({ id: row.id, anilistId: Number(row.anilist_id),
    chunkType: row.chunk_type, chunkText: row.chunk_text, sourceType: row.source_type,
    sourceUrl: row.source_url, sourceTitle: row.source_title, trustScore: Number(row.trust_score),
    publishedAt: row.published_at })) : meta ? buildAnimeMetaChunks(meta) : [];
  if (!chunks.length) return null;
  const ranked = chunks.map(chunk => {
    const keywordScore = lexicalScore(query, chunk.chunkText);
    return { ...chunk, keywordScore, vectorScore: 0, score: keywordScore, matchType: 'entity' };
  }).sort((a, b) => b.score - a.score || Number(b.trustScore) - Number(a.trustScore));
  const results = ranked.slice(0, limit);
  return { indexed: stored.length > 0, mode: 'entity', query,
    lowConfidence: false, partial: results.length < chunks.length || !stored.some(row => row.source_type === 'anilist_detail'),
    degraded: false, externalUsed: false, externalAttempted: false, scanned: chunks.length, candidateCount: chunks.length,
    results, exactRows: meta ? [meta] : [],
    sources: [...new Map(results.filter(item => item.sourceUrl).map(item => [item.sourceUrl, {
      title: item.sourceTitle, url: item.sourceUrl, trustScore: item.trustScore,
      publishedDate: item.publishedAt || '', sourceType: item.sourceType
    }])).values()] };
}

module.exports = { entityKnowledge };
