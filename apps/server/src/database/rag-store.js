const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { DatabaseFileStore } = require('./file-store');

function fileDigest(filename) {
  if (!fs.existsSync(filename)) return 'new';
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(filename, 'r');
  try {
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

// Corpus writes may be large; user transactions must not export this snapshot.
class RagFileStore {
  constructor(filename) {
    this.filename = filename;
    this.files = new DatabaseFileStore(filename);
    this.db = null;
    this.dirty = false;
  }

  initialize(SQL, main, mainPath) {
    main.run('CREATE TABLE IF NOT EXISTS app_storage (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const marker = main.exec("SELECT value FROM app_storage WHERE name = 'rag_store_id'")[0]?.values[0]?.[0];
    if (marker && !fs.existsSync(this.filename)) throw new Error('RAG sidecar is missing; restore the paired database backup');
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    this.files.acquire();
    try {
      this.db = fs.existsSync(this.filename) ? new SQL.Database(fs.readFileSync(this.filename)) : new SQL.Database();
      const schema = main.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'anime_chunks'")[0]?.values[0]?.[0];
      if (!schema) throw new Error('RAG legacy schema is missing');
      this.db.run(schema.replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS '));
      this.db.run('CREATE INDEX IF NOT EXISTS idx_chunks_model_id ON anime_chunks(embedding_model, id)');
      this.db.run('CREATE INDEX IF NOT EXISTS idx_chunks_anime ON anime_chunks(anilist_id, source_type, embedding_model)');
      this.db.run('CREATE INDEX IF NOT EXISTS idx_chunks_updated ON anime_chunks(updated_at)');
      this.db.run('CREATE TABLE IF NOT EXISTS storage_identity (id TEXT PRIMARY KEY, legacy_digest TEXT NOT NULL)');
      const identities = this.db.exec('SELECT id, legacy_digest FROM storage_identity')[0]?.values || [];
      if (identities.length > 1) throw new Error('RAG sidecar has conflicting storage identities');
      const identity = identities[0];
      const existingId = identity?.[0];
      if (marker && marker !== existingId) throw new Error('RAG sidecar belongs to another main database');
      const sourceCount = Number(main.exec('SELECT COUNT(*) FROM anime_chunks')[0].values[0][0]);
      const targetCount = Number(this.db.exec('SELECT COUNT(*) FROM anime_chunks')[0].values[0][0]);
      if (!marker && !sourceCount && targetCount) throw new Error('Unpaired RAG sidecar; restore the original main database');
      const digest = marker ? identity[1] : fileDigest(mainPath);
      if (!marker && existingId && identity[1] !== digest) throw new Error('RAG migration source changed; restore the paired backup');
      const id = marker || existingId || randomUUID();
      this.db.run('INSERT OR IGNORE INTO storage_identity(id, legacy_digest) VALUES (?, ?)', [id, digest]);
      this.dirty = true;
      if (sourceCount) this.copyAndVerify(main);
      // A crash before the main commit leaves the legacy source intact and can resume.
      this.flush();
      if (sourceCount && fs.existsSync(mainPath)) {
        const backup = `${mainPath}.before-rag-split.bak`;
        if (!fs.existsSync(backup)) fs.copyFileSync(mainPath, backup, fs.constants.COPYFILE_EXCL);
      }
      main.run("INSERT OR REPLACE INTO app_storage(name, value) VALUES ('rag_store_id', ?)", [id]);
      if (sourceCount) { main.run('DELETE FROM anime_chunks'); main.run('VACUUM'); }
    } catch (error) {
      this.db?.close(); this.db = null;
      this.files.release();
      throw error;
    }
  }

  copyAndVerify(main) {
    const source = main.prepare('SELECT * FROM anime_chunks ORDER BY id');
    const insert = this.db.prepare('INSERT OR IGNORE INTO anime_chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const existing = this.db.prepare('SELECT * FROM anime_chunks WHERE id = ?');
    this.db.run('BEGIN');
    try {
      while (source.step()) {
        const row = source.get();
        insert.run(row);
        existing.bind([row[0]]);
        if (!existing.step()) throw new Error('RAG migration lost a chunk');
        const copied = existing.get();
        existing.reset();
        if (row.length !== copied.length || row.some((value, index) => value instanceof Uint8Array
          ? !(copied[index] instanceof Uint8Array) || !Buffer.from(value).equals(Buffer.from(copied[index]))
          : value !== copied[index])) throw new Error(`RAG migration conflict for ${row[0]}`);
      }
      this.db.run('COMMIT');
    } catch (error) { this.db.run('ROLLBACK'); throw error; }
    finally { source.free(); insert.free(); existing.free(); }
  }

  markDirty() { this.dirty = true; }
  flush() {
    if (!this.db || !this.dirty) return;
    this.files.write(Buffer.from(this.db.export()));
    this.dirty = false;
  }
  close() {
    try { this.flush(); }
    finally { this.db?.close(); this.db = null; this.files.release(); }
  }
}

module.exports = { RagFileStore };
