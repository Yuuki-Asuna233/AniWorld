#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { loadEnvFile } = require('../../apps/server/src/utils/env');
const { CATALOG_FIELDS, normalizeRecord } = require('../../apps/server/src/database/catalog-seed');
const root = path.resolve(__dirname, '../..');
loadEnvFile(path.join(root, '.env'));

async function main() {
  if (process.argv.length > 3) throw new Error('用法：npm run data:export -- [输出JSON文件]');
  const dbPath = process.env.ANIME_DB_PATH ? path.resolve(process.env.ANIME_DB_PATH) : path.join(root, 'data/runtime/anime_user.db');
  const output = path.resolve(process.argv[2] || path.join(root, 'data/seed/anime-meta.v1.json'));
  if (path.extname(output).toLowerCase() !== '.json') throw new Error('输出文件必须使用 .json 扩展名');
  const SQL = await initSqlJs();
  // Read the last persisted snapshot. No initialization, migration or writes
  // to the live database; SELECT never includes any other table or column.
  const db = new SQL.Database(fs.readFileSync(dbPath));
  try {
    const rows = db.exec(`SELECT ${CATALOG_FIELDS.join(', ')} FROM anime_meta ORDER BY anilist_id`)[0];
    const records = (rows?.values || []).map(values => normalizeRecord(Object.fromEntries(rows.columns.map((field, i) => [field, values[i]]))));
    if (!records.length) throw new Error('数据库没有番剧资料');
    const payload = { format: 'aniworld-anime-meta', version: 1, exportedAt: new Date().toISOString(), recordCount: records.length, records };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(payload, null, 2) + '\n');
    console.log(`[catalog] 已导出 ${records.length} 条番剧资料：${output}`);
  } finally { db.close(); }
}

main().catch(error => { console.error(`[catalog] 导出失败：${error.message}`); process.exitCode = 1; });
