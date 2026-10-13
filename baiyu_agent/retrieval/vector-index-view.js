const { throwIfAborted } = require('../shared/runtime');

// Decoded pages are immutable within an index revision. Keep a bounded prefix:
// an index larger than the budget must not evict every page on every scan.
class VectorIndexView {
  constructor(database, decode, maxBytes = 64 * 1024 * 1024) {
    this.database = database;
    this.decode = decode;
    this.maxBytes = maxBytes;
    this.pages = new Map();
    this.bytes = 0;
    this.revision = null;
    this.active = false;
    this.waiting = [];
  }

  acquire(signal) {
    throwIfAborted(signal);
    if (!this.active) { this.active = true; return Promise.resolve(); }
    if (this.waiting.length >= 16) return Promise.reject(new Error('RAG_SCAN_BUSY'));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, abort: null };
      entry.abort = () => {
        this.waiting = this.waiting.filter(item => item !== entry);
        reject(signal.reason || new Error('RAG_SCAN_CANCELLED'));
      };
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.waiting.push(entry);
    });
  }

  release() {
    const entry = this.waiting.shift();
    if (!entry) { this.active = false; return; }
    entry.signal?.removeEventListener('abort', entry.abort);
    entry.resolve();
  }

  async run(signal, operation) {
    await this.acquire(signal);
    try { throwIfAborted(signal); return await operation(); }
    finally { this.release(); }
  }

  async *scan(model, options = {}) {
    const version = this.database.getRagIndexVersion();
    const revision = `${model}:${version}`;
    if (revision !== this.revision) {
      this.pages.clear(); this.bytes = 0; this.revision = revision;
    }
    let afterId = '';
    while (true) {
      throwIfAborted(options.signal);
      if (version !== this.database.getRagIndexVersion()) throw new Error('RAG_INDEX_CHANGED');
      let page = this.pages.get(afterId);
      if (!page) {
        const rows = this.database.getRagChunkPage(model, afterId, 1000);
        if (!rows.length) return;
        page = rows.map(row => ({ ...row, embedding: undefined,
          vector: this.decode(row.embedding, Number(row.embedding_dimensions) || 0),
          document: `${row.source_title || ''} ${row.chunk_text || ''}`.toLowerCase() }));
        const bytes = page.reduce((total, row) => total + row.vector.byteLength
          + (JSON.stringify({ ...row, vector: undefined }).length * 2) + 512, 0);
        if (this.bytes + bytes <= this.maxBytes) { this.pages.set(afterId, page); this.bytes += bytes; }
      }
      afterId = page.at(-1).id;
      yield page.filter(row => options.allowWebFallback || row.source_type !== 'web');
      await new Promise(resolve => setImmediate(resolve));
    }
  }
}

module.exports = { VectorIndexView };
