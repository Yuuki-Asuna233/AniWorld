// ==================== SQLite Database Module ====================
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { initializeSchema } = require('./src/database/schema');
const { initializeAgentContextSchema, createAgentContextRepository } = require('./src/database/agent-context');
const { resolveAnimeKey, rememberAnimeAlias, progressFields, migrateUserAnimeState, animeKeyPredicate, uniqueAnimeRows } = require('./src/database/user-anime-state');
const { DatabaseFileStore } = require('./src/database/file-store');
const { RagFileStore } = require('./src/database/rag-store');
const { createAuthenticationRepository } = require('./src/database/authentication');
const { createCatalogSearchRepository } = require('./src/database/catalog-search');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const DB_PATH = process.env.ANIME_DB_PATH
  ? path.resolve(process.env.ANIME_DB_PATH)
  : path.join(PROJECT_ROOT, 'data', 'runtime', 'anime_user.db');
const FINISHED_ARC_OVERRIDES = {
  189046: { episodes: 11 }
};

let db = null;
let corpusDb = null;
let ragStore = null;
let saveTimer = null;
let suppressSave = false;
let searchIndexReady = false;
let ragIndexVersion = 0;
const fileStore = new DatabaseFileStore(DB_PATH);
let dirty = false;
let exitHookInstalled = false;

function applyAnimeMetaOverrides(meta) {
  const override = FINISHED_ARC_OVERRIDES[Number(meta?.anilist_id)];
  if (!override) return meta;
  return {
    ...meta,
    episodes: override.episodes,
    status: 'FINISHED',
    next_airing_episode: 0,
    next_airing_at: 0
  };
}

// Initialize database (call once at server start)
async function initDatabase() {
  const SQL = await initSqlJs();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fileStore.acquire();
  if (!exitHookInstalled) {
    process.once('exit', () => {
      try { closeDatabase(); }
      catch (error) { console.error('[DB] Exit flush failed:', error.message); process.exitCode = 1; }
    });
    exitHookInstalled = true;
  }

  if (fs.existsSync(DB_PATH)) {
    const backupPath = DB_PATH + '.before-canonical.bak';
    if (!fs.existsSync(backupPath)) fs.copyFileSync(DB_PATH, backupPath, fs.constants.COPYFILE_EXCL);
    const contextBackupPath = DB_PATH + '.before-agent-context-v2.bak';
    if (!fs.existsSync(contextBackupPath)) fs.copyFileSync(DB_PATH, contextBackupPath, fs.constants.COPYFILE_EXCL);
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  initializeSchema(db);
  initializeAgentContextSchema(db);
  migrateUserAnimeState(db);

  const splitCorpus = String(process.env.ANIME_RAG_SEPARATE_STORE || '').toLowerCase() === 'true'
    || Boolean(db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_storage'").length
      && db.exec("SELECT value FROM app_storage WHERE name = 'rag_store_id'")[0]?.values.length);
  if (splitCorpus) {
    ragStore = new RagFileStore(`${fileStore.filename}.rag.db`);
    ragStore.initialize(SQL, db, fileStore.filename);
    corpusDb = ragStore.db;
  } else corpusDb = db;

  initAnimeSearchIndex();
  backfillStartDateKeys();

  saveToFile();
  console.log('[DB] Database initialized successfully');
  return db;
}

function saveToFile() {
  if (!db) return;
  dirty = true;
  try {
    ragStore?.flush(); // Corpus must be durable before its main-database queue acknowledgement.
    fileStore.write(Buffer.from(db.export()));
    dirty = false;
    cancelPendingSave();
  } finally {
    // sql.js export reopens the database connection and resets connection pragmas.
    db.run('PRAGMA foreign_keys=ON');
    if (dirty) scheduleSave();
  }
}

function flushDatabase() {
  ragStore?.flush();
  if (dirty) saveToFile();
}

function closeDatabase() {
  cancelPendingSave();
  try { flushDatabase(); }
  finally {
    try { ragStore?.close(); }
    finally {
      ragStore = null; corpusDb = null;
      if (db) { db.close(); db = null; }
      fileStore.release();
    }
  }
}

function scheduleCorpusSave() {
  ragStore?.markDirty();
  scheduleSave();
}

// A fixed window from the first write avoids starvation under sustained traffic.
function scheduleSave() {
  dirty = true;
  if (suppressSave) return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { flushDatabase(); }
    catch (error) {
      console.error('[DB] Persistence failed:', error.message);
      scheduleSave();
    }
  }, 2000);
  saveTimer.unref();
}

function initAnimeSearchIndex() {
  try {
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS anime_meta_fts
      USING fts4(anilist_id, title_chinese, title_romaji, title_native)
    `);
    rebuildAnimeSearchIndex();
    searchIndexReady = true;
  } catch (e) {
    searchIndexReady = false;
    console.warn('[DB] FTS search index unavailable, falling back to LIKE search:', e.message);
  }
}

function rebuildAnimeSearchIndex() {
  db.run('DELETE FROM anime_meta_fts');
  db.run(`
    INSERT INTO anime_meta_fts(docid, anilist_id, title_chinese, title_romaji, title_native)
    SELECT anilist_id, anilist_id, title_chinese, title_romaji, title_native
    FROM anime_meta
    WHERE country_of_origin = 'JP' AND oi_msg != ''
  `);
}

function syncAnimeSearchRow(meta) {
  if (!searchIndexReady || !meta || !meta.anilist_id) return;
  try {
    db.run('DELETE FROM anime_meta_fts WHERE docid = ?', [meta.anilist_id]);
    if ((meta.country_of_origin || '') === 'JP' && (meta.oi_msg || '') !== '') {
      db.run(
        `INSERT INTO anime_meta_fts(docid, anilist_id, title_chinese, title_romaji, title_native)
         VALUES (?, ?, ?, ?, ?)`,
        [
          meta.anilist_id,
          meta.anilist_id,
          meta.title_chinese || '',
          meta.title_romaji || '',
          meta.title_native || ''
        ]
      );
    }
  } catch (e) {
    console.warn('[DB] syncAnimeSearchRow failed:', e.message);
  }
}

function syncAnimeSearchById(anilistId) {
  if (!searchIndexReady || !anilistId) return;
  const rows = db.exec(
    `SELECT anilist_id, title_chinese, title_romaji, title_native, country_of_origin, oi_msg
     FROM anime_meta WHERE anilist_id = ?`,
    [anilistId]
  );
  if (rows.length > 0 && rows[0].values.length > 0) {
    syncAnimeSearchRow(rowToObj(rows[0].columns, rows[0].values[0]));
  }
}

function cancelPendingSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

// Populate start_date_key for rows written before the column existed (and for
// anything a manual edit left behind). Guarded so a normal startup only scans
// for rows that still need it.
function backfillStartDateKeys() {
  try {
    const pending = db.exec(
      `SELECT anilist_id, start_date, season_year FROM anime_meta
       WHERE start_date_key IS NULL OR start_date_key = 0`
    );
    if (!pending.length || !pending[0].values.length) return;
    const rows = pending[0].values.map(value => rowToObj(pending[0].columns, value));
    db.run('BEGIN TRANSACTION');
    for (const row of rows) {
      db.run('UPDATE anime_meta SET start_date_key = ? WHERE anilist_id = ?', [
        animeStartDateValue(row),
        row.anilist_id
      ]);
    }
    db.run('COMMIT');
    console.log(`[DB] start_date_key backfilled for ${rows.length} rows`);
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (_) {}
    console.warn('[DB] start_date_key backfill failed:', e.message);
  }
}

function buildFtsQuery(title) {
  const tokens = String(title || '')
    .trim()
    .split(/[\s"'.,:;!?()[\]{}<>|/\\，。！？、；：（）【】《》「」『』]+/)
    .map(t => t.trim())
    .filter(Boolean)
    .map(t => t.replace(/[^\w\u3040-\u30ff\u3400-\u9fff]/g, ''))
    .filter(t => t.length > 0)
    .slice(0, 6);
  if (tokens.length === 0) return '';
  return tokens.map(t => (/[A-Za-z0-9]/.test(t) ? `${t}*` : t)).join(' OR ');
}

// ==================== User Operations ====================

function getLastInsertId() {
  const result = db.exec('SELECT last_insert_rowid()');
  if (result.length > 0 && result[0].values.length > 0) {
    return result[0].values[0][0];
  }
  return 0;
}

function createUser(email, username, passwordHash, avatar = '') {
  try {
    db.run(
      'INSERT INTO users (email, username, password_hash, avatar) VALUES (?, ?, ?, ?)',
      [email.toLowerCase().trim(), username.trim(), passwordHash, avatar]
    );
    const id = getLastInsertId();
    if (id) {
      scheduleSave();
      return getUserById(id);
    }
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return { error: '该邮箱已被注册' };
    }
    console.error('[DB] createUser error:', e.message);
  }
  return null;
}

function getUserByEmail(email) {
  try {
    const rows = db.exec(`SELECT * FROM users WHERE email = ?`, [email.toLowerCase().trim()]);
    if (rows.length > 0 && rows[0].values.length > 0) {
      return rowToUser(rows[0].values[0], rows[0].columns);
    }
  } catch (e) {
    console.error('[DB] getUserByEmail error:', e.message);
  }
  return null;
}

function getUserById(id) {
  try {
    const rows = db.exec(`SELECT * FROM users WHERE id = ?`, [id]);
    if (rows.length > 0 && rows[0].values.length > 0) {
      return rowToUser(rows[0].values[0], rows[0].columns);
    }
  } catch (e) {
    console.error('[DB] getUserById error:', e.message);
  }
  return null;
}

function updateUserProfile(id, updates) {
  try {
    const fields = [];
    const values = [];
    if (updates.email !== undefined) {
      fields.push('email = ?');
      values.push(updates.email.trim().toLowerCase());
    }
    if (updates.username !== undefined) {
      fields.push('username = ?');
      values.push(updates.username.trim());
    }
    if (updates.avatar !== undefined) {
      fields.push('avatar = ?');
      values.push(updates.avatar);
    }
    if (fields.length === 0) return getUserById(id);

    values.push(id);
    db.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
    scheduleSave();
    return getUserById(id);
  } catch (e) {
    console.error('[DB] updateUserProfile error:', e.message);
  }
  return null;
}

function updatePassword(id, newHash) {
  try {
    db.run('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [newHash, id]);
    scheduleSave();
    return true;
  } catch (e) {
    console.error('[DB] updatePassword error:', e.message);
    return false;
  }
}

function rowToUser(values, columns) {
  const user = {};
  columns.forEach((col, i) => { user[col] = values[i]; });
  return user;
}

// ==================== Email Verification ====================

function saveVerificationCode(email, code, expiresAt) {
  try {
    db.run(
      'INSERT INTO email_verifications (email, code, expires_at) VALUES (?, ?, ?)',
      [email.toLowerCase().trim(), code, expiresAt]
    );
    scheduleSave();
    return true;
  } catch (e) {
    console.error('[DB] saveVerificationCode error:', e.message);
  }
  return false;
}

// Clean expired verification codes periodically
function cleanExpiredVerifications() {
  try {
    const now = Math.floor(Date.now() / 1000);
    db.run('DELETE FROM email_verifications WHERE expires_at < ?', [now]);
    scheduleSave();
  } catch (e) {}
}

// ==================== Favorites ====================

function getFavorites(userId) {
  try {
    const rows = db.exec(
      'SELECT * FROM favorites WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    if (rows.length > 0 && rows[0].values.length > 0) {
      return uniqueAnimeRows(db, userId, rows[0].values.map(v => rowToObj(rows[0].columns, v)));
    }
  } catch (e) {
    console.error('[DB] getFavorites error:', e.message);
  }
  return [];
}

function addFavorite(userId, anime) {
  try {
    const identity = resolveAnimeKey(db, userId, anime);
    rememberAnimeAlias(db, userId, anime, identity);
    anime = { ...anime, ...identity };
    const existing = db.exec(
      `SELECT id, anime_id FROM favorites WHERE user_id = ? AND ${animeKeyPredicate}
       ORDER BY (anime_id = ?) DESC, id DESC LIMIT 1`,
      [userId, anime.anime_id, userId, anime.anime_id, anime.anime_id]
    );
    if (existing.length > 0 && existing[0].values.length > 0) {
      db.run('UPDATE favorites SET anime_id = ?, anilist_id = ? WHERE id = ?',
        [anime.anime_id, anime.anilist_id, existing[0].values[0][0]]);
      scheduleSave();
      return { already: true };
    }
    db.run(
      'INSERT INTO favorites (user_id, anilist_id, anime_id, anime_title, anime_image, anime_msg, anime_n, oi_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, Number(anime.anilist_id) || 0, anime.anime_id, anime.anime_title, anime.anime_image || '', anime.anime_msg || '', anime.anime_n || 1, anime.oi_index || 1]
    );
    scheduleSave();
    return { success: true };
  } catch (e) {
    console.error('[DB] addFavorite error:', e.message);
  }
  return { error: '添加失败' };
}

function removeFavorite(userId, animeId) {
  try {
    animeId = resolveAnimeKey(db, userId, animeId).anime_id;
    db.run(`DELETE FROM favorites WHERE user_id = ? AND ${animeKeyPredicate}`, [userId, animeId, userId, animeId]);
    scheduleSave();
    return { success: true };
  } catch (e) {
    console.error('[DB] removeFavorite error:', e.message);
  }
  return { error: '删除失败' };
}

function isFavorited(userId, animeId) {
  try {
    animeId = resolveAnimeKey(db, userId, animeId).anime_id;
    const rows = db.exec(
      `SELECT id FROM favorites WHERE user_id = ? AND ${animeKeyPredicate}`,
      [userId, animeId, userId, animeId]
    );
    return rows.length > 0 && rows[0].values.length > 0;
  } catch (e) {}
  return false;
}

// ==================== Watch History ====================

function getAgentUserLibrary(userId, { list, anilistId, offset = 0, limit = 12 }) {
  if (!userId || !['favorites', 'history'].includes(list)) throw new Error('USER_LIBRARY_SCOPE_INVALID');
  const table = list === 'favorites' ? 'favorites' : 'watch_history';
  const order = list === 'favorites' ? 'created_at DESC, id DESC' : 'updated_at DESC, id DESC';
  const where = 'user_id = ?' + (anilistId ? ' AND (anilist_id = ? OR anime_id = ?)' : '');
  const params = anilistId ? [userId, anilistId, `anilist_${anilistId}`] : [userId];
  const count = db.exec(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, params);
  const total = Number(count[0]?.values[0]?.[0]) || 0;
  const result = db.exec(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const rows = result[0]?.values.map(row => rowToObj(result[0].columns, row)) || [];
  return { rows, total, nextOffset: offset + rows.length < total ? offset + rows.length : null };
}

function getHistory(userId, limit = 50) {
  try {
    const rows = db.exec(
      'SELECT * FROM watch_history WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?',
      [userId, Math.max(1, Math.min(500, Number(limit) || 50))]
    );
    if (rows.length > 0 && rows[0].values.length > 0) {
      return uniqueAnimeRows(db, userId, rows[0].values.map(v => rowToObj(rows[0].columns, v)));
    }
  } catch (e) {
    console.error('[DB] getHistory error:', e.message);
  }
  return [];
}

function saveHistory(userId, record) {
  try {
    const identity = resolveAnimeKey(db, userId, record);
    rememberAnimeAlias(db, userId, record, identity);
    record = { ...record, ...identity };
    // Upsert by (user_id, anime_id): one row per anime, always update to latest episode
    const existing = db.exec(
      `SELECT id,episode_number,duration_seconds FROM watch_history WHERE user_id = ? AND ${animeKeyPredicate}
       ORDER BY (anime_id = ?) DESC, updated_at DESC, id DESC LIMIT 1`,
      [userId, record.anime_id, userId, record.anime_id, record.anime_id]
    );

    const previous = existing[0]?.values[0] ? rowToObj(existing[0].columns, existing[0].values[0]) : null;
    record = { ...record, ...progressFields(record, previous) };
    const now = Math.floor(Date.now() / 1000);
    if (existing.length > 0 && existing[0].values.length > 0) {
      // Bug fix: also update episode_number!
      db.run(
        `UPDATE watch_history SET
         anime_id = ?, anilist_id = ?, anime_title = ?, anime_image = ?, anime_msg = ?, anime_n = ?,
         episode_number = ?, episode_title = ?, progress = ?, position_seconds = ?, duration_seconds = ?, video_url = ?, updated_at = ?
         WHERE id = ?`,
        [record.anime_id, Number(record.anilist_id) || 0, record.anime_title, record.anime_image || '', record.anime_msg || '', record.anime_n || 1,
         record.episode_number || '',
         record.episode_title || '', record.progress, record.position_seconds, record.duration_seconds, record.video_url || '', now,
         existing[0].values[0][0]]
      );
    } else {
      db.run(
        `INSERT INTO watch_history
         (user_id, anilist_id, anime_id, anime_title, anime_image, anime_msg, anime_n, episode_number, episode_title, progress, position_seconds, duration_seconds, video_url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, Number(record.anilist_id) || 0, record.anime_id, record.anime_title, record.anime_image || '',
         record.anime_msg || '', record.anime_n || 1, record.episode_number,
         record.episode_title || '', record.progress, record.position_seconds, record.duration_seconds, record.video_url || '', now]
      );
    }
    scheduleSave();
    return { success: true };
  } catch (e) {
    console.error('[DB] saveHistory error:', e.message);
  }
  return { error: '保存失败' };
}

function getHistoryProgress(userId, animeId) {
  try {
    animeId = resolveAnimeKey(db, userId, animeId).anime_id;
    const rows = db.exec(
      `SELECT * FROM watch_history WHERE user_id = ? AND ${animeKeyPredicate}
       ORDER BY updated_at DESC, (anime_id = ?) DESC, id DESC LIMIT 1`,
      [userId, animeId, userId, animeId, animeId]
    );
    if (rows.length > 0 && rows[0].values.length > 0) {
      return uniqueAnimeRows(db, userId, [rowToObj(rows[0].columns, rows[0].values[0])])[0];
    }
  } catch (e) {
    console.error('[DB] getHistoryProgress error:', e.message);
  }
  return null;
}

function removeHistory(userId, animeId, { deferSave = false } = {}) {
  try {
    animeId = resolveAnimeKey(db, userId, animeId).anime_id;
    cancelPendingSave();
    db.run(`DELETE FROM watch_history WHERE user_id = ? AND ${animeKeyPredicate}`, [userId, animeId, userId, animeId]);
    if (deferSave) scheduleSave();
    else saveToFile();
    return { success: true };
  } catch (e) {
    console.error('[DB] removeHistory error:', e.message);
    return { error: '删除失败: ' + e.message };
  }
}

// ==================== Helpers ====================

function rowToObj(columns, values) {
  const obj = {};
  columns.forEach((col, i) => { obj[col] = values[i]; });
  return obj;
}

// Periodic cleanup (every 5 minutes)
setInterval(cleanExpiredVerifications, 5 * 60 * 1000).unref();

// ==================== Clear All Data ====================
function clearHistory(userId) {
  try {
    // Cancel pending debounce to prevent stale data overwriting our clear
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }

    db.run('DELETE FROM watch_history WHERE user_id = ?', [userId]);

    const after = db.exec('SELECT COUNT(*) as cnt FROM watch_history WHERE user_id = ?', [userId]);
    const afterCount = (after.length > 0 && after[0].values.length > 0) ? after[0].values[0][0] : 0;

    if (afterCount > 0) {
      return { error: '清空失败: 删除后仍有记录残留' };
    }

    saveToFile();
    return { success: true };
  } catch (e) {
    console.error('[DB] clearHistory error:', e.message);
    return { error: '清空失败: ' + e.message };
  }
}

function clearFavorites(userId) {
  try {
    // Cancel pending debounce to prevent stale data overwriting our clear
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }

    db.run('DELETE FROM favorites WHERE user_id = ?', [userId]);

    const after = db.exec('SELECT COUNT(*) as cnt FROM favorites WHERE user_id = ?', [userId]);
    const afterCount = (after.length > 0 && after[0].values.length > 0) ? after[0].values[0][0] : 0;

    if (afterCount > 0) {
      return { error: '清空失败: 删除后仍有记录残留' };
    }

    saveToFile();
    return { success: true };
  } catch (e) {
    console.error('[DB] clearFavorites error:', e.message);
    return { error: '清空失败: ' + e.message };
  }
}

// ==================== Anime Meta Operations ====================

function upsertAnimeMeta(meta) {
  if (!meta || !meta.anilist_id) return null;
  meta = applyAnimeMetaOverrides(meta);
  try {
    const now = Math.floor(Date.now() / 1000);
    const existing = db.exec(
      `SELECT content_tags, title_chinese, oi_msg, oi_index, episodes, status,
              next_airing_episode, next_airing_at
       FROM anime_meta WHERE anilist_id = ?`,
      [meta.anilist_id]
    );
    const exists = existing.length > 0 && existing[0].values.length > 0;
    const existingRow = exists ? rowToObj(existing[0].columns, existing[0].values[0]) : {};
    if (exists) {
      // title_chinese, oi_msg, oi_index 永不自动更新，只由用户手动维护
      db.run(`
        UPDATE anime_meta SET
          title_romaji = ?, title_native = ?,
          cover_image = ?, average_score = ?, popularity = ?,
          episodes = ?, status = ?, format = ?, genres = ?,
          season = ?, season_year = ?, start_date = ?, start_date_key = ?,
          next_airing_episode = ?, next_airing_at = ?,
          country_of_origin = ?,
          content_tags = ?,
          last_updated = ?
        WHERE anilist_id = ?
      `, [
        meta.title_romaji || '', meta.title_native || '',
        meta.cover_image || '', meta.average_score || 0, meta.popularity || 0,
        meta.episodes || 0, meta.status || '', meta.format || '', meta.genres || '',
        meta.season || '', meta.season_year || 0, meta.start_date || '',
        animeStartDateValue(meta),
        meta.next_airing_episode || 0, meta.next_airing_at || 0,
        meta.country_of_origin || '',
        meta.content_tags !== undefined ? (meta.content_tags || '') : (existingRow.content_tags || ''),
        now, meta.anilist_id
      ]);
    } else {
      db.run(`
        INSERT INTO anime_meta
          (anilist_id, title_romaji, title_native, title_chinese,
           cover_image, average_score, popularity,
           episodes, status, format, genres,
           season, season_year, start_date, start_date_key,
           next_airing_episode, next_airing_at,
           oi_msg, oi_index, country_of_origin, content_tags, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        meta.anilist_id,
        meta.title_romaji || '', meta.title_native || '', meta.title_chinese || '',
        meta.cover_image || '', meta.average_score || 0, meta.popularity || 0,
        meta.episodes || 0, meta.status || '', meta.format || '', meta.genres || '',
        meta.season || '', meta.season_year || 0, meta.start_date || '',
        animeStartDateValue(meta),
        meta.next_airing_episode || 0, meta.next_airing_at || 0,
        meta.oi_msg || '', meta.oi_index || 1,
        meta.country_of_origin || '',
        meta.content_tags || '',
        now
      ]);
    }
    queueAnimeForRag(meta.anilist_id, now);
    if (!suppressSave) syncAnimeSearchById(meta.anilist_id);
    scheduleSave();
    return { success: true };
  } catch (e) {
    console.error('[DB] upsertAnimeMeta error:', e.message);
    return { error: e.message };
  }
}

function upsertAnimeMetaBatch(metaList) {
  if (!metaList || metaList.length === 0) return { success: true, count: 0 };
  let count = 0;
  try {
    suppressSave = true;
    cancelPendingSave();
    db.run('BEGIN TRANSACTION');
    for (const meta of metaList) {
      const r = upsertAnimeMeta(meta);
      if (r && r.success) count++;
    }
    db.run('COMMIT');
    suppressSave = false;
    if (searchIndexReady) rebuildAnimeSearchIndex();
    saveToFile();
  } catch (e) {
    suppressSave = false;
    console.error('[DB] upsertAnimeMetaBatch error:', e.message);
    try { db.run('ROLLBACK'); } catch (_) {}
    return { error: e.message };
  }
  return { success: true, count };
}

function getAnimeMetaById(anilistId) {
  try {
    const rows = db.exec('SELECT * FROM anime_meta WHERE anilist_id = ?', [anilistId]);
    if (rows.length > 0 && rows[0].values.length > 0) {
      return rowToObj(rows[0].columns, rows[0].values[0]);
    }
  } catch (e) {
    console.error('[DB] getAnimeMetaById error:', e.message);
  }
  return null;
}

const ADMIN_ANIME_FIELDS = Object.freeze([
  'title_chinese',
  'oi_msg',
  'oi_index',
  'episodes',
  'status'
]);

const ADMIN_ANIME_STATUSES = new Set([
  'NOT_YET_RELEASED',
  'RELEASING',
  'FINISHED',
  'CANCELLED',
  'HIATUS'
]);

function getAdminAnimePage({ query = '', year = '', month = '', status = '', page = 1, perPage = 25 } = {}) {
  try {
    const normalizedQuery = String(query || '').trim();
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePerPage = Math.max(1, Math.min(Number.parseInt(perPage, 10) || 25, 100));
    const offset = (safePage - 1) * safePerPage;
    const where = [];
    const params = [];

    if (normalizedQuery) {
      const like = `%${normalizedQuery}%`;
      where.push(`(
        CAST(anilist_id AS TEXT) LIKE ? OR
        title_chinese LIKE ? OR
        title_romaji LIKE ? OR
        title_native LIKE ? OR
        oi_msg LIKE ?
      )`);
      params.push(like, like, like, like, like);
    }

    const normalizedYear = Number.parseInt(year, 10);
    if (Number.isInteger(normalizedYear) && normalizedYear >= 1900 && normalizedYear <= 2100) {
      where.push('season_year = ?');
      params.push(normalizedYear);
    }

    const normalizedMonth = Number.parseInt(month, 10);
    if (Number.isInteger(normalizedMonth) && normalizedMonth >= 1 && normalizedMonth <= 12) {
      const paddedMonth = String(normalizedMonth).padStart(2, '0');
      where.push(`(
        start_date LIKE ? OR
        start_date LIKE ? OR
        start_date LIKE ?
      )`);
      params.push(
        `%\"month\":${normalizedMonth},%`,
        `%\"month\": ${normalizedMonth},%`,
        `____-${paddedMonth}-%`
      );
    }

    const normalizedStatus = String(status || '').trim().toUpperCase();
    if (ADMIN_ANIME_STATUSES.has(normalizedStatus)) {
      where.push('status = ?');
      params.push(normalizedStatus);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countRows = db.exec(
      `SELECT COUNT(*) AS count FROM anime_meta ${whereSql}`,
      params
    );
    const total = countRows.length && countRows[0].values.length
      ? Number(countRows[0].values[0][0]) || 0
      : 0;
    const rows = db.exec(
      `SELECT * FROM anime_meta ${whereSql}
       ORDER BY last_updated DESC, anilist_id ASC
       LIMIT ? OFFSET ?`,
      [...params, safePerPage, offset]
    );

    return {
      results: rows.length && rows[0].values.length
        ? rows[0].values.map(value => rowToObj(rows[0].columns, value))
        : [],
      total,
      page: safePage,
      perPage: safePerPage,
      hasMore: offset + safePerPage < total,
      filters: {
        query: normalizedQuery,
        year: Number.isInteger(normalizedYear) ? normalizedYear : '',
        month: Number.isInteger(normalizedMonth) ? normalizedMonth : '',
        status: ADMIN_ANIME_STATUSES.has(normalizedStatus) ? normalizedStatus : ''
      }
    };
  } catch (e) {
    console.error('[DB] getAdminAnimePage error:', e.message);
    return { results: [], total: 0, page: 1, perPage: 25, hasMore: false };
  }
}

function normalizeAdminAnimeUpdates(updates = {}) {
  const result = {};
  for (const field of ADMIN_ANIME_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(updates, field)) continue;
    const value = updates[field];
    if (field === 'title_chinese' || field === 'oi_msg') {
      result[field] = String(value ?? '').trim();
      if (result[field].length > 200) return { error: `${field} 长度不能超过 200 个字符` };
    } else if (field === 'oi_index' || field === 'episodes') {
      if (value === '' || value === null || value === undefined) {
        return { error: `${field} 必须是数字` };
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || (field === 'oi_index' && parsed < 1)) {
        return { error: `${field} 数值不合法` };
      }
      result[field] = parsed;
    } else if (field === 'status') {
      result[field] = String(value ?? '').trim().toUpperCase();
      if (!ADMIN_ANIME_STATUSES.has(result[field])) {
        return { error: '播出状态不合法' };
      }
    }
  }
  return { updates: result };
}

function updateAnimeMetaByAdmin(anilistId, updates, editor = {}) {
  const id = Number(anilistId);
  if (!Number.isInteger(id) || id <= 0) return { error: '番剧 ID 不合法' };
  const normalized = normalizeAdminAnimeUpdates(updates);
  if (normalized.error) return normalized;
  const current = getAnimeMetaById(id);
  if (!current) return { error: '番剧不存在', notFound: true };

  const changedFields = {};
  for (const field of ADMIN_ANIME_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(normalized.updates, field)) continue;
    if (String(current[field] ?? '') === String(normalized.updates[field] ?? '')) continue;
    changedFields[field] = {
      old: current[field] ?? '',
      new: normalized.updates[field]
    };
  }
  if (Object.keys(changedFields).length === 0) {
    return { success: true, changed: false, anime: current, changedFields: {} };
  }

  const now = Math.floor(Date.now() / 1000);
  const fields = Object.keys(changedFields);
  const values = fields.map(field => normalized.updates[field]);
  values.push(now, id);
  try {
    db.run('BEGIN TRANSACTION');
    db.run(
      `UPDATE anime_meta SET ${fields.map(field => `${field} = ?`).join(', ')}, last_updated = ? WHERE anilist_id = ?`,
      values
    );
    db.run(
      `INSERT INTO anime_meta_edits
       (anilist_id, user_id, editor_name, changed_fields_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        id,
        Number(editor.userId) || null,
        String(editor.editorName || '').trim(),
        JSON.stringify(changedFields),
        now
      ]
    );
    queueAnimeForRag(id, now);
    if (!suppressSave) syncAnimeSearchById(id);
    db.run('COMMIT');
    cancelPendingSave();
    saveToFile();
    return {
      success: true,
      changed: true,
      anime: getAnimeMetaById(id),
      changedFields
    };
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (_) {}
    console.error('[DB] updateAnimeMetaByAdmin error:', e.message);
    return { error: e.message };
  }
}

function getAnimeMetaEditHistory(anilistId, limit = 50) {
  try {
    const id = Number(anilistId);
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 100));
    const rows = db.exec(
      `SELECT id, anilist_id, user_id, editor_name, changed_fields_json, created_at
       FROM anime_meta_edits
       WHERE anilist_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [id, safeLimit]
    );
    return rows.length && rows[0].values.length
      ? rows[0].values.map(value => {
          const item = rowToObj(rows[0].columns, value);
          try { item.changed_fields = JSON.parse(item.changed_fields_json || '{}'); } catch (_) { item.changed_fields = {}; }
          delete item.changed_fields_json;
          return item;
        })
      : [];
  } catch (e) {
    console.error('[DB] getAnimeMetaEditHistory error:', e.message);
    return [];
  }
}

function updateAnimeAiringState(anilistId, state) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const current = getAnimeMetaById(anilistId);
    if (!current) return { error: 'not_found' };
    const episodes = state.episodes !== undefined ? state.episodes : current.episodes;
    const status = state.status !== undefined ? state.status : current.status;
    const nextAiringEpisode = state.next_airing_episode !== undefined
      ? state.next_airing_episode
      : current.next_airing_episode;
    const nextAiringAt = state.next_airing_at !== undefined
      ? state.next_airing_at
      : current.next_airing_at;

    db.run(
      `UPDATE anime_meta
       SET episodes = ?, status = ?, next_airing_episode = ?, next_airing_at = ?, last_updated = ?
       WHERE anilist_id = ?`,
      [episodes || 0, status || '', nextAiringEpisode || 0, nextAiringAt || 0, now, anilistId]
    );
    queueAnimeForRag(anilistId, now);
    saveToFile();
    return { success: true };
  } catch (e) {
    console.error('[DB] updateAnimeAiringState error:', e.message);
    return { error: e.message };
  }
}

function getAnimeMetaBySeason(season, seasonYear, limit = 30) {
  try {
    const rows = db.exec(
      `SELECT * FROM anime_meta 
       WHERE season = ? AND season_year = ? AND status = 'RELEASING' AND country_of_origin = 'JP' AND oi_msg != ''
       ORDER BY average_score DESC
       LIMIT ?`,
      [season, seasonYear, limit]
    );
    if (rows.length > 0 && rows[0].values.length > 0) {
      return rows[0].values.map(v => rowToObj(rows[0].columns, v));
    }
  } catch (e) {
    console.error('[DB] getAnimeMetaBySeason error:', e.message);
  }
  return [];
}

function getRankingsFromDb(sortType, limit = 20, options = {}) {
  try {
    if (sortType === 'yearpopular') {
      const currentYear = new Date().getFullYear();
      const year = parseInt(options.year) || currentYear;
      const rows = db.exec(
        `SELECT * FROM anime_meta
         WHERE status IN ('RELEASING', 'FINISHED')
           AND season_year = ?
           AND title_chinese != ''
           AND country_of_origin = 'JP'
           AND oi_msg != ''
         ORDER BY popularity DESC, average_score DESC
         LIMIT ?`,
        [year, limit]
      );
      if (rows.length > 0 && rows[0].values.length > 0) {
        return rows[0].values.map(v => rowToObj(rows[0].columns, v));
      }
      return [];
    }

    if (sortType === 'trending') {
      const season = options.season || '';
      const seasonYear = parseInt(options.seasonYear) || 0;
      if (!season || !seasonYear) return [];
      const rows = db.exec(
        `SELECT *,
          (popularity * 0.7 + average_score * 100 * 0.3) AS trend_score
         FROM anime_meta
         WHERE status = 'RELEASING'
           AND season = ?
           AND season_year = ?
           AND title_chinese != ''
           AND country_of_origin = 'JP'
           AND oi_msg != ''
         ORDER BY trend_score DESC, popularity DESC, average_score DESC
         LIMIT ?`,
        [season, seasonYear, limit]
      );
      if (rows.length > 0 && rows[0].values.length > 0) {
        return rows[0].values.map(v => rowToObj(rows[0].columns, v));
      }
      return [];
    }

    let orderBy = 'popularity DESC';
    if (sortType === 'toprated') orderBy = 'average_score DESC';

    const rows = db.exec(
      `SELECT * FROM anime_meta 
       WHERE status IN ('RELEASING', 'FINISHED') AND title_chinese != '' AND country_of_origin = 'JP' AND oi_msg != ''
       ORDER BY ${orderBy}
       LIMIT ?`,
      [limit]
    );
    if (rows.length > 0 && rows[0].values.length > 0) {
      return rows[0].values.map(v => rowToObj(rows[0].columns, v));
    }
  } catch (e) {
    console.error('[DB] getRankingsFromDb error:', e.message);
  }
  return [];
}

function getAiringScheduleFromDb({ strict = false } = {}) {
  try {
    const now = Math.floor(Date.now() / 1000);
    // Include the past week so the calendar can recover stale weekly next_airing_at
    // values when metadata sync has not run immediately after an episode aired.
    // Keep a wider future horizon for currently releasing shows that take a
    // one- or two-week broadcast break; they still belong in the weekday
    // calendar even when their next episode is not inside the next seven days.
    const weekAgo = now - 7 * 24 * 60 * 60;
    const futureHorizon = now + 45 * 24 * 60 * 60;
    const rows = db.exec(
      `SELECT * FROM anime_meta 
       WHERE status = 'RELEASING' 
         AND next_airing_at > ${weekAgo} 
         AND next_airing_at < ${futureHorizon}
         AND title_chinese != ''
         AND country_of_origin = 'JP'
         AND oi_msg != ''
       ORDER BY next_airing_at ASC
       LIMIT 200`,
      []
    );
    if (rows.length > 0 && rows[0].values.length > 0) {
      return rows[0].values.map(v => rowToObj(rows[0].columns, v));
    }
  } catch (e) {
    console.error('[DB] getAiringScheduleFromDb error:', e.message);
    if (strict) throw e;
  }
  return [];
}

// Agent queries use exact windows. The calendar's recovery window stays separate.
function getAgentAiringSchedule({ from, until, query = '', anilistIds, offset = 0, limit = 21 }) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(until) || until <= from) throw new Error('SCHEDULE_WINDOW_INVALID');
  const where = ["status = 'RELEASING'", 'next_airing_at >= ?', 'next_airing_at < ?',
    "title_chinese != ''", "country_of_origin = 'JP'", "oi_msg != ''"];
  const params = [from, until];
  if (anilistIds) {
    const ids = [...new Set(anilistIds.filter(id => Number.isSafeInteger(id) && id > 0))];
    if (!ids.length) return [];
    where.push(`anilist_id IN (${ids.join(',')})`);
  }
  if (query.trim()) {
    where.push('(instr(lower(title_chinese), ?) > 0 OR instr(lower(title_romaji), ?) > 0 OR instr(lower(title_native), ?) > 0)');
    params.push(...Array(3).fill(query.trim().toLowerCase()));
  }
  params.push(Math.max(1, Math.min(Number(limit) || 21, 21)), Math.max(0, Math.floor(Number(offset) || 0)));
  const rows = db.exec(`SELECT * FROM anime_meta WHERE ${where.join(' AND ')}
    ORDER BY next_airing_at ASC, anilist_id ASC LIMIT ? OFFSET ?`, params);
  return rows[0]?.values.map(value => rowToObj(rows[0].columns, value)) || [];
}

function getBrowseFromDb(filters, page = 1, perPage = 24, { strict = false } = {}) {
  try {
    let where = [
      "title_chinese != ''",
      "country_of_origin = 'JP'",
      "oi_msg != ''",
      "start_date != ''",
      `(
        season_year < CAST(strftime('%Y', 'now') AS INTEGER)
        OR (
          season_year = CAST(strftime('%Y', 'now') AS INTEGER)
          AND
          CASE
            WHEN CAST(strftime('%m', 'now') AS INTEGER) <= 3 THEN season IN ('WINTER')
            WHEN CAST(strftime('%m', 'now') AS INTEGER) <= 6 THEN season IN ('WINTER', 'SPRING')
            WHEN CAST(strftime('%m', 'now') AS INTEGER) <= 9 THEN season IN ('WINTER', 'SPRING', 'SUMMER')
            ELSE season IN ('WINTER', 'SPRING', 'SUMMER', 'FALL')
          END
        )
      )`
    ];
    const params = [];

    if (filters.genre) {
      if (filters.genre === 'Yuri') {
        where.push("content_tags LIKE ?");
        params.push('%"百合"%');
      } else if (filters.genre === 'Iyashikei') {
        where.push("content_tags LIKE ?");
        params.push('%"治愈"%');
      } else if (filters.genre === 'Harem') {
        where.push("content_tags LIKE ?");
        params.push('%"后宫"%');
      } else if (filters.genre === 'Ecchi') {
        where.push("genres LIKE ?");
        params.push('%Ecchi%');
      } else {
        where.push("genres LIKE ?");
        params.push('%' + filters.genre + '%');
      }
    }
    if (filters.year) {
      where.push('season_year = ?');
      params.push(filters.year);
    }
    if (filters.month) {
      const month = Number(filters.month);
      if (Number.isInteger(month) && month >= 1 && month <= 12) {
        const paddedMonth = String(month).padStart(2, '0');
        // AniList dates are normally stored as compact JSON. Keep support for
        // legacy ISO date strings and JSON that was serialized with spaces.
        where.push(`(
          start_date LIKE ?
          OR start_date LIKE ?
          OR start_date LIKE ?
        )`);
        params.push(
          `%"month":${month},%`,
          `%"month": ${month},%`,
          `____-${paddedMonth}-%`
        );
      }
    }
    if (filters.season) {
      where.push('season = ?');
      params.push(filters.season.toUpperCase());
    }
    if (filters.format) {
      const format = String(filters.format).toUpperCase();
      if (format === 'TV' || format === 'MOVIE') {
        where.push('format = ?');
        params.push(format);
      }
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const offset = (page - 1) * perPage;

    const countRows = db.exec(`SELECT COUNT(*) as cnt FROM anime_meta ${whereClause}`, params);
    const total = (countRows.length > 0 && countRows[0].values.length > 0)
      ? countRows[0].values[0][0] : 0;

    const requestedSort = String(filters.sort || 'latest').toLowerCase();
    const sort = ['latest', 'popular', 'rating'].includes(requestedSort)
      ? requestedSort
      : 'latest';
    const orderBy = sort === 'popular'
      ? 'popularity DESC, average_score DESC, start_date_key DESC'
      : sort === 'rating'
        ? 'average_score DESC, popularity DESC, start_date_key DESC'
        : 'start_date_key DESC';

    const rows = db.exec(
      `SELECT * FROM anime_meta ${whereClause}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [...params, perPage, offset]
    );

    let results = [];
    if (rows.length > 0 && rows[0].values.length > 0) {
      results = rows[0].values.map(v => rowToObj(rows[0].columns, v));
    }

    return {
      results,
      total,
      page,
      hasMore: offset + perPage < total,
      filters: {
        genre: filters.genre || '',
        year: filters.year || '',
        month: filters.month || '',
        season: filters.season || '',
        format: filters.format || '',
        sort
      }
    };
  } catch (e) {
    console.error('[DB] getBrowseFromDb error:', e.message);
    if (strict) throw e;
  }
  return { results: [], total: 0, page, hasMore: false, filters };
}

function animeStartDateValue(meta) {
  const raw = String(meta?.start_date || '').trim();
  let year = Number(meta?.season_year) || 0;
  let month = 0;
  let day = 0;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      year = Number(parsed.year) || year;
      month = Number(parsed.month) || 0;
      day = Number(parsed.day) || 0;
    }
  } catch (_) {
    const match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (match) {
      year = Number(match[1]) || year;
      month = Number(match[2]) || 0;
      day = Number(match[3]) || 0;
    }
  }
  return year * 10000 + month * 100 + day;
}

function getRecentMoviesFromDb(limit = 10) {
  try {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    const rows = db.exec(
      `SELECT * FROM anime_meta
       WHERE title_chinese != ''
         AND country_of_origin = 'JP'
         AND oi_msg != ''
         AND start_date != ''
         AND status = 'FINISHED'
         AND format = 'MOVIE'`
    );
    if (!rows.length || !rows[0].values.length) return [];
    return rows[0].values
      .map(value => rowToObj(rows[0].columns, value))
      .sort((a, b) => {
        const dateDiff = animeStartDateValue(b) - animeStartDateValue(a);
        if (dateDiff) return dateDiff;
        return (Number(b.popularity) || 0) - (Number(a.popularity) || 0);
      })
      .slice(0, safeLimit);
  } catch (e) {
    console.error('[DB] getRecentMoviesFromDb error:', e.message);
  }
  return [];
}

function searchAnimeMetaByTitle(title, limit = 30, { strict = false } = {}) {
  if (!title || title.trim().length === 0) return [];
  try {
    const trimmed = title.trim();
    const like = '%' + trimmed + '%';
    const ftsQuery = searchIndexReady ? buildFtsQuery(trimmed) : '';
    if (ftsQuery) {
      try {
        const ftsRows = db.exec(
          `SELECT m.*,
            CASE
              WHEN m.title_chinese = ? THEN 100
              WHEN m.title_chinese LIKE ? THEN 90
              WHEN m.title_romaji LIKE ? THEN 75
              WHEN m.title_native LIKE ? THEN 75
              ELSE 60
            END AS match_score
          FROM anime_meta m
          JOIN anime_meta_fts f ON f.docid = m.anilist_id
          WHERE anime_meta_fts MATCH ?
            AND m.country_of_origin = 'JP'
            AND m.oi_msg != ''
          ORDER BY match_score DESC, m.average_score DESC
          LIMIT ?`,
          [trimmed, like, like, like, ftsQuery, limit]
        );
        if (ftsRows.length > 0 && ftsRows[0].values.length > 0) {
          return ftsRows[0].values.map(v => rowToObj(ftsRows[0].columns, v));
        }
      } catch (e) {
        console.warn('[DB] FTS search failed, falling back to LIKE search:', e.message);
      }
    }

    const rows = db.exec(
      `SELECT *, 
        CASE 
          WHEN title_chinese = ? THEN 100
          WHEN title_chinese LIKE ? THEN 80
          WHEN title_romaji LIKE ? THEN 60
          WHEN title_native LIKE ? THEN 60
          ELSE 40
        END AS match_score
      FROM anime_meta
      WHERE (title_chinese LIKE ? 
         OR title_romaji LIKE ?
         OR title_native LIKE ?)
        AND country_of_origin = 'JP'
        AND oi_msg != ''
      ORDER BY match_score DESC, average_score DESC
      LIMIT ?`,
      [trimmed, like, like, like, like, like, like, limit]
    );
    if (rows.length > 0 && rows[0].values.length > 0) {
      return rows[0].values.map(v => rowToObj(rows[0].columns, v));
    }
  } catch (e) {
    console.error('[DB] searchAnimeMetaByTitle error:', e.message);
    if (strict) throw e;
  }
  return [];
}

function getAnimeMetaCount() {
  try {
    const rows = db.exec('SELECT COUNT(*) as cnt FROM anime_meta');
    if (rows.length > 0 && rows[0].values.length > 0) {
      return rows[0].values[0][0];
    }
  } catch (e) {}
  return 0;
}

function getAnimeMetaWithOiMsg(missingOnly = true, limit = 100) {
  try {
    let where = "title_chinese != '' AND country_of_origin = 'JP'";
    if (missingOnly) where += " AND oi_msg = ''";
    const rows = db.exec(
      `SELECT * FROM anime_meta WHERE ${where} ORDER BY average_score DESC LIMIT ?`,
      [limit]
    );
    if (rows.length > 0 && rows[0].values.length > 0) {
      return rows[0].values.map(v => rowToObj(rows[0].columns, v));
    }
  } catch (e) {
    console.error('[DB] getAnimeMetaWithOiMsg error:', e.message);
  }
  return [];
}

// Agent knowledge queries may legitimately target a work that has no current
// playback mapping (for example an older season). Keep this lookup separate
// from the public playable-title search so browse/playback results remain
// restricted to works with an active source.
function searchAnimeMetaByAnyTitle(title, limit = 30) {
  if (!title || title.trim().length === 0) return [];
  try {
    const compact = title.trim().replace(/[：:]/g, '');
    const like = `%${compact}%`;
    const rows = db.exec(`
      SELECT *,
        CASE
          WHEN REPLACE(REPLACE(title_chinese, '：', ''), ':', '') LIKE ? THEN 100
          WHEN REPLACE(REPLACE(title_romaji, '：', ''), ':', '') LIKE ? THEN 80
          WHEN REPLACE(REPLACE(title_native, '：', ''), ':', '') LIKE ? THEN 70
          ELSE 40
        END AS match_score
      FROM anime_meta
      WHERE country_of_origin = 'JP'
        AND (
          REPLACE(REPLACE(title_chinese, '：', ''), ':', '') LIKE ?
          OR REPLACE(REPLACE(title_romaji, '：', ''), ':', '') LIKE ?
          OR REPLACE(REPLACE(title_native, '：', ''), ':', '') LIKE ?
        )
      ORDER BY match_score DESC, average_score DESC
      LIMIT ?`,
      [like, like, like, like, like, like, Math.max(1, Math.min(Number(limit) || 30, 100))]
    );
    if (rows.length > 0 && rows[0].values.length > 0) {
      return rows[0].values.map(v => rowToObj(rows[0].columns, v));
    }
  } catch (e) {
    console.error('[DB] searchAnimeMetaByAnyTitle error:', e.message);
  }
  return [];
}

function getAnimeMetaWithOiMsgCount() {
  try {
    const rows = db.exec(
      `SELECT COUNT(*) as cnt
       FROM anime_meta
       WHERE title_chinese != ''
         AND country_of_origin = 'JP'
         AND oi_msg != ''`
    );
    if (rows.length > 0 && rows[0].values.length > 0) return rows[0].values[0][0];
  } catch (e) {
    console.error('[DB] getAnimeMetaWithOiMsgCount error:', e.message);
  }
  return 0;
}

// Get anime missing OI resolution, regardless of having Chinese title or not
// Used when Chinese titles come solely from OIAPI
function getAnimeMetaMissingOi(limit = 100) {
  try {
    const rows = db.exec(
      `SELECT * FROM anime_meta WHERE country_of_origin = 'JP' AND oi_msg = '' ORDER BY average_score DESC LIMIT ?`,
      [limit]
    );
    if (rows.length > 0 && rows[0].values.length > 0) {
      return rows[0].values.map(v => rowToObj(rows[0].columns, v));
    }
  } catch (e) {
    console.error('[DB] getAnimeMetaMissingOi error:', e.message);
  }
  return [];
}

// 已禁用：oi_msg/oi_index 只由用户手动维护，自动更新不再写入
function updateAnimeOiMsg(anilistId, oiMsg, oiIndex) {
  return { success: true, skipped: true };
}

// 已禁用：title_chinese/oi_msg/oi_index 只由用户手动维护
function updateAnimeTitleAndOiMsg(anilistId, titleChinese, oiMsg, oiIndex) {
  return { success: true, skipped: true };
}

function batchGetChineseTitles(anilistIds) {
  if (!anilistIds || anilistIds.length === 0) return {};
  try {
    const placeholders = anilistIds.map(() => '?').join(',');
    const rows = db.exec(
      `SELECT anilist_id, title_chinese FROM anime_meta WHERE anilist_id IN (${placeholders})`,
      anilistIds
    );
    const result = {};
    if (rows.length > 0 && rows[0].values.length > 0) {
      for (const row of rows[0].values) {
        result[row[0]] = row[1] || '';
      }
    }
    return result;
  } catch (e) {
    console.error('[DB] batchGetChineseTitles error:', e.message);
    return {};
  }
}

function clearAnimeMeta() {
  try {
    // Cancel pending debounce to prevent stale data overwriting
    cancelPendingSave();
    db.run('DELETE FROM anime_meta');
    if (searchIndexReady) db.run('DELETE FROM anime_meta_fts');
    corpusDb.run('DELETE FROM anime_chunks');
    ragStore?.markDirty();
    db.run('DELETE FROM rag_index_queue');
    ragIndexVersion++;
    saveToFile();
    console.log('[DB] anime_meta table cleared');
    return { success: true };
  } catch (e) {
    console.error('[DB] clearAnimeMeta error:', e.message);
    return { error: e.message };
  }
}

// ==================== Vector RAG Operations ====================

function queueAnimeForRag(anilistId, sourceUpdatedAt = 0) {
  const id = Number(anilistId) || 0;
  if (!id || !db) return;
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO rag_index_queue (anilist_id, source_updated_at, queued_at, generation)
     VALUES (?, ?, ?, ?) ON CONFLICT(anilist_id) DO UPDATE SET
     source_updated_at = excluded.source_updated_at, queued_at = excluded.queued_at, generation = excluded.generation`,
    [id, Number(sourceUpdatedAt) || now, now, randomUUID()]
  );
  if (!suppressSave) scheduleSave();
}

function getAnimeMetaForRag(afterId = 0, limit = 100) {
  try {
    const rows = db.exec(
      `SELECT * FROM anime_meta
       WHERE anilist_id > ? AND country_of_origin = 'JP'
       ORDER BY anilist_id ASC LIMIT ?`,
      [Number(afterId) || 0, Math.max(1, Math.min(Number(limit) || 100, 1000))]
    );
    if (rows.length && rows[0].values.length) {
      return rows[0].values.map(value => rowToObj(rows[0].columns, value));
    }
  } catch (e) {
    console.error('[DB] getAnimeMetaForRag error:', e.message);
  }
  return [];
}

function getPendingRagAnime(limit = 100) {
  try {
    const rows = db.exec(
      `SELECT m.*, q.generation AS _rag_generation FROM rag_index_queue q
       JOIN anime_meta m ON m.anilist_id = q.anilist_id
       ORDER BY q.queued_at ASC LIMIT ?`,
      [Math.max(1, Math.min(Number(limit) || 100, 1000))]
    );
    if (rows.length && rows[0].values.length) {
      return rows[0].values.map(value => rowToObj(rows[0].columns, value));
    }
  } catch (e) {
    console.error('[DB] getPendingRagAnime error:', e.message);
  }
  return [];
}

function getRagQueueGeneration(anilistId) {
  const rows = db.exec('SELECT generation FROM rag_index_queue WHERE anilist_id = ?', [Number(anilistId)]);
  return String(rows[0]?.values[0]?.[0] || '');
}

function completePendingRagAnime(entries = []) {
  for (const item of entries) db.run('DELETE FROM rag_index_queue WHERE anilist_id = ? AND generation = ?', [item.anilistId, item.generation]);
  if (entries.length) scheduleSave();
}

function prepareRagIndexWrite() {
  // Persist metadata/generations before publishing derived data in the sidecar.
  // The later queue acknowledgement still flushes corpus first.
  if (ragStore) flushDatabase();
}

function getRagChunkPage(embeddingModel, afterId = '', limit = 1000) {
  const rows = corpusDb.exec('SELECT * FROM anime_chunks WHERE embedding_model = ? AND id > ? ORDER BY id LIMIT ?',
    [embeddingModel, afterId, Math.max(1, Math.min(Number(limit) || 1000, 2000))]);
  return rows[0]?.values.map(row => rowToObj(rows[0].columns, row)) || [];
}

function getRagChunksByAnime(anilistId, sourceType, embeddingModel) {
  try {
    const rows = corpusDb.exec(
      `SELECT * FROM anime_chunks
       WHERE anilist_id = ? AND source_type = ? AND embedding_model = ?
       ORDER BY id ASC`,
      [Number(anilistId) || 0, String(sourceType || ''), String(embeddingModel || '')]
    );
    if (rows.length && rows[0].values.length) {
      return rows[0].values.map(value => rowToObj(rows[0].columns, value));
    }
  } catch (e) {
    console.error('[DB] getRagChunksByAnime error:', e.message);
  }
  return [];
}

function bindRagChunk(chunk, now) {
  const embedding = chunk.embedding instanceof Uint8Array
    ? chunk.embedding
    : new Uint8Array(chunk.embedding || []);
  return [
    String(chunk.id || ''),
    Number(chunk.anilistId ?? chunk.anilist_id) || 0,
    String(chunk.chunkType ?? chunk.chunk_type ?? ''),
    String(chunk.chunkText ?? chunk.chunk_text ?? ''),
    String(chunk.sourceType ?? chunk.source_type ?? ''),
    String(chunk.sourceUrl ?? chunk.source_url ?? ''),
    String(chunk.sourceTitle ?? chunk.source_title ?? ''),
    String(chunk.publishedAt ?? chunk.published_at ?? ''),
    Number(chunk.trustScore ?? chunk.trust_score) || 0,
    String(chunk.contentHash ?? chunk.content_hash ?? ''),
    String(chunk.embeddingModel ?? chunk.embedding_model ?? ''),
    Number(chunk.embeddingDimensions ?? chunk.embedding_dimensions) || 0,
    embedding,
    Number(chunk.sourceUpdatedAt ?? chunk.source_updated_at) || 0,
    Number(chunk.createdAt ?? chunk.created_at) || now,
    now
  ];
}

function insertRagChunk(chunk, now) {
  corpusDb.run(
    `INSERT OR REPLACE INTO anime_chunks
      (id, anilist_id, chunk_type, chunk_text, source_type, source_url,
       source_title, published_at, trust_score, content_hash,
       embedding_model, embedding_dimensions, embedding, source_updated_at,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindRagChunk(chunk, now)
  );
}

function replaceAnimeRagChunks(anilistId, sourceType, embeddingModel, chunks = []) {
  const id = Number(anilistId) || 0;
  if (!id) return { error: 'invalid_anilist_id' };
  try {
    const now = Math.floor(Date.now() / 1000);
    corpusDb.run('BEGIN TRANSACTION');
    corpusDb.run(
      'DELETE FROM anime_chunks WHERE anilist_id = ? AND source_type = ? AND embedding_model = ?',
      [id, String(sourceType || ''), String(embeddingModel || '')]
    );
    for (const chunk of chunks) insertRagChunk(chunk, now);
    corpusDb.run('COMMIT');
    ragIndexVersion++;
    scheduleCorpusSave();
    return { success: true, count: chunks.length };
  } catch (e) {
    try { corpusDb.run('ROLLBACK'); } catch (_) {}
    console.error('[DB] replaceAnimeRagChunks error:', e.message);
    return { error: e.message };
  }
}

function upsertRagChunks(chunks = []) {
  if (!Array.isArray(chunks) || !chunks.length) return { success: true, count: 0 };
  try {
    const now = Math.floor(Date.now() / 1000);
    corpusDb.run('BEGIN TRANSACTION');
    for (const chunk of chunks) insertRagChunk(chunk, now);
    corpusDb.run('COMMIT');
    ragIndexVersion++;
    scheduleCorpusSave();
    return { success: true, count: chunks.length };
  } catch (e) {
    try { corpusDb.run('ROLLBACK'); } catch (_) {}
    console.error('[DB] upsertRagChunks error:', e.message);
    return { error: e.message };
  }
}

function getRagChunks(embeddingModel, limit = 50000) {
  try {
    const rows = corpusDb.exec(
      `SELECT * FROM anime_chunks WHERE embedding_model = ?
       ORDER BY updated_at DESC LIMIT ?`,
      [String(embeddingModel || ''), Math.max(1, Math.min(Number(limit) || 50000, 100000))]
    );
    if (rows.length && rows[0].values.length) {
      return rows[0].values.map(value => rowToObj(rows[0].columns, value));
    }
  } catch (e) {
    console.error('[DB] getRagChunks error:', e.message);
  }
  return [];
}

function clearRagIndex(embeddingModel = '') {
  try {
    if (embeddingModel) corpusDb.run('DELETE FROM anime_chunks WHERE embedding_model = ?', [embeddingModel]);
    else corpusDb.run('DELETE FROM anime_chunks');
    ragStore?.markDirty();
    ragIndexVersion++;
    saveToFile();
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
}

function deleteExpiredExternalRagChunks(olderThanEpoch) {
  try {
    corpusDb.run(
      `DELETE FROM anime_chunks
       WHERE source_type = 'web' AND source_updated_at > 0 AND source_updated_at < ?`,
      [Number(olderThanEpoch) || 0]
    );
    const changed = corpusDb.getRowsModified();
    if (changed) {
      ragIndexVersion++;
      scheduleCorpusSave();
    }
    return changed;
  } catch (e) {
    console.error('[DB] deleteExpiredExternalRagChunks error:', e.message);
    return 0;
  }
}

function getRagIndexStats() {
  try {
    const totals = corpusDb.exec(
      `SELECT embedding_model, source_type, COUNT(*) AS chunk_count,
              COUNT(DISTINCT CASE WHEN anilist_id > 0 THEN anilist_id END) AS anime_count,
              MAX(updated_at) AS last_updated
       FROM anime_chunks GROUP BY embedding_model, source_type`
    );
    const queueRows = db.exec('SELECT COUNT(*) FROM rag_index_queue');
    return {
      groups: totals.length && totals[0].values.length
        ? totals[0].values.map(value => rowToObj(totals[0].columns, value))
        : [],
      pending: queueRows.length && queueRows[0].values.length ? Number(queueRows[0].values[0][0]) || 0 : 0,
      version: ragIndexVersion
    };
  } catch (e) {
    return { groups: [], pending: 0, version: ragIndexVersion, error: e.message };
  }
}

function getRagIndexVersion() {
  return ragIndexVersion;
}

// ==================== Anime Agent ====================

function createAgentSession(id, userId, title = '') {
  try {
    const now = Math.floor(Date.now() / 1000);
    db.run(
      'INSERT INTO agent_sessions (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [id, userId, String(title || '').slice(0, 80), now, now]
    );
    scheduleSave();
    return getAgentSession(id, userId);
  } catch (e) {
    console.error('[DB] createAgentSession error:', e.message);
    return null;
  }
}

function getAgentSession(id, userId) {
  try {
    const rows = db.exec(
      'SELECT * FROM agent_sessions WHERE id = ? AND user_id = ? LIMIT 1',
      [id, userId]
    );
    if (rows.length && rows[0].values.length) {
      return rowToObj(rows[0].columns, rows[0].values[0]);
    }
  } catch (e) {
    console.error('[DB] getAgentSession error:', e.message);
  }
  return null;
}

function getAgentSessions(userId, limit = 20) {
  try {
    const rows = db.exec(
      'SELECT * FROM agent_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',
      [userId, Math.max(1, Math.min(Number(limit) || 20, 50))]
    );
    if (rows.length && rows[0].values.length) {
      return rows[0].values.map(v => rowToObj(rows[0].columns, v));
    }
  } catch (e) {
    console.error('[DB] getAgentSessions error:', e.message);
  }
  return [];
}

function getAgentMemorySummaries(userId, limit = 100) {
  try {
    const rows = db.exec(
      `SELECT s.id, s.title, s.summary, s.updated_at,
        (SELECT GROUP_CONCAT(content, char(10)) FROM
          (SELECT content FROM agent_messages WHERE session_id = s.id ORDER BY id DESC LIMIT 8)) AS recent_text
        FROM agent_sessions s WHERE s.user_id = ? ORDER BY s.updated_at DESC LIMIT ?`,
      [userId, Math.max(1, Math.min(Number(limit) || 100, 200))]
    );
    if (rows.length && rows[0].values.length) return rows[0].values.map(v => rowToObj(rows[0].columns, v));
  } catch (e) {
    console.error('[DB] getAgentMemorySummaries error:', e.message);
  }
  return [];
}

function getAgentUserMemory(userId) {
  try {
    const rows = db.exec(
      'SELECT user_id, summary, updated_at FROM agent_user_memory WHERE user_id = ? LIMIT 1',
      [userId]
    );
    if (rows.length && rows[0].values.length) return rowToObj(rows[0].columns, rows[0].values[0]);
  } catch (e) {
    console.error('[DB] getAgentUserMemory error:', e.message);
  }
  return null;
}

function updateAgentUserMemory(userId, summary = '') {
  try {
    const now = Math.floor(Date.now() / 1000);
    db.run('DELETE FROM agent_user_memory WHERE user_id = ?', [userId]);
    db.run(
      'INSERT INTO agent_user_memory (user_id, summary, updated_at) VALUES (?, ?, ?)',
      [userId, String(summary || '').slice(0, 12000), now]
    );
    scheduleSave();
    return { success: true };
  } catch (e) {
    console.error('[DB] updateAgentUserMemory error:', e.message);
    return { error: e.message };
  }
}

function clearAgentMemory(userId) {
  try {
    agentContext.getAgentMemorySnapshot(userId);
    db.run('BEGIN TRANSACTION');
    agentContext.purgeAgentContext(userId);
    db.run('DELETE FROM agent_messages WHERE session_id IN (SELECT id FROM agent_sessions WHERE user_id = ?)', [userId]);
    db.run('UPDATE agent_sessions SET summary = \'\', pending_action = \'\', summary_through_id = 0, updated_at = ? WHERE user_id = ?', [Math.floor(Date.now() / 1000), userId]);
    db.run('DELETE FROM agent_user_memory WHERE user_id = ?', [userId]);
    db.run('DELETE FROM agent_requests WHERE user_id = ?', [userId]);
    db.run('DELETE FROM agent_operations WHERE user_id = ?', [userId]);
    db.run('COMMIT');
    scheduleSave();
    return { success: true };
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (_) {}
    console.error('[DB] clearAgentMemory error:', e.message);
    return { error: e.message };
  }
}

function clearAgentSessionMemory(id, userId) {
  try {
    const owned = getAgentSession(id, userId);
    if (!owned) return { error: 'not_found' };
    db.run('BEGIN TRANSACTION');
    agentContext.purgeAgentContext(userId, id);
    db.run('DELETE FROM agent_messages WHERE session_id = ?', [id]);
    db.run('DELETE FROM agent_requests WHERE user_id = ? AND session_id = ?', [userId, id]);
    db.run('DELETE FROM agent_operations WHERE user_id = ? AND session_id = ?', [userId, id]);
    db.run("UPDATE agent_sessions SET summary = '', pending_action = '', summary_through_id = 0, state_json = '{}', active_summary_id = '', summary_cursor = '{}', context_revision = context_revision + 1, updated_at = ? WHERE id = ? AND user_id = ?", [Math.floor(Date.now() / 1000), id, userId]);
    db.run('COMMIT');
    scheduleSave();
    return { success: true };
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (_) {}
    console.error('[DB] clearAgentSessionMemory error:', e.message);
    return { error: e.message };
  }
}

function updateAgentSessionSummary(id, userId, summary) {
  try {
    const owned = getAgentSession(id, userId);
    if (!owned) return { error: 'not_found' };
    const now = Math.floor(Date.now() / 1000);
    db.run(
      'UPDATE agent_sessions SET summary = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      [String(summary || '').slice(0, 12000), now, id, userId]
    );
    scheduleSave();
    return { success: true };
  } catch (e) {
    console.error('[DB] updateAgentSessionSummary error:', e.message);
    return { error: e.message };
  }
}

function updateAgentSessionPendingAction(id, userId, pendingAction = '') {
  try {
    const owned = getAgentSession(id, userId);
    if (!owned) return { error: 'not_found' };
    db.run(
      'UPDATE agent_sessions SET pending_action = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      [String(pendingAction || '').slice(0, 12000), Math.floor(Date.now() / 1000), id, userId]
    );
    scheduleSave();
    return { success: true };
  } catch (e) {
    console.error('[DB] updateAgentSessionPendingAction error:', e.message);
    return { error: e.message };
  }
}

function addAgentMessage(sessionId, role, content, cards = []) {
  try {
    const now = Math.floor(Date.now() / 1000);
    db.run(
      'INSERT INTO agent_messages (session_id, role, content, cards_json, created_at) VALUES (?, ?, ?, ?, ?)',
      [sessionId, role, String(content || ''), JSON.stringify(cards || []), now]
    );
    db.run('UPDATE agent_sessions SET updated_at = ? WHERE id = ?', [now, sessionId]);
    scheduleSave();
    return { success: true };
  } catch (e) {
    console.error('[DB] addAgentMessage error:', e.message);
    return { error: e.message };
  }
}

// Mutation and its receipt are committed together; model failures cannot erase the receipt.
function pruneAgentReceipts(now) {
  db.run('DELETE FROM agent_requests WHERE created_at < ?', [now - 7 * 86400]);
  db.run('DELETE FROM agent_operations WHERE created_at < ?', [now - 30 * 86400]);
}

function executeAgentOperation(operation, execute) {
  const existing = db.exec('SELECT result_json FROM agent_operations WHERE user_id = ? AND operation_id = ?',
    [operation.userId, operation.operationId]);
  if (existing[0]?.values.length) return JSON.parse(existing[0].values[0][0]);
  db.run('BEGIN TRANSACTION');
  try {
    const result = execute();
    const applied = result?.actions?.some(action => ['collect', 'history_remove', 'play'].includes(action.type));
    if (!applied) {
      db.run('ROLLBACK');
      return result;
    }
    pruneAgentReceipts(Math.floor(Date.now() / 1000));
    db.run(`INSERT INTO agent_operations (operation_id, user_id, request_id, input_hash, session_id, intent, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [operation.operationId, operation.userId, operation.requestId,
        operation.inputHash || '', operation.sessionId, operation.intent, JSON.stringify(result), Math.floor(Date.now() / 1000)]);
    db.run('COMMIT');
    scheduleSave();
    flushDatabase();
    return result;
  } catch (error) {
    try { db.run('ROLLBACK'); } catch (_) {}
    // A persistence failure is an unknown outcome, never a retryable business failure.
    throw new Error(`OPERATION_OUTCOME_UNKNOWN: ${error.message}`);
  }
}

function getAgentRequestResult(userId, requestId, inputHash) {
  const completed = db.exec('SELECT input_hash, session_id, result_json FROM agent_requests WHERE user_id = ? AND request_id = ?', [userId, requestId]);
  let receipts = completed[0]?.values.length ? completed[0].values :
    (db.exec('SELECT input_hash, session_id, result_json FROM agent_operations WHERE user_id = ? AND request_id = ? ORDER BY created_at', [userId, requestId])[0]?.values || []);
  if (!completed[0]?.values.length) {
    const prefix = requestId + ':';
    const memories = db.exec('SELECT session_id, result_json FROM agent_memory_changes WHERE user_id = ? AND substr(change_id,1,?) = ? ORDER BY created_at',
      [userId, prefix.length, prefix])[0]?.values || [];
    receipts = [...receipts, ...memories.map(([sessionId, raw]) => {
      const receipt = JSON.parse(raw);
      return [receipt.inputHash || '', sessionId, JSON.stringify({
        answer: require('../../baiyu_agent/memory/receipts').memoryReceiptText(receipt),
        memoryReceipts: [receipt], suppressHistory: receipt.suppressHistory === true
          || (receipt.suppressHistory === undefined && receipt.changed > 0),
        actions: [], cards: [], intent: 'memory' })];
    })];
  }
  if (!receipts.length) return null;
  if (inputHash !== undefined && receipts.some(row => row[0] !== inputHash)) return { error: 'request_id_conflict' };
  const row = receipts[0];
  if (receipts.some(item => item[1] !== row[1])) return { error: 'request_id_conflict' };
  if (!getAgentSession(row[1], userId)) return { error: 'request_session_deleted' };
  flushDatabase(); // Recovery must only acknowledge results that are durable.
  const committed = Boolean(completed[0]?.values.length);
  if (committed) return { sessionId: row[1], committed, result: JSON.parse(row[2]) };
  const operations = receipts.map(item => JSON.parse(item[2]));
  return { sessionId: row[1], committed: false, result: {
    answer: operations.map(item => item.answer).filter(Boolean).join('\n') + '\n以上操作已经提交，其余查询或回答可能未完成。',
    actions: operations.flatMap(item => item.actions || []), cards: operations.at(-1)?.cards || [],
    memoryReceipts: operations.flatMap(item => item.memoryReceipts || []),
    suppressHistory: operations.some(item => item.suppressHistory),
    sources: [], suggestions: operations.at(-1)?.suggestions || [], fallback: true,
    intent: operations.at(-1)?.intent || ''
  } };
}

function getAgentCompactionMessages(sessionId, afterId, limit = 80) {
  const rows = db.exec('SELECT id, role, content, request_id FROM agent_messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
    [sessionId, Number(afterId) || 0, Math.max(1, Math.min(Number(limit) || 80, 512))]);
  return rows[0]?.values.map(row => rowToObj(rows[0].columns, row)) || [];
}

function commitAgentTurn(sessionId, userId, userContent, assistantContent, cards = [], summary = '', pendingAction = '', userMemorySummary = '', metadata = {}) {
  try {
    const owned = getAgentSession(sessionId, userId);
    if (!owned) return { error: 'not_found' };
    const now = Math.floor(Date.now() / 1000);
    db.run('BEGIN TRANSACTION');
    db.run(
      'INSERT INTO agent_messages (session_id, role, content, cards_json, created_at, request_id) VALUES (?, ?, ?, ?, ?, ?)',
      [sessionId, 'user', String(userContent || ''), '[]', now, metadata.requestId || '']
    );
    db.run(
      'INSERT INTO agent_messages (session_id, role, content, cards_json, created_at, request_id) VALUES (?, ?, ?, ?, ?, ?)',
      [sessionId, 'assistant', String(assistantContent || ''), JSON.stringify(cards || []), now, metadata.requestId || '']
    );
    if (metadata.suppressHistory) db.run('UPDATE agent_memory_control SET history_floor_id = MAX(history_floor_id, ?) WHERE user_id = ?', [Number(db.exec('SELECT last_insert_rowid()')[0].values[0][0]), userId]);
    // Summary and user memory have independent checkpoints. Never restore a run's old snapshots here.
    if (metadata.contextRevision != null && Number(metadata.contextRevision) !== Number(owned.context_revision)) throw new Error('CONTEXT_REVISION_CONFLICT');
    db.run('UPDATE agent_sessions SET pending_action = ?, state_json = ?, context_revision = context_revision + 1, updated_at = ? WHERE id = ? AND user_id = ?',
      [String(pendingAction || '').slice(0, 12000), JSON.stringify(metadata.sessionState || {}), now, sessionId, userId]);
    pruneAgentReceipts(now);
    if (metadata.requestId) db.run(`INSERT INTO agent_requests (user_id, request_id, input_hash, session_id, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`, [userId, metadata.requestId, metadata.inputHash, sessionId, JSON.stringify(Object.fromEntries(['answer', 'cards', 'sources', 'actions', 'memoryReceipts', 'suggestions', 'fallback', 'intent'].map(key => [key, metadata.result[key]]))), now]);
    db.run('COMMIT');
    scheduleSave();
    return { success: true };
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (_) {}
    console.error('[DB] commitAgentTurn error:', e.message);
    return { error: e.message };
  }
}

function getAgentMessages(sessionId, limit = 12) {
  try {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 4096));
    const rows = db.exec(
      `SELECT * FROM (
         SELECT * FROM agent_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`,
      [sessionId, safeLimit]
    );
    if (rows.length && rows[0].values.length) {
      return rows[0].values.map(v => rowToObj(rows[0].columns, v));
    }
  } catch (e) {
    console.error('[DB] getAgentMessages error:', e.message);
  }
  return [];
}

function getAgentMessageCount(sessionId) {
  try {
    const rows = db.exec('SELECT COUNT(*) AS count FROM agent_messages WHERE session_id = ?', [sessionId]);
    return Number(rows?.[0]?.values?.[0]?.[0]) || 0;
  } catch (e) {
    console.error('[DB] getAgentMessageCount error:', e.message);
    return 0;
  }
}

// ==================== Agent Telemetry ====================

function startAgentRun(run = {}) {
  try {
    const now = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT OR IGNORE INTO agent_runs
       (run_id, user_id, session_id, model, status, started_at, created_at,
        input_chars, page)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      [
        String(run.runId || '').slice(0, 160),
        run.userId ? Number(run.userId) : null,
        String(run.sessionId || '').slice(0, 160),
        String(run.model || '').slice(0, 160),
        Number(run.startedAt) || now,
        now,
        Math.max(0, Number(run.inputChars) || 0),
        String(run.page || '').slice(0, 160)
      ]
    );
    scheduleSave();
    return { success: true };
  } catch (e) {
    console.error('[DB] startAgentRun error:', e.message);
    return { error: e.message };
  }
}

function recordAgentModelRound(runId, round) {
  try {
    db.run(
      'UPDATE agent_runs SET rounds = MAX(rounds, ?) WHERE run_id = ?',
      [Math.max(1, Number(round) + 1), String(runId || '').slice(0, 160)]
    );
    return { success: true };
  } catch (e) {
    console.error('[DB] recordAgentModelRound error:', e.message);
    return { error: e.message };
  }
}

function recordAgentModelCall(runId, call = {}) {
  try {
    const id = String(runId || '').slice(0, 160);
    const inputTokens = Math.max(0, Number(call.inputTokens) || 0);
    const outputTokens = Math.max(0, Number(call.outputTokens) || 0);
    const totalTokens = Math.max(0, Number(call.totalTokens) || inputTokens + outputTokens);
    const nullableCounter = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    db.run(
      `INSERT INTO agent_model_calls
       (run_id, sequence, model, status, duration_ms, input_tokens, output_tokens,
        total_tokens, input_chars, output_chars, tools_available, error_code, created_at,
        purpose, cache_hit_tokens, cache_miss_tokens, first_token_ms, first_text_ms, tokens_estimated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        Math.max(1, Number(call.sequence) || 1),
        String(call.model || '').slice(0, 160),
        String(call.status || 'success').slice(0, 30),
        Math.max(0, Number(call.durationMs) || 0),
        inputTokens,
        outputTokens,
        totalTokens,
        Math.max(0, Number(call.inputChars) || 0),
        Math.max(0, Number(call.outputChars) || 0),
        Math.max(0, Number(call.toolsAvailable) || 0),
        String(call.errorCode || '').slice(0, 200),
        Math.floor(Date.now() / 1000),
        String(call.purpose || 'unknown').slice(0, 40),
        nullableCounter(call.cacheHitTokens),
        nullableCounter(call.cacheMissTokens),
        nullableCounter(call.firstTokenMs),
        nullableCounter(call.firstTextMs),
        call.tokensEstimated === false ? 0 : 1
      ]
    );
    db.run(
      `UPDATE agent_runs SET
       model_calls = model_calls + 1,
       input_tokens = input_tokens + ?,
       output_tokens = output_tokens + ?,
       total_tokens = total_tokens + ?
       WHERE run_id = ?`,
      [inputTokens, outputTokens, totalTokens, id]
    );
    scheduleSave();
    return { success: true };
  } catch (e) {
    console.error('[DB] recordAgentModelCall error:', e.message);
    return { error: e.message };
  }
}

function recordAgentToolCall(runId, call = {}) {
  try {
    const id = String(runId || '').slice(0, 160);
    const now = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT INTO agent_tool_calls
       (run_id, sequence, name, status, duration_ms, args_json, result_summary,
        error_code, policy_rejected, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        Math.max(1, Number(call.sequence) || 1),
        String(call.name || 'unknown').slice(0, 120),
        String(call.status || 'success').slice(0, 30),
        Math.max(0, Number(call.durationMs) || 0),
        String(call.argsJson || '{}').slice(0, 4000),
        String(call.resultSummary || '').slice(0, 1000),
        String(call.errorCode || '').slice(0, 200),
        call.policyRejected ? 1 : 0,
        now
      ]
    );
    db.run('UPDATE agent_runs SET tool_calls = tool_calls + 1 WHERE run_id = ?', [id]);
    scheduleSave();
    return { success: true };
  } catch (e) {
    console.error('[DB] recordAgentToolCall error:', e.message);
    return { error: e.message };
  }
}

function finishAgentRun(runId, result = {}) {
  try {
    const finishedAt = Math.floor(Date.now() / 1000);
    db.run(
      `UPDATE agent_runs SET
       status = ?, fallback = ?, finished_at = ?, duration_ms = ?,
       answer_chars = ?, cards_count = ?, sources_count = ?, error_code = ?
       WHERE run_id = ?`,
      [
        String(result.status || 'success').slice(0, 30),
        result.fallback ? 1 : 0,
        Number(result.finishedAt) || finishedAt,
        Math.max(0, Number(result.durationMs) || 0),
        Math.max(0, Number(result.answerChars) || 0),
        Math.max(0, Number(result.cardsCount) || 0),
        Math.max(0, Number(result.sourcesCount) || 0),
        String(result.errorCode || '').slice(0, 200),
        String(runId || '').slice(0, 160)
      ]
    );
    scheduleSave();
    return { success: true };
  } catch (e) {
    console.error('[DB] finishAgentRun error:', e.message);
    return { error: e.message };
  }
}

function addAgentAnswerFeedback(feedback = {}) {
  try {
    const runId = String(feedback.runId || '').slice(0, 160);
    if (!runId) return { error: 'missing_run_id' };
    db.run(
      `INSERT INTO agent_answer_feedback
       (run_id, user_id, session_id, rating, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        runId,
        feedback.userId ? Number(feedback.userId) : null,
        String(feedback.sessionId || '').slice(0, 160),
        String(feedback.rating || '').slice(0, 30),
        String(feedback.reason || '').slice(0, 300),
        Math.floor(Date.now() / 1000)
      ]
    );
    scheduleSave();
    return { success: true };
  } catch (e) {
    console.error('[DB] addAgentAnswerFeedback error:', e.message);
    return { error: e.message };
  }
}

function agentTelemetrySince(days = 7) {
  const safeDays = Math.max(1, Math.min(Number(days) || 7, 90));
  return Math.floor(Date.now() / 1000) - safeDays * 86400;
}

function getAgentAdminOverview(days = 7) {
  try {
    const since = agentTelemetrySince(days);
    const runRows = db.exec(
      `SELECT
         COUNT(*) AS requests,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
         SUM(CASE WHEN fallback = 1 THEN 1 ELSE 0 END) AS fallbacks,
         ROUND(AVG(CASE WHEN duration_ms > 0 THEN duration_ms END), 0) AS avg_latency_ms,
         ROUND(AVG(CASE WHEN rounds > 0 THEN rounds END), 2) AS avg_rounds,
         SUM(model_calls) AS model_calls,
         SUM(input_tokens) AS input_tokens,
         SUM(output_tokens) AS output_tokens,
         SUM(total_tokens) AS total_tokens,
         SUM(tool_calls) AS tool_calls,
         SUM(cards_count) AS recommendations
       FROM agent_runs WHERE started_at >= ?`,
      [since]
    );
    const feedbackRows = db.exec(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN rating IN ('like', 'resolved') THEN 1 ELSE 0 END) AS positive,
         SUM(CASE WHEN rating IN ('dislike', 'unresolved') THEN 1 ELSE 0 END) AS negative
       FROM agent_answer_feedback WHERE created_at >= ?`,
      [since]
    );
    const recommendationRows = db.exec(
      `SELECT
         SUM(CASE WHEN event_type = 'recommend_impression' THEN 1 ELSE 0 END) AS impressions,
         SUM(CASE WHEN event_type = 'recommend_click' THEN 1 ELSE 0 END) AS clicks,
         SUM(CASE WHEN event_type = 'detail_view' THEN 1 ELSE 0 END) AS detail_views,
         SUM(CASE WHEN event_type = 'play_start' THEN 1 ELSE 0 END) AS plays,
         SUM(CASE WHEN event_type = 'favorite' THEN 1 ELSE 0 END) AS favorites,
         SUM(CASE WHEN event_type = 'not_interested' THEN 1 ELSE 0 END) AS not_interested
       FROM user_anime_events
       WHERE created_at >= ? AND event_type IN
         ('recommend_impression', 'recommend_click', 'detail_view', 'play_start', 'favorite', 'not_interested')`,
      [since]
    );
    const row = runRows?.[0]?.values?.[0] || [];
    const feedback = feedbackRows?.[0]?.values?.[0] || [];
    const recommendations = recommendationRows?.[0]?.values?.[0] || [];
    const overview = rowToObj(runRows?.[0]?.columns || [], row);
    const answerFeedback = rowToObj(feedbackRows?.[0]?.columns || [], feedback);
    const recommendation = rowToObj(recommendationRows?.[0]?.columns || [], recommendations);
    const statusRows = db.exec(
      `SELECT status, COUNT(*) AS count FROM agent_runs WHERE started_at >= ? GROUP BY status`,
      [since]
    );
    const statusBreakdown = {};
    if (statusRows.length) {
      for (const value of statusRows[0].values) {
        const item = rowToObj(statusRows[0].columns, value);
        statusBreakdown[item.status || 'unknown'] = Number(item.count) || 0;
      }
    }
    return {
      days: Math.max(1, Math.min(Number(days) || 7, 90)),
      overview: {
        requests: Number(overview.requests) || 0,
        successes: Number(overview.successes) || 0,
        errors: Number(overview.errors) || 0,
        fallbacks: Number(overview.fallbacks) || 0,
        avgLatencyMs: Number(overview.avg_latency_ms) || 0,
        avgRounds: Number(overview.avg_rounds) || 0,
        modelCalls: Number(overview.model_calls) || 0,
        inputTokens: Number(overview.input_tokens) || 0,
        outputTokens: Number(overview.output_tokens) || 0,
        totalTokens: Number(overview.total_tokens) || 0,
        toolCalls: Number(overview.tool_calls) || 0,
        recommendations: Number(overview.recommendations) || 0
      },
      answerFeedback: {
        total: Number(answerFeedback.total) || 0,
        positive: Number(answerFeedback.positive) || 0,
        negative: Number(answerFeedback.negative) || 0
      },
      recommendation: {
        impressions: Number(recommendation.impressions) || 0,
        clicks: Number(recommendation.clicks) || 0,
        detailViews: Number(recommendation.detail_views) || 0,
        plays: Number(recommendation.plays) || 0,
        favorites: Number(recommendation.favorites) || 0,
        notInterested: Number(recommendation.not_interested) || 0
      },
      statusBreakdown
    };
  } catch (e) {
    console.error('[DB] getAgentAdminOverview error:', e.message);
    return { days: Number(days) || 7, overview: {}, answerFeedback: {}, recommendation: {}, error: e.message };
  }
}

function getAgentAdminModelUsage(days = 7) {
  try {
    const since = agentTelemetrySince(days);
    const cacheColumns = `COUNT(CASE WHEN cache_hit_tokens IS NOT NULL AND cache_miss_tokens IS NOT NULL THEN 1 END) AS cache_measured_calls,
      SUM(CASE WHEN cache_miss_tokens IS NOT NULL THEN cache_hit_tokens END) AS cache_hit_tokens,
      SUM(CASE WHEN cache_hit_tokens IS NOT NULL THEN cache_miss_tokens END) AS cache_miss_tokens,
      SUM(tokens_estimated) AS estimated_calls,
      ROUND(AVG(first_token_ms), 0) AS avg_first_token_ms,
      ROUND(AVG(first_text_ms), 0) AS avg_first_text_ms`;
    const cacheMetrics = item => {
      const measured = Number(item.cache_measured_calls) || 0;
      const hit = measured ? Number(item.cache_hit_tokens) || 0 : null;
      const miss = measured ? Number(item.cache_miss_tokens) || 0 : null;
      return { cacheMeasuredCalls: measured, cacheHitTokens: hit, cacheMissTokens: miss,
        cacheHitRatio: measured && hit + miss > 0 ? hit / (hit + miss) : null,
        estimatedCalls: Number(item.estimated_calls) || 0,
        avgFirstTokenMs: item.avg_first_token_ms ?? null, avgFirstTextMs: item.avg_first_text_ms ?? null };
    };
    const rows = db.exec(
      `SELECT model, COUNT(*) AS calls,
              COUNT(DISTINCT run_id) AS runs,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
              SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS errors,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(total_tokens) AS total_tokens,
              ROUND(AVG(duration_ms), 0) AS avg_duration_ms, ${cacheColumns}
       FROM agent_model_calls WHERE created_at >= ?
       GROUP BY model ORDER BY calls DESC`,
      [since]
    );
    if (!rows.length) return [];
    const stageRows = db.exec(`SELECT model, purpose, COUNT(*) AS calls,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
      ROUND(AVG(duration_ms), 0) AS avg_duration_ms, ${cacheColumns}
      FROM agent_model_calls WHERE created_at >= ? GROUP BY model, purpose ORDER BY model, purpose`, [since]);
    const stages = new Map();
    for (const value of stageRows[0]?.values || []) {
      const item = rowToObj(stageRows[0].columns, value);
      if (!stages.has(item.model)) stages.set(item.model, []);
      stages.get(item.model).push({ purpose: item.purpose, calls: Number(item.calls) || 0,
        inputTokens: Number(item.input_tokens) || 0, outputTokens: Number(item.output_tokens) || 0,
        avgDurationMs: Number(item.avg_duration_ms) || 0, ...cacheMetrics(item) });
    }
    return rows[0].values.map(value => {
      const item = rowToObj(rows[0].columns, value);
      return {
        model: item.model || 'unknown',
        calls: Number(item.calls) || 0,
        runs: Number(item.runs) || 0,
        successes: Number(item.successes) || 0,
        errors: Number(item.errors) || 0,
        inputTokens: Number(item.input_tokens) || 0,
        outputTokens: Number(item.output_tokens) || 0,
        totalTokens: Number(item.total_tokens) || 0,
        avgDurationMs: Number(item.avg_duration_ms) || 0,
        ...cacheMetrics(item), stages: stages.get(item.model) || []
      };
    });
  } catch (e) {
    console.error('[DB] getAgentAdminModelUsage error:', e.message);
    return [];
  }
}

function getAgentAdminTrend(days = 7) {
  try {
    const since = agentTelemetrySince(days);
    const rows = db.exec(
      `SELECT strftime('%Y-%m-%d', started_at, 'unixepoch') AS day,
              COUNT(*) AS requests,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
              ROUND(AVG(CASE WHEN duration_ms > 0 THEN duration_ms END), 0) AS avg_latency_ms
       FROM agent_runs WHERE started_at >= ? GROUP BY day ORDER BY day ASC`,
      [since]
    );
    if (!rows.length) return [];
    return rows[0].values.map(value => {
      const item = rowToObj(rows[0].columns, value);
      return { day: item.day, requests: Number(item.requests) || 0, successes: Number(item.successes) || 0, errors: Number(item.errors) || 0, avgLatencyMs: Number(item.avg_latency_ms) || 0 };
    });
  } catch (e) {
    console.error('[DB] getAgentAdminTrend error:', e.message);
    return [];
  }
}

function getAgentAdminToolUsage(days = 7) {
  try {
    const since = agentTelemetrySince(days);
    const rows = db.exec(
      `SELECT name, COUNT(*) AS calls,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
              SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS errors,
              ROUND(AVG(duration_ms), 0) AS avg_duration_ms
       FROM agent_tool_calls WHERE created_at >= ? GROUP BY name ORDER BY calls DESC`,
      [since]
    );
    if (!rows.length) return [];
    return rows[0].values.map(value => {
      const item = rowToObj(rows[0].columns, value);
      return { name: item.name, calls: Number(item.calls) || 0, successes: Number(item.successes) || 0, errors: Number(item.errors) || 0, avgDurationMs: Number(item.avg_duration_ms) || 0 };
    });
  } catch (e) {
    console.error('[DB] getAgentAdminToolUsage error:', e.message);
    return [];
  }
}

function getAgentAdminRuns({ days = 7, limit = 50, offset = 0 } = {}) {
  try {
    const since = agentTelemetrySince(days);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const rows = db.exec(
      `SELECT r.run_id, r.user_id, u.username, r.session_id, r.model, r.status,
              r.fallback, r.started_at, r.finished_at, r.duration_ms, r.rounds,
              r.tool_calls, r.model_calls, r.input_tokens, r.output_tokens,
              r.total_tokens, r.input_chars, r.answer_chars, r.cards_count,
              r.sources_count, r.page, r.error_code
       FROM agent_runs r LEFT JOIN users u ON u.id = r.user_id
       WHERE r.started_at >= ? ORDER BY r.started_at DESC LIMIT ? OFFSET ?`,
      [since, safeLimit, safeOffset]
    );
    if (!rows.length) return [];
    return rows[0].values.map(value => rowToObj(rows[0].columns, value));
  } catch (e) {
    console.error('[DB] getAgentAdminRuns error:', e.message);
    return [];
  }
}

function getAgentAdminRun(runId) {
  try {
    const runRows = db.exec(
      `SELECT r.*, u.username FROM agent_runs r LEFT JOIN users u ON u.id = r.user_id WHERE r.run_id = ? LIMIT 1`,
      [String(runId || '').slice(0, 160)]
    );
    if (!runRows.length || !runRows[0].values.length) return null;
    const toolRows = db.exec(
      'SELECT * FROM agent_tool_calls WHERE run_id = ? ORDER BY sequence ASC, id ASC',
      [String(runId || '').slice(0, 160)]
    );
    const modelRows = db.exec(
      'SELECT * FROM agent_model_calls WHERE run_id = ? ORDER BY sequence ASC, id ASC',
      [String(runId || '').slice(0, 160)]
    );
    const feedbackRows = db.exec(
      'SELECT id, rating, reason, created_at FROM agent_answer_feedback WHERE run_id = ? ORDER BY created_at DESC',
      [String(runId || '').slice(0, 160)]
    );
    const run = rowToObj(runRows[0].columns, runRows[0].values[0]);
    return {
      ...run,
      models: modelRows.length ? modelRows[0].values.map(value => rowToObj(modelRows[0].columns, value)) : [],
      tools: toolRows.length ? toolRows[0].values.map(value => rowToObj(toolRows[0].columns, value)) : [],
      feedback: feedbackRows.length ? feedbackRows[0].values.map(value => rowToObj(feedbackRows[0].columns, value)) : []
    };
  } catch (e) {
    console.error('[DB] getAgentAdminRun error:', e.message);
    return null;
  }
}

function deleteAgentSession(id, userId) {
  try {
    const owned = getAgentSession(id, userId);
    if (!owned) return { error: 'not_found' };
    db.run('BEGIN TRANSACTION');
    agentContext.purgeAgentContext(userId, id);
    db.run('DELETE FROM agent_sessions WHERE id = ? AND user_id = ?', [id, userId]);
    db.run('COMMIT');
    scheduleSave();
    return { success: true };
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (_) {}
    console.error('[DB] deleteAgentSession error:', e.message);
    return { error: e.message };
  }
}

function addUserAnimeEvent(userId, event) {
  try {
    const now = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT INTO user_anime_events
       (user_id, anilist_id, event_type, value, context, agent_run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, Number(event.anilist_id) || 0, event.event_type, Number(event.value) || 1,
       String(event.context || '').slice(0, 500), String(event.agent_run_id || '').slice(0, 160), now]
    );
    scheduleSave();
    return { success: true };
  } catch (e) {
    console.error('[DB] addUserAnimeEvent error:', e.message);
    return { error: e.message };
  }
}

function getUserAnimeEvents(userId, limit = 200) {
  try {
    const rows = db.exec(
      'SELECT * FROM user_anime_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      [userId, Math.max(1, Math.min(Number(limit) || 200, 500))]
    );
    if (rows.length && rows[0].values.length) {
      return rows[0].values.map(v => rowToObj(rows[0].columns, v));
    }
  } catch (e) {
    console.error('[DB] getUserAnimeEvents error:', e.message);
  }
  return [];
}

function addRecommendationFeedback(userId, feedback) {
  try {
    const now = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT INTO recommendation_feedback
       (user_id, anilist_id, action, reason, agent_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, Number(feedback.anilist_id) || 0, feedback.action,
       String(feedback.reason || '').slice(0, 200), String(feedback.agent_run_id || '').slice(0, 160), now]
    );
    scheduleSave();
    return { success: true };
  } catch (e) {
    console.error('[DB] addRecommendationFeedback error:', e.message);
    return { error: e.message };
  }
}

function getRecommendationFeedback(userId, limit = 200) {
  try {
    const rows = db.exec(
      'SELECT * FROM recommendation_feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      [userId, Math.max(1, Math.min(Number(limit) || 200, 500))]
    );
    if (rows.length && rows[0].values.length) {
      return rows[0].values.map(v => rowToObj(rows[0].columns, v));
    }
  } catch (e) {
    console.error('[DB] getRecommendationFeedback error:', e.message);
  }
  return [];
}

// Hard exclusions cover the complete owner-scoped library, independently of
// the bounded, time-decayed sample used for learning recommendation affinity.
function getRecommendationExclusions(userId) {
  const rows = (sql, params) => {
    const result = db.exec(sql, params)[0];
    return result?.values.map(row => rowToObj(result.columns, row)) || [];
  };
  const library = rows(`SELECT anime_id,anilist_id,anime_msg,anime_n FROM favorites WHERE user_id = ?
    UNION SELECT anime_id,anilist_id,anime_msg,anime_n FROM watch_history WHERE user_id = ?`, [userId, userId]);
  const watchedIds = library.map(row => Number(row.anilist_id)
    || Number(/^anilist_(\d+)$/.exec(row.anime_id)?.[1])
    || resolveAnimeKey(db, userId, row).anilist_id).filter(id => id > 0);
  const negatives = rows(`SELECT anilist_id,action FROM recommendation_feedback WHERE user_id = ?
    AND action IN ('not_interested','dislike','already_watched')
    UNION SELECT anilist_id,'not_interested' AS action FROM user_anime_events WHERE user_id = ? AND event_type = 'not_interested'`, [userId, userId]);
  return { watchedIds: [...new Set(watchedIds)],
    dislikedIds: [...new Set(negatives.map(row => Number(row.anilist_id)).filter(id => id > 0))],
    alreadyWatchedIds: [...new Set(negatives.filter(row => row.action === 'already_watched').map(row => Number(row.anilist_id)).filter(id => id > 0))] };
}

function createEpisodeCommentNotification({
  recipientUserId,
  actorUserId,
  commentId,
  targetCommentId,
  type,
  createdAt = Math.floor(Date.now() / 1000)
}) {
  if (!recipientUserId || Number(recipientUserId) === Number(actorUserId)) return;
  db.run(
    `INSERT OR IGNORE INTO episode_comment_notifications
     (recipient_user_id, actor_user_id, comment_id, target_comment_id, type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [recipientUserId, actorUserId, commentId, targetCommentId, type, createdAt]
  );
}

function addEpisodeComment(userId, comment) {
  try {
    const animeId = String(comment.anime_id || '').trim();
    const episodeNumber = String(comment.episode_number || '').trim();
    const content = String(comment.content || '').trim();
    const rawParentId = comment.parent_id;
    const parentId = rawParentId === undefined || rawParentId === null ||
      String(rawParentId).trim() === '' ? null : Number(rawParentId);
    let parent = null;
    if (!animeId || !episodeNumber || !content) {
      return { error: 'missing_fields' };
    }
    if (parentId !== null && (!Number.isInteger(parentId) || parentId <= 0)) {
      return { error: 'invalid_parent' };
    }
    if (parentId !== null) {
      const parentRows = db.exec(
        `SELECT anime_id, episode_number, parent_id, root_id, deleted_at, user_id
         FROM episode_comments
         WHERE id = ?
         LIMIT 1`,
        [parentId]
      );
      if (!parentRows.length || !parentRows[0].values.length) {
        return { error: 'parent_not_found' };
      }
      parent = rowToObj(parentRows[0].columns, parentRows[0].values[0]);
      if (parent.anime_id !== animeId || parent.episode_number !== episodeNumber) {
        return { error: 'parent_mismatch' };
      }
      if (parent.deleted_at !== null && parent.deleted_at !== undefined) {
        return { error: 'parent_deleted' };
      }
    }
    const now = Math.floor(Date.now() / 1000);
    const rootId = parentId === null
      ? null
      : (parent.root_id === null || parent.root_id === undefined
        ? parentId
        : Number(parent.root_id));
    db.run(
      `INSERT INTO episode_comments
       (user_id, anime_id, anime_title, episode_number, content, parent_id, root_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        animeId.slice(0, 120),
        String(comment.anime_title || '').slice(0, 200),
        episodeNumber.slice(0, 40),
        content.slice(0, 1000),
        parentId,
        rootId,
        now
      ]
    );
    const commentId = getLastInsertId();
    if (parentId !== null) {
      createEpisodeCommentNotification({
        recipientUserId: parent.user_id,
        actorUserId: userId,
        commentId,
        targetCommentId: parentId,
        type: 'reply',
        createdAt: now
      });
    }
    scheduleSave();
    return { success: true, id: commentId };
  } catch (e) {
    console.error('[DB] addEpisodeComment error:', e.message);
    return { error: e.message };
  }
}

function getEpisodeCommentReactionSummary(commentId, userId = null) {
  const rows = db.exec(
    `SELECT
       COALESCE(SUM(CASE WHEN reaction = 1 THEN 1 ELSE 0 END), 0) AS likes,
       COALESCE(SUM(CASE WHEN reaction = -1 THEN 1 ELSE 0 END), 0) AS dislikes,
       COALESCE(MAX(CASE WHEN user_id = ? THEN reaction ELSE 0 END), 0) AS my_reaction
     FROM episode_comment_reactions
     WHERE comment_id = ?`,
    [userId || 0, commentId]
  );
  if (!rows.length || !rows[0].values.length) {
    return { likes: 0, dislikes: 0, my_reaction: 0 };
  }
  const row = rowToObj(rows[0].columns, rows[0].values[0]);
  return {
    likes: Number(row.likes) || 0,
    dislikes: Number(row.dislikes) || 0,
    my_reaction: Number(row.my_reaction) || 0
  };
}

function getEpisodeCommentReactionSummaries(commentIds, userId = null) {
  const summaries = new Map();
  if (!commentIds.length) return summaries;
  const placeholders = commentIds.map(() => '?').join(',');
  const rows = db.exec(
    `SELECT comment_id,
       COALESCE(SUM(CASE WHEN reaction = 1 THEN 1 ELSE 0 END), 0) AS likes,
       COALESCE(SUM(CASE WHEN reaction = -1 THEN 1 ELSE 0 END), 0) AS dislikes,
       COALESCE(MAX(CASE WHEN user_id = ? THEN reaction ELSE 0 END), 0) AS my_reaction
     FROM episode_comment_reactions
     WHERE comment_id IN (${placeholders})
     GROUP BY comment_id`,
    [userId || 0, ...commentIds]
  );
  if (!rows.length) return summaries;
  for (const value of rows[0].values) {
    const row = rowToObj(rows[0].columns, value);
    summaries.set(Number(row.comment_id), {
      likes: Number(row.likes) || 0,
      dislikes: Number(row.dislikes) || 0,
      my_reaction: Number(row.my_reaction) || 0
    });
  }
  return summaries;
}

function enrichEpisodeCommentRows(rows, summaries) {
  return rows.map(row => ({
    ...row,
    like_count: summaries.get(Number(row.id))?.likes || 0,
    dislike_count: summaries.get(Number(row.id))?.dislikes || 0,
    my_reaction: summaries.get(Number(row.id))?.my_reaction || 0
  }));
}

function getEpisodeComments(animeId, episodeNumber, limit = 80, userId = null) {
  try {
    const normalizedAnimeId = String(animeId || '').trim();
    const normalizedEpisodeNumber = String(episodeNumber || '').trim();
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 80, 200));
    const rootRows = db.exec(
      `SELECT c.id, c.user_id, c.anime_id, c.anime_title, c.episode_number,
              c.content, c.parent_id, c.root_id, c.deleted_at, c.created_at,
              (SELECT COUNT(*) FROM episode_comments r
               WHERE r.root_id = c.id AND r.deleted_at IS NULL) AS reply_count,
              u.username, u.avatar
       FROM episode_comments c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.anime_id = ? AND c.episode_number = ? AND c.parent_id IS NULL
         AND c.deleted_at IS NULL
       ORDER BY c.created_at DESC
       LIMIT ?`,
      [
        normalizedAnimeId,
        normalizedEpisodeNumber,
        boundedLimit
      ]
    );
    if (!rootRows.length || !rootRows[0].values.length) return [];

    const roots = rootRows[0].values.map(v => rowToObj(rootRows[0].columns, v));
    const rootIds = roots.map(row => Number(row.id));
    const allRows = roots;
    const summaries = getEpisodeCommentReactionSummaries(
      allRows.map(row => Number(row.id)),
      userId
    );
    const enrichedRoots = enrichEpisodeCommentRows(roots, summaries);
    return enrichedRoots.map(root => ({
      ...root,
      replies: []
    }));
  } catch (e) {
    console.error('[DB] getEpisodeComments error:', e.message);
  }
  return [];
}

function getEpisodeCommentReplies(rootCommentId, page = 1, limit = 10, userId = null) {
  try {
    const normalizedRootId = Number(rootCommentId);
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 10, 10));
    const rootRows = db.exec(
      `SELECT id FROM episode_comments
       WHERE id = ? AND parent_id IS NULL AND deleted_at IS NULL LIMIT 1`,
      [normalizedRootId]
    );
    if (!rootRows.length || !rootRows[0].values.length) {
      return { error: 'comment_not_found', results: [], page: 1, total: 0, total_pages: 0 };
    }
    const countRows = db.exec(
      `SELECT COUNT(*) AS total FROM episode_comments
       WHERE root_id = ? AND deleted_at IS NULL`,
      [normalizedRootId]
    );
    const total = countRows.length ? Number(countRows[0].values[0][0]) || 0 : 0;
    const totalPages = Math.max(1, Math.ceil(total / boundedLimit));
    const normalizedPage = Math.max(1, Math.min(Number(page) || 1, totalPages));
    const offset = (normalizedPage - 1) * boundedLimit;
    const rows = db.exec(
      `SELECT c.id, c.user_id, c.anime_id, c.anime_title, c.episode_number,
              c.content, c.parent_id, c.root_id, c.deleted_at, c.created_at,
              u.username, u.avatar
       FROM episode_comments c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.root_id = ? AND c.deleted_at IS NULL
       ORDER BY c.created_at ASC
       LIMIT ? OFFSET ?`,
      [normalizedRootId, boundedLimit, offset]
    );
    const replies = rows.length && rows[0].values.length
      ? rows[0].values.map(v => rowToObj(rows[0].columns, v))
      : [];
    const enrichedReplies = enrichEpisodeCommentRows(
      replies,
      getEpisodeCommentReactionSummaries(replies.map(row => Number(row.id)), userId)
    );
    return {
      results: enrichedReplies,
      page: normalizedPage,
      total,
      total_pages: totalPages
    };
  } catch (e) {
    console.error('[DB] getEpisodeCommentReplies error:', e.message);
    return { error: e.message, results: [], page: 1, total: 0, total_pages: 0 };
  }
}

function deleteEpisodeComment(userId, commentId) {
  try {
    const normalizedCommentId = Number(commentId);
    if (!Number.isInteger(normalizedCommentId) || normalizedCommentId <= 0) {
      return { error: 'invalid_comment' };
    }
    const rows = db.exec(
      `SELECT id, user_id, deleted_at
       FROM episode_comments WHERE id = ? LIMIT 1`,
      [normalizedCommentId]
    );
    if (!rows.length || !rows[0].values.length) {
      return { error: 'comment_not_found' };
    }
    const comment = rowToObj(rows[0].columns, rows[0].values[0]);
    if (Number(comment.user_id) !== Number(userId)) {
      return { error: 'comment_forbidden' };
    }
    if (comment.deleted_at !== null && comment.deleted_at !== undefined) {
      return { success: true, already_deleted: true };
    }
    const deletedAt = Math.floor(Date.now() / 1000);
    db.run(
      `UPDATE episode_comments
       SET content = '', deleted_at = ?
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      [deletedAt, normalizedCommentId, userId]
    );
    scheduleSave();
    return { success: true, deleted_at: deletedAt };
  } catch (e) {
    console.error('[DB] deleteEpisodeComment error:', e.message);
    return { error: e.message };
  }
}

function setEpisodeCommentReaction(userId, commentId, reaction) {
  try {
    const normalizedCommentId = Number(commentId);
    const normalizedReaction = Number(reaction);
    if (!Number.isInteger(normalizedCommentId) || normalizedCommentId <= 0) {
      return { error: 'invalid_comment' };
    }
    if (![ -1, 0, 1 ].includes(normalizedReaction)) {
      return { error: 'invalid_reaction' };
    }
    const commentRows = db.exec(
      'SELECT id, user_id, deleted_at FROM episode_comments WHERE id = ? LIMIT 1',
      [normalizedCommentId]
    );
    if (!commentRows.length || !commentRows[0].values.length) {
      return { error: 'comment_not_found' };
    }
    const targetComment = rowToObj(
      commentRows[0].columns,
      commentRows[0].values[0]
    );
    if (targetComment.deleted_at !== null && targetComment.deleted_at !== undefined) {
      return { error: 'comment_deleted' };
    }

    const existingRows = db.exec(
      `SELECT reaction FROM episode_comment_reactions
       WHERE comment_id = ? AND user_id = ? LIMIT 1`,
      [normalizedCommentId, userId]
    );
    const hasExisting = existingRows.length && existingRows[0].values.length;
    if (normalizedReaction === 0) {
      if (hasExisting) {
        db.run(
          'DELETE FROM episode_comment_reactions WHERE comment_id = ? AND user_id = ?',
          [normalizedCommentId, userId]
        );
      }
    } else if (hasExisting) {
      db.run(
        `UPDATE episode_comment_reactions
         SET reaction = ?, created_at = ?
         WHERE comment_id = ? AND user_id = ?`,
        [normalizedReaction, Math.floor(Date.now() / 1000), normalizedCommentId, userId]
      );
    } else {
      db.run(
        `INSERT INTO episode_comment_reactions
         (comment_id, user_id, reaction, created_at)
         VALUES (?, ?, ?, ?)`,
        [normalizedCommentId, userId, normalizedReaction, Math.floor(Date.now() / 1000)]
      );
    }
    db.run(
      `DELETE FROM episode_comment_notifications
       WHERE recipient_user_id = ? AND actor_user_id = ?
         AND comment_id = ? AND type = 'like'`,
      [targetComment.user_id, userId, normalizedCommentId]
    );
    if (normalizedReaction === 1 && Number(targetComment.user_id) !== Number(userId)) {
      createEpisodeCommentNotification({
        recipientUserId: targetComment.user_id,
        actorUserId: userId,
        commentId: normalizedCommentId,
        targetCommentId: normalizedCommentId,
        type: 'like'
      });
    }
    scheduleSave();
    return {
      success: true,
      comment_id: normalizedCommentId,
      ...getEpisodeCommentReactionSummary(normalizedCommentId, userId)
    };
  } catch (e) {
    console.error('[DB] setEpisodeCommentReaction error:', e.message);
    return { error: e.message };
  }
}

function getEpisodeCommentNotifications(userId, type = 'all', limit = 100) {
  try {
    // Backfill interactions created before the notification table was added.
    db.run(
      `INSERT OR IGNORE INTO episode_comment_notifications
       (recipient_user_id, actor_user_id, comment_id, target_comment_id, type, created_at)
       SELECT c.user_id, r.user_id, r.comment_id, r.comment_id, 'like', r.created_at
       FROM episode_comment_reactions r
       JOIN episode_comments c ON c.id = r.comment_id
       WHERE r.reaction = 1 AND c.user_id <> r.user_id
         AND c.deleted_at IS NULL`
    );
    db.run(
      `INSERT OR IGNORE INTO episode_comment_notifications
       (recipient_user_id, actor_user_id, comment_id, target_comment_id, type, created_at)
       SELECT parent.user_id, reply.user_id, reply.id, parent.id, 'reply', reply.created_at
       FROM episode_comments reply
       JOIN episode_comments parent ON parent.id = reply.parent_id
       WHERE parent.user_id <> reply.user_id
         AND parent.deleted_at IS NULL AND reply.deleted_at IS NULL`
    );
    scheduleSave();
    const normalizedType = ['all', 'like', 'reply'].includes(type) ? type : 'all';
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
    const typeClause = normalizedType === 'all' ? '' : 'AND n.type = ?';
    const queryArgs = normalizedType === 'all'
      ? [userId, boundedLimit]
      : [userId, normalizedType, boundedLimit];
    const rows = db.exec(
      `SELECT n.id, n.type, n.comment_id, n.target_comment_id,
              n.created_at, n.read_at,
              actor.id AS actor_id, actor.username AS actor_username,
              actor.avatar AS actor_avatar,
              target.content AS target_content,
              target.deleted_at AS target_deleted_at,
              target.anime_id, target.anime_title, target.episode_number,
              event.content AS event_content,
              event.deleted_at AS event_deleted_at
       FROM episode_comment_notifications n
       JOIN users actor ON actor.id = n.actor_user_id
       JOIN episode_comments target ON target.id = n.target_comment_id
       LEFT JOIN episode_comments event ON event.id = n.comment_id
       WHERE n.recipient_user_id = ?
         ${typeClause}
         AND target.deleted_at IS NULL
         AND (n.type = 'like' OR event.deleted_at IS NULL)
       ORDER BY n.created_at DESC
       LIMIT ?`,
      queryArgs
    );
    const results = rows.length && rows[0].values.length
      ? rows[0].values.map(v => rowToObj(rows[0].columns, v))
      : [];
    const unreadRows = db.exec(
      `SELECT COUNT(*) AS unread_count
       FROM episode_comment_notifications n
       JOIN episode_comments target ON target.id = n.target_comment_id
       LEFT JOIN episode_comments event ON event.id = n.comment_id
       WHERE n.recipient_user_id = ?
         ${typeClause}
         AND n.read_at IS NULL
         AND target.deleted_at IS NULL
         AND (n.type = 'like' OR event.deleted_at IS NULL)`,
      normalizedType === 'all' ? [userId] : [userId, normalizedType]
    );
    const unreadCount = unreadRows.length && unreadRows[0].values.length
      ? Number(unreadRows[0].values[0][0]) || 0
      : 0;
    return { results, unreadCount };
  } catch (e) {
    console.error('[DB] getEpisodeCommentNotifications error:', e.message);
    return { results: [], unreadCount: 0 };
  }
}

function markEpisodeCommentNotificationsRead(userId, type = 'all') {
  try {
    const normalizedType = ['all', 'like', 'reply'].includes(type) ? type : 'all';
    const typeClause = normalizedType === 'all' ? '' : ' AND type = ?';
    const args = normalizedType === 'all'
      ? [Math.floor(Date.now() / 1000), userId]
      : [Math.floor(Date.now() / 1000), userId, normalizedType];
    db.run(
      `UPDATE episode_comment_notifications
       SET read_at = ?
       WHERE read_at IS NULL AND recipient_user_id = ?${typeClause}`,
      args
    );
    scheduleSave();
    return { success: true };
  } catch (e) {
    console.error('[DB] markEpisodeCommentNotificationsRead error:', e.message);
    return { error: e.message };
  }
}

const agentContext = createAgentContextRepository({ getDb: () => db, scheduleSave, flushDatabase, getAgentSession });
const authentication = createAuthenticationRepository({ getDb: () => db, scheduleSave, flushDatabase });
const catalogSearch = createCatalogSearchRepository({ getDb: () => db });

module.exports = {
  ...agentContext,
  ...authentication,
  ...catalogSearch,
  initDatabase,
  saveToFile,
  flushDatabase,
  closeDatabase,
  // Users
  createUser,
  getUserByEmail,
  getUserById,
  updateUserProfile,
  updatePassword,
  // Verification
  saveVerificationCode,
  // Favorites
  getFavorites,
  addFavorite,
  removeFavorite,
  isFavorited,
  clearFavorites,
  // History
  getHistory,
  getAgentUserLibrary,
  saveHistory,
  getHistoryProgress,
  removeHistory,
  clearHistory,
  // Anime Meta
  upsertAnimeMeta,
  upsertAnimeMetaBatch,
  getAnimeMetaById,
  getAdminAnimePage,
  updateAnimeMetaByAdmin,
  getAnimeMetaEditHistory,
  updateAnimeAiringState,
  getAnimeMetaBySeason,
  getRankingsFromDb,
  getAiringScheduleFromDb,
  getAgentAiringSchedule,
  getBrowseFromDb,
  getRecentMoviesFromDb,
  searchAnimeMetaByTitle,
  searchAnimeMetaByAnyTitle,
  getAnimeMetaCount,
  getAnimeMetaWithOiMsg,
  getAnimeMetaWithOiMsgCount,
  getAnimeMetaMissingOi,
  updateAnimeOiMsg,
  updateAnimeTitleAndOiMsg,
  clearAnimeMeta,
  batchGetChineseTitles,
  // Vector RAG
  queueAnimeForRag,
  getAnimeMetaForRag,
  getPendingRagAnime,
  completePendingRagAnime,
  getRagQueueGeneration,
  prepareRagIndexWrite,
  getRagChunkPage,
  getRagChunksByAnime,
  replaceAnimeRagChunks,
  upsertRagChunks,
  getRagChunks,
  clearRagIndex,
  deleteExpiredExternalRagChunks,
  getRagIndexStats,
  getRagIndexVersion,
  // Anime Agent
  createAgentSession,
  getAgentSession,
  getAgentSessions,
  getAgentMemorySummaries,
  getAgentUserMemory,
  updateAgentUserMemory,
  clearAgentMemory,
  clearAgentSessionMemory,
  updateAgentSessionSummary,
  updateAgentSessionPendingAction,
  addAgentMessage,
  commitAgentTurn,
  executeAgentOperation,
  getAgentRequestResult,
  getAgentCompactionMessages,
  getAgentMessages,
  getAgentMessageCount,
  startAgentRun,
  recordAgentModelRound,
  recordAgentModelCall,
  recordAgentToolCall,
  finishAgentRun,
  addAgentAnswerFeedback,
  getAgentAdminOverview,
  getAgentAdminTrend,
  getAgentAdminToolUsage,
  getAgentAdminModelUsage,
  getAgentAdminRuns,
  getAgentAdminRun,
  deleteAgentSession,
  addUserAnimeEvent,
  getUserAnimeEvents,
  addRecommendationFeedback,
  getRecommendationFeedback,
  getRecommendationExclusions,
  addEpisodeComment,
  getEpisodeComments,
  getEpisodeCommentReplies,
  setEpisodeCommentReaction,
  deleteEpisodeComment,
  getEpisodeCommentNotifications,
  markEpisodeCommentNotificationsRead
};
