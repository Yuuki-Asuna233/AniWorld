const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

// sql.js owns a complete in-memory snapshot. Only one process may own the file.
class DatabaseFileStore {
  constructor(filename) {
    this.filename = filename;
    this.lockPath = `${filename}.lock`;
    this.owner = { pid: process.pid, host: os.hostname(), token: randomUUID() };
    this.locked = false;
  }

  acquire() {
    this.filename = fs.existsSync(this.filename) ? fs.realpathSync(this.filename)
      : path.join(fs.realpathSync(path.dirname(this.filename)), path.basename(this.filename));
    this.lockPath = `${this.filename}.lock`;
    return this.withGuard(() => this.acquireOwnedLock());
  }

  // Serialize acquisition, stale-owner recovery and release across processes.
  // A corrupt or abandoned guard fails closed; it is never blindly removed.
  withGuard(operation) {
    const guardPath = `${this.lockPath}.guard`;
    const fd = fs.openSync(guardPath, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(this.owner));
      return operation();
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(guardPath);
    }
  }

  acquireOwnedLock() {
    try {
      const fd = fs.openSync(this.lockPath, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify(this.owner)); }
      finally { fs.closeSync(fd); }
      this.locked = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || !owner.token) {
        throw new Error('Database lock owner is invalid; manual verification required');
      }
      if (owner.host !== os.hostname()) throw new Error('Database is locked by another host');
      try { process.kill(owner.pid, 0); }
      catch (probeError) {
        if (probeError.code === 'ESRCH') {
          const current = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
          if (current.token !== owner.token || current.pid !== owner.pid || current.host !== owner.host) {
            throw new Error('Database lock ownership changed during recovery');
          }
          fs.unlinkSync(this.lockPath);
          return this.acquireOwnedLock();
        }
      }
      throw new Error(`Database is owned by process ${owner.pid}; stop it before running a data script`);
    }
  }

  write(data) {
    if (!this.locked) throw new Error('Database file is not owned by this process');
    const temporary = `${this.filename}.${this.owner.token}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx');
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.filename);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  release() {
    if (!this.locked) return;
    this.withGuard(() => {
      const owner = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      if (owner.token !== this.owner.token) throw new Error('Database lock ownership changed');
      fs.unlinkSync(this.lockPath);
    });
    this.locked = false;
  }
}

module.exports = { DatabaseFileStore };
