const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DATASET_PATH = path.join(
  PROJECT_ROOT,
  'data',
  'datasets',
  'anime_meta_final_simplified_cn_complete_checked.json',
);

function configureTestDatabase(name) {
  const databasePath = path.join(
    os.tmpdir(),
    `aniworld-${name}-${process.pid}-${Date.now()}.db`,
  );
  process.env.ANIME_DB_PATH = databasePath;

  const cleanup = () => {
    try { fs.unlinkSync(databasePath); } catch (_) {}
    try { fs.unlinkSync(`${databasePath}.tmp`); } catch (_) {}
  };

  async function initialize(database) {
    await database.initDatabase();
    const rows = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8')).map((row) => {
      if (/葬送的芙莉莲 第二季/.test(row.title_chinese || '')) {
        return { ...row, oi_msg: row.oi_msg || row.title_chinese, oi_index: 1 };
      }
      return row;
    });
    database.upsertAnimeMetaBatch(rows);
    return rows;
  }

  return { databasePath, initialize, cleanup };
}

module.exports = { configureTestDatabase };
