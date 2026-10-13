function queryRows(db, sql, args = []) {
  const result = db.exec(sql, args)[0];
  return result ? result.values.map(values => Object.fromEntries(result.columns.map((key, i) => [key, values[i]]))) : [];
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function resolveAnimeKey(db, userId, input) {
  const record = typeof input === 'string' ? { anime_id: input } : input;
  const original = String(record.anime_id || '').trim();
  let id = positiveId(record.anilist_id) || positiveId(/^anilist_(\d+)$/.exec(original)?.[1]);
  if (!id && record.anime_msg) {
    const matches = queryRows(db, 'SELECT anilist_id FROM anime_meta WHERE oi_msg = ? AND oi_index = ?',
      [String(record.anime_msg), positiveId(record.anime_n || record.oi_index) || 1]);
    if (matches.length === 1) id = positiveId(matches[0].anilist_id);
  }
  const alias = queryRows(db, 'SELECT canonical_id FROM user_anime_aliases WHERE user_id = ? AND alias = ?', [userId, original])[0];
  return { anime_id: id ? `anilist_${id}` : alias?.canonical_id || original, anilist_id: id || positiveId(/^anilist_(\d+)$/.exec(alias?.canonical_id || '')?.[1]) };
}

function rememberAnimeAlias(db, userId, record, identity) {
  const aliases = [record.anime_id];
  if (record.anime_msg) aliases.push(`oiapi_${String(record.anime_msg).replace(/\//g, '_')}_${positiveId(record.anime_n || record.oi_index) || 1}`);
  for (const alias of aliases.filter(Boolean)) {
    db.run('INSERT OR REPLACE INTO user_anime_aliases (user_id, alias, canonical_id) VALUES (?, ?, ?)',
      [userId, String(alias), identity.anime_id]);
  }
}

function progressFields(record, previous = null) {
  const finite = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const hasPosition = record.position_seconds !== undefined && record.position_seconds !== null;
  const legacySeconds = !hasPosition && /^anilist_\d+$/.test(record.anime_id);
  const position = hasPosition ? finite(record.position_seconds) : legacySeconds ? finite(record.progress) : null;
  const sameEpisode = previous && String(previous.episode_number) === String(record.episode_number || '');
  const duration = finite(record.duration_seconds) || (sameEpisode ? finite(previous.duration_seconds) : 0);
  const percent = position !== null ? duration > 0 ? position / duration * 100 : null : finite(record.progress);
  return { position_seconds: position, duration_seconds: duration, progress: percent === null ? null : Math.min(100, percent) };
}

// Include legacy keys that were learned after the initial migration. Reads and
// user-requested removal must cover them even before the next server restart.
const animeKeyPredicate = `(anime_id = ? OR anime_id IN (
  SELECT alias FROM user_anime_aliases WHERE user_id = ? AND canonical_id = ?
))`;

function uniqueAnimeRows(db, userId, rows) {
  const seen = new Set();
  return rows.map(row => {
    const identity = resolveAnimeKey(db, userId, row);
    return { value: { ...row, ...identity }, canonical: row.anime_id === identity.anime_id };
  }).sort((a, b) =>
    Number(b.value.updated_at ?? b.value.created_at) - Number(a.value.updated_at ?? a.value.created_at)
    || Number(b.canonical) - Number(a.canonical) || b.value.id - a.value.id
  ).filter(row => {
    if (seen.has(row.value.anime_id)) return false;
    seen.add(row.value.anime_id);
    return true;
  }).map(row => row.value);
}

function migrateUserAnimeState(db) {
  db.run(`CREATE TABLE IF NOT EXISTS user_anime_aliases (
    user_id INTEGER NOT NULL, alias TEXT NOT NULL, canonical_id TEXT NOT NULL,
    PRIMARY KEY (user_id, alias), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run('CREATE TABLE IF NOT EXISTS user_state_migrations (version INTEGER PRIMARY KEY)');
  if (queryRows(db, 'SELECT version FROM user_state_migrations WHERE version = 1').length) return;
  const columns = queryRows(db, 'PRAGMA table_info(watch_history)').map(row => row.name);
  db.run('BEGIN TRANSACTION');
  try {
    // Preserve every original row in the same transaction before normalizing active tables.
    db.run('CREATE TABLE favorites_before_canonical AS SELECT * FROM favorites');
    db.run('CREATE TABLE watch_history_before_canonical AS SELECT * FROM watch_history');
    if (!columns.includes('position_seconds')) {
      db.run('ALTER TABLE watch_history ADD COLUMN position_seconds REAL DEFAULT NULL');
      db.run('ALTER TABLE watch_history ADD COLUMN duration_seconds REAL NOT NULL DEFAULT 0');
      db.run("UPDATE watch_history SET position_seconds = MAX(0, progress), progress = 0 WHERE anime_id GLOB 'anilist_[0-9]*'");
      db.run('UPDATE watch_history SET progress = MIN(100, MAX(0, progress))');
    }
    for (const table of ['favorites', 'watch_history']) {
      const order = table === 'favorites' ? 'created_at' : 'updated_at';
      const seen = new Set();
      for (const row of queryRows(db, `SELECT * FROM ${table} ORDER BY ${order} DESC, id DESC`)) {
        const identity = resolveAnimeKey(db, row.user_id, row);
        rememberAnimeAlias(db, row.user_id, row, identity);
        const key = `${row.user_id}:${identity.anime_id}`;
        if (seen.has(key)) { db.run(`DELETE FROM ${table} WHERE id = ?`, [row.id]); continue; }
        seen.add(key);
      }
      for (const row of queryRows(db, `SELECT * FROM ${table}`)) {
        const identity = resolveAnimeKey(db, row.user_id, row);
        db.run(`UPDATE ${table} SET anime_id = ?, anilist_id = ? WHERE id = ?`, [identity.anime_id, identity.anilist_id, row.id]);
      }
    }
    // Older schemas created a non-unique index with this name. IF NOT EXISTS
    // would silently retain it, so replace it within the migration transaction.
    db.run('DROP INDEX IF EXISTS idx_history_user_anime');
    db.run('CREATE UNIQUE INDEX idx_history_user_anime ON watch_history(user_id, anime_id)');
    db.run('INSERT INTO user_state_migrations(version) VALUES(1)');
    db.run('COMMIT');
  } catch (error) { db.run('ROLLBACK'); throw error; }
}

module.exports = { resolveAnimeKey, rememberAnimeAlias, progressFields, migrateUserAnimeState, animeKeyPredicate, uniqueAnimeRows };
