const { randomUUID } = require('crypto');
const { parseUserMemory } = require('../../../../baiyu_agent/memory/user-memory');
const { sessionState } = require('../../../../baiyu_agent/memory/session-state');
const artifacts = require('./agent-artifacts');

function initializeAgentContextSchema(db) {
  const columns = new Set(db.exec('PRAGMA table_info(agent_sessions)')[0]?.values.map(row => row[1]) || []);
  for (const [name, definition] of Object.entries({ state_json: "TEXT NOT NULL DEFAULT '{}'", context_revision: 'INTEGER NOT NULL DEFAULT 0',
    active_summary_id: "TEXT NOT NULL DEFAULT ''", summary_cursor: "TEXT NOT NULL DEFAULT '{}'", summary_epoch: 'INTEGER NOT NULL DEFAULT 0' })) {
    if (!columns.has(name)) db.run(`ALTER TABLE agent_sessions ADD COLUMN ${name} ${definition}`);
  }
  const messageColumns = new Set(db.exec('PRAGMA table_info(agent_messages)')[0]?.values.map(row => row[1]) || []);
  if (!messageColumns.has('request_id')) db.run("ALTER TABLE agent_messages ADD COLUMN request_id TEXT NOT NULL DEFAULT ''");
  db.run(`CREATE TABLE IF NOT EXISTS agent_memory_control (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0,
    history_floor_id INTEGER NOT NULL DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_memory_items (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    memory_key TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
    source_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    expires_at INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`);
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_owner_status ON agent_memory_items(user_id, status, updated_at DESC)');
  db.run(`CREATE TABLE IF NOT EXISTS agent_memory_item_versions (
    item_id TEXT NOT NULL REFERENCES agent_memory_items(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
    value TEXT NOT NULL, source_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(item_id,revision))`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_memory_changes (
    change_id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, change_id))`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_summary_versions (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    parent_id TEXT NOT NULL, summary_json TEXT NOT NULL, through_id INTEGER NOT NULL,
    cursor_json TEXT NOT NULL, epoch INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_context_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, epoch INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
  db.run('CREATE INDEX IF NOT EXISTS idx_context_events_session ON agent_context_events(session_id, id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_context_events_request ON agent_context_events(session_id, request_id, epoch, kind)');
  db.run(`CREATE TABLE IF NOT EXISTS agent_context_artifacts (
    id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE, epoch INTEGER NOT NULL,
    bytes INTEGER NOT NULL, PRIMARY KEY(user_id,session_id,id))`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_maintenance_jobs (
    session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL, epoch INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
    generation TEXT NOT NULL, target_id INTEGER NOT NULL DEFAULT 0)`);
  const jobColumns = new Set(db.exec('PRAGMA table_info(agent_maintenance_jobs)')[0]?.values.map(row => row[1]) || []);
  if (!jobColumns.has('target_id')) db.run('ALTER TABLE agent_maintenance_jobs ADD COLUMN target_id INTEGER NOT NULL DEFAULT 0');
  // A restarted process may safely retry compaction, never business actions.
  db.run("UPDATE agent_maintenance_jobs SET status = 'pending' WHERE status = 'running'");
}

function createAgentContextRepository({ getDb, scheduleSave, flushDatabase, getAgentSession }) {
  const rows = (sql, args = []) => {
    const result = getDb().exec(sql, args)[0];
    return result ? result.values.map(row => Object.fromEntries(result.columns.map((key, i) => [key, row[i]]))) : [];
  };
  const parse = (raw, fallback = {}) => { try { return JSON.parse(raw) ?? fallback; } catch (_) { return fallback; } };
  const eventPruneTimes = new Map();
  let durabilityPending = false;
  function transaction(work, durable = false) {
    const db = getDb();
    db.run('BEGIN TRANSACTION');
    let result;
    try { result = work(db); db.run('COMMIT'); }
    catch (error) { db.run('ROLLBACK'); throw error; }
    scheduleSave();
    if (durable) {
      durabilityPending = true;
      flushDatabase();
      durabilityPending = false;
    }
    return result;
  }

  function memorySnapshot(userId) {
    // A failed sql.js file flush must not expose an unacknowledged change as durable state.
    if (durabilityPending) { flushDatabase(); durabilityPending = false; }
    let control = rows('SELECT * FROM agent_memory_control WHERE user_id = ?', [userId])[0];
    if (!control) {
      const legacy = parseUserMemory(rows('SELECT summary FROM agent_user_memory WHERE user_id = ?', [userId])[0]?.summary || '');
      transaction(db => {
        db.run('INSERT INTO agent_memory_control(user_id) VALUES (?)', [userId]);
        const values = Object.entries(legacy.preferences).flatMap(([kind, items]) => items.map(value => ({ kind: `preference_${kind}`, value })));
        values.push(...legacy.facts.filter(item => !item.kind.startsWith('preference_')));
        for (const item of values) db.run(`INSERT INTO agent_memory_items
          (id,user_id,memory_key,kind,value,source_json,updated_at) VALUES(?,?,?,?,?,?,?)`,
          [randomUUID(), userId, `legacy:${item.kind}:${item.value}`, item.kind, item.value,
            JSON.stringify({ kind: 'legacy', confidence: item.confidence || 0.6 }), Date.now()]);
      });
      control = { user_id: userId, revision: 0, epoch: 0, history_floor_id: 0 };
    }
    return { revision: control.revision, epoch: control.epoch, historyFloorId: control.history_floor_id,
      items: rows("SELECT * FROM agent_memory_items WHERE user_id = ? AND status = 'active' AND (expires_at = 0 OR expires_at > ?) ORDER BY updated_at DESC", [userId, Date.now()])
        .map(item => ({ id: item.id, key: item.memory_key, kind: item.kind, value: item.value,
          source: parse(item.source_json), expiresAt: item.expires_at, revision: item.revision })) };
  }

  function contextSnapshot(sessionId, userId) {
    const memory = memorySnapshot(userId);
    const session = getAgentSession(sessionId, userId);
    if (!session) throw new Error('CONTEXT_SESSION_DELETED');
    return { state: parse(session.state_json), revision: session.context_revision || 0, memory,
      summary: session.summary_epoch === memory.epoch ? session.summary || '' : '',
      summaryId: session.active_summary_id || '', throughId: Math.max(session.summary_through_id || 0, memory.historyFloorId),
      cursor: parse(session.summary_cursor), pendingAction: session.pending_action || '' };
  }

  function changeMemory({ userId, sessionId, changeId, inputHash = '', expectedRevision, change }) {
    const prior = readMemoryReceipt(userId, sessionId, changeId, inputHash);
    if (prior) return prior;
    if (sessionId && !getAgentSession(sessionId, userId)) throw new Error('CONTEXT_SESSION_DELETED');
    const snapshot = memorySnapshot(userId);
    if (snapshot.revision !== expectedRevision) throw new Error('MEMORY_REVISION_CONFLICT');
    return transaction(db => {
      const existing = snapshot.items.find(item => item.id === change.memoryId);
      if (change.action === 'upsert' && existing && existing.key === change.key && existing.kind === change.kind && existing.value === change.value
        && existing.expiresAt === (change.expiresAt || 0)) {
        const receipt = { status: 'memory_updated', changeId, action: change.action, scope: 'user', inputHash,
          revision: snapshot.revision, epoch: snapshot.epoch, changed: 0, memoryId: existing.id };
        insertMemoryReceipt(db, userId, sessionId, changeId, receipt);
        return receipt;
      }
      const revision = snapshot.revision + 1;
      const destructive = change.action === 'forget' || Boolean(change.memoryId);
      let memoryId = change.memoryId;
      if (change.action === 'forget') {
        for (const id of change.ids) db.run("UPDATE agent_memory_items SET status = 'deleted', revision = ?, updated_at = ? WHERE user_id = ? AND id = ? AND status = 'active'", [revision, Date.now(), userId, id]);
      } else {
        if (snapshot.items.length >= 1000 && !change.memoryId) throw new Error('MEMORY_STORAGE_LIMIT');
        const id = change.memoryId || randomUUID();
        memoryId = id;
        if (change.memoryId && !snapshot.items.some(item => item.id === id)) throw new Error('MEMORY_TARGET_NOT_FOUND');
        const old = change.memoryId ? rows('SELECT * FROM agent_memory_items WHERE id = ? AND user_id = ?', [id, userId])[0] : null;
        if (old) {
          db.run('INSERT OR IGNORE INTO agent_memory_item_versions VALUES(?,?,?,?,?)', [id, old.revision, old.value, old.source_json, Date.now()]);
          db.run('DELETE FROM agent_memory_item_versions WHERE item_id = ? AND revision NOT IN (SELECT revision FROM agent_memory_item_versions WHERE item_id = ? ORDER BY revision DESC LIMIT 4)', [id, id]);
        }
        db.run(`INSERT INTO agent_memory_items(id,user_id,memory_key,kind,value,source_json,status,expires_at,revision,updated_at)
          VALUES(?,?,?,?,?,?,'active',?,?,?) ON CONFLICT(id) DO UPDATE SET memory_key=excluded.memory_key,
          kind=excluded.kind,value=excluded.value,source_json=excluded.source_json,status='active',
          expires_at=excluded.expires_at,revision=excluded.revision,updated_at=excluded.updated_at`,
          [id, userId, change.key, change.kind, change.value, JSON.stringify(change.source), change.expiresAt || 0, revision, Date.now()]);
      }
      const epoch = snapshot.epoch + (destructive ? 1 : 0);
      const floor = destructive ? Number(rows('SELECT MAX(id) AS id FROM agent_messages')[0]?.id || 0) : snapshot.historyFloorId;
      db.run('UPDATE agent_memory_control SET revision = ?, epoch = ?, history_floor_id = ? WHERE user_id = ?', [revision, epoch, floor, userId]);
      if (destructive) {
        const affected = change.action === 'forget' ? snapshot.items.filter(item => change.ids.includes(item.id)) : snapshot.items.filter(item => item.id === change.memoryId);
        invalidateContext(db, userId, epoch, floor, affected);
      }
      const receipt = { status: 'memory_updated', changeId, action: change.action, scope: 'user', inputHash, revision, epoch, memoryId,
        changed: change.action === 'forget' ? snapshot.items.filter(item => change.ids.includes(item.id)).length : 1,
        suppressHistory: destructive };
      insertMemoryReceipt(db, userId, sessionId, changeId, receipt);
      if (sessionId) db.run('INSERT INTO agent_context_events(session_id,request_id,kind,payload_json,epoch,created_at) VALUES(?,?,?,?,?,?)',
        [sessionId, changeId, 'memory_change', JSON.stringify({ ...receipt, memoryIds: change.ids || [memoryId] }), epoch, Date.now()]);
      return receipt;
    }, true);
  }

  function readMemoryReceipt(userId, sessionId, changeId, inputHash) {
    const prior = rows('SELECT session_id,result_json FROM agent_memory_changes WHERE user_id = ? AND change_id = ?', [userId, changeId])[0];
    if (!prior) return null;
    const receipt = parse(prior.result_json);
    if (prior.session_id !== sessionId || (receipt.inputHash || '') !== inputHash) throw new Error('REQUEST_ID_CONFLICT');
    if (sessionId && !getAgentSession(sessionId, userId)) throw new Error('CONTEXT_SESSION_DELETED');
    flushDatabase();
    return receipt;
  }

  function insertMemoryReceipt(db, userId, sessionId, changeId, receipt) {
    db.run('INSERT INTO agent_memory_changes VALUES(?,?,?,?,?)', [changeId, userId, sessionId, JSON.stringify(receipt), Date.now()]);
    db.run('DELETE FROM agent_memory_changes WHERE created_at < ?', [Date.now() - 7 * 86400000]);
  }

  function invalidateContext(db, userId, epoch, floor, affected) {
    discardArtifacts(userId);
    // Unclassified prose is quarantined conservatively; UI chat and unrelated authoritative memory remain.
    db.run("UPDATE agent_sessions SET summary = '', active_summary_id = '', summary_cursor = '{}', summary_through_id = ?, summary_epoch = ?, context_revision = context_revision + 1 WHERE user_id = ?", [floor, epoch, userId]);
    for (const table of ['agent_summary_versions', 'agent_context_events', 'agent_maintenance_jobs']) db.run(`DELETE FROM ${table} WHERE session_id IN (SELECT id FROM agent_sessions WHERE user_id = ?)`, [userId]);
    db.run('DELETE FROM agent_requests WHERE user_id = ?', [userId]);
    const keys = new Set(affected.map(item => item.key)), ids = new Set(affected.map(item => item.id));
    for (const session of rows('SELECT id,state_json FROM agent_sessions WHERE user_id = ?', [userId])) {
      const state = sessionState(session.state_json);
      state.task = ''; state.openQuestions = [];
      state.constraints = (Array.isArray(state.constraints) ? state.constraints : []).filter(item => !keys.has(item.key) && !ids.has(item.memoryId) && !affected.some(old => old.value === item.value));
      state.resultRefs = (state.resultRefs || []).map(({ artifactId, ...ref }) => ref);
      db.run('UPDATE agent_sessions SET state_json = ? WHERE id = ?', [JSON.stringify(state), session.id]);
    }
  }

  function checkpoint({ sessionId, userId, revision, epoch, parentId, summary, throughId, cursor }) {
    const before = contextSnapshot(sessionId, userId);
    if (before.revision !== revision || before.memory.epoch !== epoch || before.summaryId !== parentId
      || throughId < before.throughId) return { conflict: true };
    return transaction(db => {
      const id = parse(summary).id || randomUUID();
      db.run('INSERT INTO agent_summary_versions VALUES(?,?,?,?,?,?,?,?)',
        [id, sessionId, parentId, summary, throughId, JSON.stringify(cursor || {}), epoch, Date.now()]);
      db.run(`UPDATE agent_sessions SET summary = ?, summary_through_id = ?, active_summary_id = ?,
        summary_cursor = ?, summary_epoch = ?, context_revision = context_revision + 1 WHERE id = ? AND user_id = ?`,
        [summary, throughId, id, JSON.stringify(cursor || {}), epoch, sessionId, userId]);
      db.run('DELETE FROM agent_summary_versions WHERE session_id = ? AND id NOT IN (SELECT id FROM agent_summary_versions WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 4)', [sessionId, sessionId]);
      db.run('INSERT INTO agent_context_events(session_id,request_id,kind,payload_json,epoch,created_at) VALUES(?,?,?,?,?,?)',
        [sessionId, '', 'summary_checkpoint', JSON.stringify({ summaryId: id, parentId, throughId, cursor }), epoch, Date.now()]);
      return { success: true, summaryId: id };
    }, true);
  }

  function saveState({ sessionId, userId, state, revision, epoch, quarantine = false, affected = [], receipt }) {
    if (receipt) {
      const prior = readMemoryReceipt(userId, sessionId, receipt.changeId, receipt.result.inputHash || '');
      if (prior) return { success: true, replayed: true, receipt: prior };
    }
    const before = contextSnapshot(sessionId, userId);
    if (before.revision !== revision || before.memory.epoch !== epoch) throw new Error('CONTEXT_REVISION_CONFLICT');
    return transaction(db => {
      if (quarantine) {
        const floor = Number(rows('SELECT MAX(id) AS id FROM agent_messages')[0]?.id || 0);
        db.run('UPDATE agent_memory_control SET revision = revision + 1, epoch = epoch + 1, history_floor_id = ? WHERE user_id = ?', [floor, userId]);
        invalidateContext(db, userId, epoch + 1, floor, affected);
      }
      db.run('UPDATE agent_sessions SET state_json = ?, context_revision = context_revision + 1 WHERE id = ? AND user_id = ?', [JSON.stringify(state), sessionId, userId]);
      const result = receipt ? { ...receipt.result, suppressHistory: quarantine } : null;
      if (receipt) insertMemoryReceipt(db, userId, sessionId, receipt.changeId, result);
      return { success: true, ...(receipt ? { receipt: result } : {}) };
    }, true);
  }

  function historyPage(userId, sessionId, afterId, beforeId, limit) {
    return rows(`SELECT m.id,m.role,m.content FROM agent_messages m JOIN agent_sessions s ON s.id = m.session_id
      WHERE s.user_id = ? AND s.id = ? AND m.id > ? ${beforeId ? 'AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ?`,
      [userId, sessionId, afterId, ...(beforeId ? [beforeId] : []), Math.min(128, limit)]).reverse();
  }

  function event({ sessionId, userId, requestId, kind, payload, epoch }) {
    if (!getAgentSession(sessionId, userId)) return;
    const current = memorySnapshot(userId);
    if (epoch !== current.epoch) return;
    getDb().run('INSERT INTO agent_context_events(session_id,request_id,kind,payload_json,epoch,created_at) VALUES(?,?,?,?,?,?)',
      [sessionId, requestId || '', kind, artifacts.sanitizedJson(payload), epoch, Date.now()]);
    if (Date.now() - (eventPruneTimes.get(userId) || 0) > 60000) {
      const candidates = rows(`SELECT e.id,LENGTH(CAST(e.payload_json AS BLOB)) AS bytes,e.created_at FROM agent_context_events e
        JOIN agent_sessions s ON s.id = e.session_id WHERE s.user_id = ? ORDER BY e.id DESC`, [userId]);
      let bytes = 0, cutoff = 0;
      for (const entry of candidates) {
        bytes += entry.bytes;
        if (bytes > 2 * 1024 * 1024 || entry.created_at < Date.now() - 30 * 86400000) { cutoff = entry.id; break; }
      }
      if (cutoff) getDb().run('DELETE FROM agent_context_events WHERE id <= ? AND session_id IN (SELECT id FROM agent_sessions WHERE user_id = ?)', [cutoff, userId]);
      eventPruneTimes.set(userId, Date.now());
      if (eventPruneTimes.size > 1000) eventPruneTimes.delete(eventPruneTimes.keys().next().value);
    }
    scheduleSave();
  }

  function saveArtifact({ userId, sessionId, epoch, payload }) {
    const current = contextSnapshot(sessionId, userId);
    if (current.memory.epoch !== epoch) return { omitted: 'stale_epoch' };
    try { artifacts.pruneOrphans(userId, id => rows('SELECT id FROM agent_context_artifacts WHERE user_id = ? AND id = ? LIMIT 1', [userId, id]).length > 0); }
    catch (error) { console.error('[Agent artifacts cleanup]', error.message); }
    const used = Number(rows('SELECT SUM(bytes) AS bytes FROM (SELECT id,MAX(bytes) AS bytes FROM agent_context_artifacts WHERE user_id = ? GROUP BY id)', [userId])[0]?.bytes || 0);
    if (used + Buffer.byteLength(artifacts.sanitizedJson(payload)) > 8 * 1024 * 1024) return { omitted: 'quota' };
    const artifact = artifacts.writeArtifact(userId, payload);
    if (artifact.id) {
      getDb().run('INSERT OR IGNORE INTO agent_context_artifacts VALUES(?,?,?,?,?)', [artifact.id, userId, sessionId, epoch, artifact.bytes]);
      scheduleSave();
    }
    return artifact;
  }
  function loadArtifact(userId, id, offset) {
    const memory = memorySnapshot(userId);
    if (!rows('SELECT id FROM agent_context_artifacts WHERE user_id = ? AND id = ? AND epoch = ? LIMIT 1', [userId, id, memory.epoch]).length) return { found: false };
    return { found: true, ...artifacts.readArtifact(userId, id, offset) };
  }

  function searchHistory(userId, query, sessionId, limit = 3, afterId = 0) {
    const memory = memorySnapshot(userId);
    const terms = require('../../../../baiyu_agent/memory/user-memory').memorySearchTerms(query);
    if (!terms.length) return [];
    // Bound the owner-filtered source scan; no foreign-user row enters scoring.
    const candidates = rows(`SELECT m.id,m.session_id,m.role,m.content,m.cards_json,m.created_at,m.request_id,s.title FROM agent_messages m
      JOIN agent_sessions s ON s.id = m.session_id WHERE s.user_id = ? AND m.id > ?
      ${sessionId ? 'AND s.id = ?' : ''} ORDER BY m.id DESC LIMIT 1000`,
      [userId, Math.max(memory.historyFloorId, afterId), ...(sessionId ? [sessionId] : [])]);
    return candidates.map(item => ({ ...item, score: terms.reduce((score, term) => score + (item.content.toLowerCase().includes(term) ? 1 : 0), 0) }))
      .filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.id - a.id).slice(0, limit)
      .map(item => ({ eventId: item.id, sessionId: item.session_id, role: item.role,
        ...historyExcerpt(item.content, Math.max(0, Math.min(...terms.map(term => item.content.toLowerCase().indexOf(term)).filter(index => index >= 0)) - 300)),
        evidenceRefs: eventReferences(userId, item.session_id, item.request_id),
        createdAt: item.created_at, cards: parse(item.cards_json, []).slice(0, 12).map(card => ({ anilistId: card.anilistId, title: card.title })) }));
  }
  function eventReferences(userId, sessionId, requestId, knownEpoch) {
    if (!requestId) return [];
    const epoch = knownEpoch ?? memorySnapshot(userId).epoch;
    return rows(`SELECT e.payload_json FROM agent_context_events e JOIN agent_sessions s ON s.id = e.session_id
      WHERE s.user_id = ? AND e.session_id = ? AND e.request_id = ? AND e.epoch = ? AND e.kind = 'tool_result' ORDER BY e.id DESC LIMIT 6`,
      [userId, sessionId, requestId, epoch]).map(row => {
        const event = parse(row.payload_json);
        return { tool: event.name, status: event.status,
          artifactId: event.artifactId || event.result?.artifactId || event.artifact?.id };
      });
  }
  function historyExcerpt(content, offset = 0) {
    const chars = [...content], end = Math.min(chars.length, offset + 2400);
    return { content: chars.slice(offset, end).join(''), offset, nextOffset: end < chars.length ? end : null, totalChars: chars.length };
  }
  function readHistory(userId, eventId, offset = 0) {
    const memory = memorySnapshot(userId);
    const row = rows(`SELECT m.id,m.role,m.content FROM agent_messages m JOIN agent_sessions s ON s.id = m.session_id
      WHERE s.user_id = ? AND m.id = ? AND m.id > ?`, [userId, eventId, memory.historyFloorId])[0];
    return row ? { found: true, eventId, role: row.role, ...historyExcerpt(row.content, offset) } : { found: false };
  }

  function enqueueJob(sessionId, userId, epoch, targetId = 0) {
    if (!getAgentSession(sessionId, userId)) return;
    getDb().run(`INSERT INTO agent_maintenance_jobs(session_id,user_id,epoch,updated_at,generation,target_id) VALUES(?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET target_id=CASE WHEN agent_maintenance_jobs.epoch=excluded.epoch
        THEN MAX(agent_maintenance_jobs.target_id,excluded.target_id) ELSE excluded.target_id END,
        epoch=excluded.epoch,status='pending',attempts=0,available_at=0,updated_at=excluded.updated_at,generation=excluded.generation`,
      [sessionId, userId, epoch, Date.now(), randomUUID(), Math.max(0, Number(targetId) || 0)]);
    scheduleSave();
  }
  function claimJob() {
    const job = rows("SELECT * FROM agent_maintenance_jobs WHERE status = 'pending' AND attempts < 3 AND available_at <= ? ORDER BY updated_at LIMIT 1", [Date.now()])[0];
    if (job) { getDb().run("UPDATE agent_maintenance_jobs SET status = 'running' WHERE session_id = ?", [job.session_id]); scheduleSave(); }
    return job;
  }
  function finishJob(job, success) {
    if (success) getDb().run("DELETE FROM agent_maintenance_jobs WHERE session_id = ? AND generation = ? AND status = 'running'", [job.session_id, job.generation]);
    else getDb().run("UPDATE agent_maintenance_jobs SET status = 'pending', attempts = attempts + 1, available_at = ? WHERE session_id = ? AND generation = ? AND status = 'running'", [Date.now() + 30000 * (job.attempts + 1), job.session_id, job.generation]);
    const changed = getDb().getRowsModified() > 0;
    scheduleSave();
    return changed;
  }
  function nextJobAt() {
    return rows("SELECT MIN(available_at) AS at FROM agent_maintenance_jobs WHERE status = 'pending' AND attempts < 3")[0]?.at ?? null;
  }
  function purge(userId, sessionId) {
    const db = getDb();
    discardArtifacts(userId, sessionId);
    if (sessionId) {
      db.run('DELETE FROM agent_memory_changes WHERE user_id = ? AND session_id = ?', [userId, sessionId]);
      for (const table of ['agent_summary_versions', 'agent_context_events', 'agent_maintenance_jobs']) db.run(`DELETE FROM ${table} WHERE session_id = ?`, [sessionId]);
    } else {
      const previous = memorySnapshot(userId);
      db.run('DELETE FROM agent_memory_items WHERE user_id = ?', [userId]);
      db.run('DELETE FROM agent_memory_changes WHERE user_id = ?', [userId]);
      db.run('UPDATE agent_memory_control SET revision = revision + 1, epoch = epoch + 1, history_floor_id = ? WHERE user_id = ?',
        [Number(rows('SELECT MAX(id) AS id FROM agent_messages')[0]?.id || 0), userId]);
      for (const table of ['agent_summary_versions', 'agent_context_events', 'agent_maintenance_jobs']) db.run(`DELETE FROM ${table} WHERE session_id IN (SELECT id FROM agent_sessions WHERE user_id = ?)`, [userId]);
      db.run("UPDATE agent_sessions SET state_json = '{}', active_summary_id = '', summary_cursor = '{}', summary_epoch = ?, context_revision = context_revision + 1 WHERE user_id = ?", [previous.epoch + 1, userId]);
    }
  }
  function discardArtifacts(userId, sessionId) {
    const db = getDb();
    const files = rows('SELECT id FROM agent_context_artifacts WHERE user_id = ?' + (sessionId ? ' AND session_id = ?' : ''), [userId, ...(sessionId ? [sessionId] : [])]);
    db.run('DELETE FROM agent_context_artifacts WHERE user_id = ?' + (sessionId ? ' AND session_id = ?' : ''), [userId, ...(sessionId ? [sessionId] : [])]);
    // Verify references after the caller commits or rolls back before touching files.
    queueMicrotask(() => {
      if (!getDb()) return;
      for (const file of files) {
        if (!rows('SELECT id FROM agent_context_artifacts WHERE user_id = ? AND id = ? LIMIT 1', [userId, file.id]).length) {
          try { artifacts.removeArtifact(userId, file.id); } catch (error) { console.error('[Agent artifacts]', error.message); }
        }
      }
    });
  }
  return { getAgentMemorySnapshot: memorySnapshot, getAgentContextSnapshot: contextSnapshot, applyAgentMemoryChange: changeMemory,
    commitAgentState: saveState, getAgentHistoryPage: historyPage,
    saveAgentContextArtifact: saveArtifact, readAgentContextArtifact: loadArtifact,
    readAgentHistory: readHistory,
    getAgentEventReferences: eventReferences,
    commitAgentSummaryCheckpoint: checkpoint, appendAgentContextEvent: event, searchAgentHistory: searchHistory,
    enqueueAgentMaintenance: enqueueJob, claimAgentMaintenance: claimJob, nextAgentMaintenanceAt: nextJobAt,
    finishAgentMaintenance: finishJob, purgeAgentContext: purge };
}

module.exports = { initializeAgentContextSchema, createAgentContextRepository };
