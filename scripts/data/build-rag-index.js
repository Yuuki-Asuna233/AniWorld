const path = require('path');

const args = process.argv.slice(2);
function has(flag) { return args.includes(flag); }
function value(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const { loadEnvFile } = require('../../apps/server/src/utils/env');
loadEnvFile(path.join(__dirname, '..', '..', '.env'));

const database = require('../../apps/server/database');
const { getRagService } = require('../../baiyu_agent/retrieval/rag-service');
const { fetchAniListRagDetails } = require('../../baiyu_agent/retrieval/anilist-rag-source');

async function main() {
  await database.initDatabase();
  const rag = getRagService(database);

  if (has('--status')) {
    console.log(JSON.stringify(rag.status(), null, 2));
    return;
  }
  if (!rag.isConfigured()) {
    throw new Error(
      'Embedding 未配置。请在 .env 设置 EMBEDDING_BASE_URL、EMBEDDING_MODEL（推荐 bge-m3）以及需要时的 EMBEDDING_API_KEY。'
    );
  }
  if (has('--rebuild')) {
    const result = database.clearRagIndex(rag.indexKey);
    if (result.error) throw new Error(result.error);
    console.log(`[RAG] Cleared index for ${rag.embedding.model}`);
  }

  const pageSize = Math.max(1, Math.min(Number(value('--batch-size', 32)) || 32, 128));
  const maxAnime = Math.max(0, Number(value('--max-anime', 0)) || 0);
  const enrich = !has('--metadata-only');
  const started = Date.now();
  const result = await rag.indexAll({
    pageSize,
    maxAnime,
    enrich,
    detailLoader: enrich ? fetchAniListRagDetails : null,
    onProgress(progress) {
      console.log(
        `[RAG] anime=${progress.processed} details=${progress.detailAnime} chunks=${progress.chunks} embedded=${progress.embedded} reused=${progress.reused}`
      );
    }
  });
  console.log(JSON.stringify({
    success: true,
    model: rag.embedding.model,
    enrich,
    elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    ...result,
    status: rag.status().index
  }, null, 2));
}

main().catch(error => {
  console.error('[RAG] Index build failed:', error.message);
  process.exitCode = 1;
});
