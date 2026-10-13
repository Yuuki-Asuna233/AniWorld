#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { loadEnvFile } = require('../../apps/server/src/utils/env');
const { readCatalogSeed } = require('../../apps/server/src/database/catalog-seed');
const root = path.resolve(__dirname, '../..');
loadEnvFile(path.join(root, '.env'));
const database = require('../../apps/server/database');

async function main() {
  if (process.argv.length > 3) throw new Error('用法：npm run data:import -- [目录JSON文件]');
  const file = path.resolve(process.argv[2] || path.join(root, 'data/seed/anime-meta.v1.json'));
  if (fs.statSync(file).size > 64 * 1024 * 1024) throw new Error('目录文件超过 64 MB');
  // Validate the entire input before acquiring the database or writing rows.
  const text = fs.readFileSync(file, 'utf8');
  const records = readCatalogSeed(JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text));
  let initialized = false;
  try {
    await database.initDatabase();
    initialized = true;
    const dbPath = process.env.ANIME_DB_PATH
      ? path.resolve(process.env.ANIME_DB_PATH)
      : path.join(root, 'data/runtime/anime_user.db');
    const backup = `${dbPath}.before-catalog-import-${Date.now()}.bak`;
    fs.copyFileSync(dbPath, backup, fs.constants.COPYFILE_EXCL);
    const result = database.importAnimeCatalog(records);
    if (result.error) throw new Error(result.error);
    console.log(`[catalog] 新增 ${result.inserted}，补齐 ${result.updated}，保留 ${result.unchanged}，目录总数 ${database.getAnimeMetaCount()}`);
    console.log(`[catalog] 导入前备份：${backup}`);
    console.log('[catalog] 导入完成。现在可以运行 npm start，再刷新客户端。');
  } finally {
    if (initialized) database.closeDatabase();
  }
}

main().catch(error => { console.error(`[catalog] 导入失败：${error.message}`); process.exitCode = 1; });
