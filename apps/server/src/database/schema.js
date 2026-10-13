// Central database schema definition and index setup.

function initializeSchema(db) {
  // WAL mode disabled for sql.js in-memory DB to avoid export inconsistencies
  db.run('PRAGMA journal_mode=DELETE');
  db.run('PRAGMA foreign_keys=ON');

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      avatar TEXT DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      anilist_id INTEGER DEFAULT 0,
      anime_id TEXT NOT NULL,
      anime_title TEXT NOT NULL,
      anime_image TEXT DEFAULT '',
      anime_msg TEXT DEFAULT '',
      anime_n INTEGER DEFAULT 1,
      oi_index INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, anime_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS watch_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      anilist_id INTEGER DEFAULT 0,
      anime_id TEXT NOT NULL,
      anime_title TEXT NOT NULL,
      anime_image TEXT DEFAULT '',
      anime_msg TEXT DEFAULT '',
      anime_n INTEGER DEFAULT 1,
      episode_number TEXT DEFAULT '',
      episode_title TEXT DEFAULT '',
      progress REAL DEFAULT 0,
      video_url TEXT DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Canonical IDs for databases created before the Agent feature.
  const userColumns = db.exec('PRAGMA table_info(users)')[0].values.map(row => row[1]);
  if (!userColumns.includes('token_version')) {
    db.run('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
  }
  try { db.run('ALTER TABLE favorites ADD COLUMN anilist_id INTEGER DEFAULT 0'); } catch (e) {}
  try { db.run('ALTER TABLE watch_history ADD COLUMN anilist_id INTEGER DEFAULT 0'); } catch (e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      title TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      pending_action TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  try { db.run('ALTER TABLE agent_sessions ADD COLUMN summary TEXT DEFAULT \'\''); } catch (e) {}
  try { db.run('ALTER TABLE agent_sessions ADD COLUMN pending_action TEXT DEFAULT \'\''); } catch (e) {}

  db.run(`CREATE TABLE IF NOT EXISTS agent_operations (
    operation_id TEXT NOT NULL, user_id INTEGER NOT NULL, request_id TEXT NOT NULL,
    input_hash TEXT NOT NULL, session_id TEXT NOT NULL, intent TEXT NOT NULL,
    result_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, operation_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_requests (
    user_id INTEGER NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
    session_id TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, request_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_operations_request ON agent_operations(user_id, request_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_operations_time ON agent_operations(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_requests_time ON agent_requests(created_at)');
  try { db.run('ALTER TABLE agent_sessions ADD COLUMN summary_through_id INTEGER DEFAULT 0'); } catch (_) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      cards_json TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_user_memory (
      user_id INTEGER PRIMARY KEY,
      summary TEXT DEFAULT '',
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_anime_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      anilist_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      value REAL DEFAULT 1,
      context TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS recommendation_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      anilist_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      reason TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Persistent Agent telemetry. These tables intentionally store execution
  // metadata and redacted summaries, never full model prompts or raw tool
  // responses.
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      user_id INTEGER,
      session_id TEXT DEFAULT '',
      model TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running',
      fallback INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      finished_at INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      rounds INTEGER DEFAULT 0,
      tool_calls INTEGER DEFAULT 0,
      model_calls INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      input_chars INTEGER DEFAULT 0,
      answer_chars INTEGER DEFAULT 0,
      cards_count INTEGER DEFAULT 0,
      sources_count INTEGER DEFAULT 0,
      page TEXT DEFAULT '',
      error_code TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  try { db.run('ALTER TABLE agent_runs ADD COLUMN model_calls INTEGER DEFAULT 0'); } catch (e) {}
  try { db.run('ALTER TABLE agent_runs ADD COLUMN input_tokens INTEGER DEFAULT 0'); } catch (e) {}
  try { db.run('ALTER TABLE agent_runs ADD COLUMN output_tokens INTEGER DEFAULT 0'); } catch (e) {}
  try { db.run('ALTER TABLE agent_runs ADD COLUMN total_tokens INTEGER DEFAULT 0'); } catch (e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_model_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 1,
      model TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'success',
      duration_ms INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      input_chars INTEGER DEFAULT 0,
      output_chars INTEGER DEFAULT 0,
      tools_available INTEGER DEFAULT 0,
      purpose TEXT NOT NULL DEFAULT 'legacy',
      cache_hit_tokens INTEGER,
      cache_miss_tokens INTEGER,
      first_token_ms INTEGER,
      first_text_ms INTEGER,
      tokens_estimated INTEGER NOT NULL DEFAULT 1,
      error_code TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
    )
  `);

  // Old calls have unknown cache/latency values, never synthetic zero misses.
  const modelColumns = new Set(db.exec('PRAGMA table_info(agent_model_calls)')[0].values.map(row => row[1]));
  for (const [name, definition] of Object.entries({ purpose: "TEXT NOT NULL DEFAULT 'legacy'",
    cache_hit_tokens: 'INTEGER', cache_miss_tokens: 'INTEGER', first_token_ms: 'INTEGER',
    first_text_ms: 'INTEGER', tokens_estimated: 'INTEGER NOT NULL DEFAULT 1' })) {
    if (!modelColumns.has(name)) db.run(`ALTER TABLE agent_model_calls ADD COLUMN ${name} ${definition}`);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      duration_ms INTEGER DEFAULT 0,
      args_json TEXT DEFAULT '{}',
      result_summary TEXT DEFAULT '',
      error_code TEXT DEFAULT '',
      policy_rejected INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_answer_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      user_id INTEGER,
      session_id TEXT DEFAULT '',
      rating TEXT NOT NULL,
      reason TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // Link recommendation behavior back to the Agent run when available.
  try { db.run('ALTER TABLE user_anime_events ADD COLUMN agent_run_id TEXT DEFAULT \'\''); } catch (e) {}
  try { db.run('ALTER TABLE recommendation_feedback ADD COLUMN agent_run_id TEXT DEFAULT \'\''); } catch (e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS episode_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      anime_id TEXT NOT NULL,
      anime_title TEXT DEFAULT '',
      episode_number TEXT NOT NULL,
      content TEXT NOT NULL,
      parent_id INTEGER DEFAULT NULL,
      root_id INTEGER DEFAULT NULL,
      deleted_at INTEGER DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES episode_comments(id) ON DELETE CASCADE
    )
  `);

  // Replies were added after the initial episode_comments table was created.
  // Keep existing installations compatible with a lightweight migration.
  try { db.run('ALTER TABLE episode_comments ADD COLUMN parent_id INTEGER DEFAULT NULL'); } catch (e) {}
  try { db.run('ALTER TABLE episode_comments ADD COLUMN root_id INTEGER DEFAULT NULL'); } catch (e) {}
  try { db.run('ALTER TABLE episode_comments ADD COLUMN deleted_at INTEGER DEFAULT NULL'); } catch (e) {}
  try {
    db.run(
      `UPDATE episode_comments
       SET root_id = parent_id
       WHERE parent_id IS NOT NULL AND root_id IS NULL`
    );
  } catch (e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS episode_comment_reactions (
      comment_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      reaction INTEGER NOT NULL CHECK (reaction IN (-1, 1)),
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (comment_id, user_id),
      FOREIGN KEY (comment_id) REFERENCES episode_comments(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS episode_comment_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_user_id INTEGER NOT NULL,
      actor_user_id INTEGER NOT NULL,
      comment_id INTEGER NOT NULL,
      target_comment_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('like', 'reply')),
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      read_at INTEGER DEFAULT NULL,
      UNIQUE(recipient_user_id, actor_user_id, comment_id, type),
      FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (comment_id) REFERENCES episode_comments(id) ON DELETE CASCADE,
      FOREIGN KEY (target_comment_id) REFERENCES episode_comments(id) ON DELETE CASCADE
    )
  `);

  // ==================== Anime Meta Table ====================
  db.run(`
    CREATE TABLE IF NOT EXISTS anime_meta (
      anilist_id INTEGER PRIMARY KEY,
      title_romaji TEXT DEFAULT '',
      title_native TEXT DEFAULT '',
      title_chinese TEXT DEFAULT '',
      cover_image TEXT DEFAULT '',
      average_score INTEGER DEFAULT 0,
      popularity INTEGER DEFAULT 0,
      episodes INTEGER DEFAULT 0,
      status TEXT DEFAULT '',
      format TEXT DEFAULT '',
      genres TEXT DEFAULT '',
      season TEXT DEFAULT '',
      season_year INTEGER DEFAULT 0,
      start_date TEXT DEFAULT '',
      next_airing_episode INTEGER DEFAULT 0,
      next_airing_at INTEGER DEFAULT 0,
      oi_msg TEXT DEFAULT '',
      oi_index INTEGER DEFAULT 1,
      country_of_origin TEXT DEFAULT '',
      last_updated INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);

  // Add country_of_origin column if upgrading from older schema
  try {
    db.run('ALTER TABLE anime_meta ADD COLUMN country_of_origin TEXT DEFAULT \'\'');
  } catch (e) { /* column already exists */ }

  // Add content_tags column for yuri/healing tags
  try {
    db.run('ALTER TABLE anime_meta ADD COLUMN content_tags TEXT DEFAULT \'\'');
  } catch (e) { /* column already exists */ }

  // Numeric start-date key (YYYYMMDD) used for "latest first" ordering.
  // Ordering by the raw start_date text is wrong: start_date holds JSON such as
  // {"year":2026,"month":10,"day":3}, and as text "10" sorts before "9", which
  // pushed every October entry behind September (and February) in the browse
  // list. The same key lets the index below accelerate the ORDER BY.
  try {
    db.run('ALTER TABLE anime_meta ADD COLUMN start_date_key INTEGER DEFAULT 0');
  } catch (e) { /* column already exists */ }

  // Manual anime metadata edits are kept separately so administrators can
  // review who changed a title or playback mapping and what the old value was.
  db.run(`
    CREATE TABLE IF NOT EXISTS anime_meta_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anilist_id INTEGER NOT NULL,
      user_id INTEGER,
      editor_name TEXT DEFAULT '',
      changed_fields_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (anilist_id) REFERENCES anime_meta(anilist_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // ==================== Vector RAG Tables ====================
  // sql.js does not ship with a vector extension. Embeddings are therefore
  // stored as compact Float32 BLOBs and cosine similarity is calculated by the
  // Agent's paginated vector scan. The content hash makes indexing
  // incremental and prevents unchanged anime records from being embedded
  // again after a metadata sync.
  db.run(`
    CREATE TABLE IF NOT EXISTS anime_chunks (
      id TEXT PRIMARY KEY,
      anilist_id INTEGER DEFAULT 0,
      chunk_type TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_url TEXT DEFAULT '',
      source_title TEXT DEFAULT '',
      published_at TEXT DEFAULT '',
      trust_score REAL DEFAULT 0,
      content_hash TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      embedding_dimensions INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      source_updated_at INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS rag_index_queue (
      anilist_id INTEGER PRIMARY KEY,
      source_updated_at INTEGER DEFAULT 0,
      queued_at INTEGER NOT NULL
    )
  `);

  // Create indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_favorites_anime ON favorites(user_id, anime_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_history_user ON watch_history(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_history_updated ON watch_history(user_id, updated_at DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_history_user_anime ON watch_history(user_id, anime_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_favorites_anilist ON favorites(user_id, anilist_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_history_anilist ON watch_history(user_id, anilist_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_sessions_user ON agent_sessions(user_id, updated_at DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, created_at ASC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_events_user_time ON user_anime_events(user_id, created_at DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_events_user_anime ON user_anime_events(user_id, anilist_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_feedback_user_anime ON recommendation_feedback(user_id, anilist_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_runs_user ON agent_runs(user_id, started_at DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_run ON agent_tool_calls(run_id, sequence ASC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_name ON agent_tool_calls(name, created_at DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_model_calls_run ON agent_model_calls(run_id, sequence ASC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_model_calls_model ON agent_model_calls(model, created_at DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_answer_feedback_run ON agent_answer_feedback(run_id, created_at DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_episode_comments_lookup ON episode_comments(anime_id, episode_number, created_at DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_episode_comments_parent ON episode_comments(parent_id, created_at ASC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_episode_comments_root ON episode_comments(root_id, created_at ASC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_episode_comments_deleted ON episode_comments(deleted_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_episode_comment_reactions_comment ON episode_comment_reactions(comment_id, reaction)');
  db.run('CREATE INDEX IF NOT EXISTS idx_episode_comment_notifications_recipient ON episode_comment_notifications(recipient_user_id, created_at DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_verifications_email ON email_verifications(email, expires_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_anime_meta_year ON anime_meta(season_year)');
  db.run('CREATE INDEX IF NOT EXISTS idx_anime_meta_status ON anime_meta(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_anime_meta_score ON anime_meta(average_score DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_anime_meta_popularity ON anime_meta(popularity DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_anime_meta_updated ON anime_meta(last_updated)');
  db.run('CREATE INDEX IF NOT EXISTS idx_anime_meta_season_status ON anime_meta(country_of_origin, season_year, season, status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_anime_meta_rank_popular ON anime_meta(country_of_origin, status, popularity DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_anime_meta_rank_score ON anime_meta(country_of_origin, status, average_score DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_anime_meta_airing ON anime_meta(country_of_origin, status, next_airing_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_anime_meta_browse ON anime_meta(country_of_origin, season_year, season, start_date DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_anime_meta_start_key ON anime_meta(country_of_origin, start_date_key DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_anime_meta_edits_anilist ON anime_meta_edits(anilist_id, created_at DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_anime_chunks_model ON anime_chunks(embedding_model)');
  db.run('CREATE INDEX IF NOT EXISTS idx_anime_chunks_anilist ON anime_chunks(anilist_id, source_type)');
  db.run('CREATE INDEX IF NOT EXISTS idx_anime_chunks_updated ON anime_chunks(updated_at)');
  try { db.run("ALTER TABLE rag_index_queue ADD COLUMN generation TEXT DEFAULT 'legacy'"); } catch (_) {}
  db.run('CREATE INDEX IF NOT EXISTS idx_rag_queue_time ON rag_index_queue(queued_at)');
}

module.exports = { initializeSchema };
