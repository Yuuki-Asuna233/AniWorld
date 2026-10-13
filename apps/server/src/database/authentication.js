// Password/image work happens in the routes. Only synchronous validation and
// writes belong here, so another request cannot interleave with code consumption.
function createAuthenticationRepository({ getDb, scheduleSave, flushDatabase }) {
  const rows = (sql, args = []) => {
    const result = getDb().exec(sql, args)[0];
    return result ? result.values.map(row => Object.fromEntries(result.columns.map((key, i) => [key, row[i]]))) : [];
  };
  const normalizeEmail = email => String(email).trim().toLowerCase();
  function reject(error, message, status = 400) { throw Object.assign(new Error(message), { authError: error, status }); }

  function verification(email, code) {
    return rows(`SELECT id FROM email_verifications
      WHERE email = ? AND code = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1`,
    [normalizeEmail(email), String(code).trim(), Math.floor(Date.now() / 1000)])[0];
  }

  function checkVerificationCode(email, code) { return Boolean(verification(email, code)); }

  function consumeCode(email, code) {
    if (!verification(email, code)) reject('invalid_code', '验证码错误或已过期');
    // Also consume duplicate records of the same value: issuing a colliding
    // code must not make that value reusable after a successful operation.
    getDb().run('UPDATE email_verifications SET used = 1 WHERE email = ? AND code = ? AND used = 0',
      [normalizeEmail(email), String(code).trim()]);
  }

  function currentUser(expected) {
    const user = rows('SELECT * FROM users WHERE id = ?', [expected.id])[0];
    if (!user || user.email !== expected.email || user.password_hash !== expected.password_hash ||
        user.token_version !== expected.token_version) {
      reject('account_changed', '账户信息已变更，请重新验证后重试', 409);
    }
    return user;
  }

  function availableEmail(email) {
    if (rows('SELECT id FROM users WHERE email = ?', [normalizeEmail(email)]).length) {
      reject('email_registered', '该邮箱已被注册');
    }
  }

  function commit(work) {
    const db = getDb();
    let inTransaction = false;
    let committed = false;
    try {
      db.run('BEGIN TRANSACTION');
      inTransaction = true;
      const user = work(db);
      db.run('COMMIT');
      inTransaction = false;
      committed = true;
      scheduleSave();
      flushDatabase();
      return { user };
    } catch (error) {
      if (inTransaction) { try { db.run('ROLLBACK'); } catch (_) {} }
      if (error.authError) return { error: error.authError, message: error.message, status: error.status };
      console.error('[DB] Authentication commit failed:', error.message);
      // A failed file flush after COMMIT is an unknown outcome, not a rejected
      // mutation. Keep the dirty snapshot for the existing persistence retry.
      return committed
        ? { error: 'outcome_unknown', message: '账户操作提交结果暂时无法确认，请稍后登录检查', status: 503 }
        : { error: 'commit_failed', message: '账户操作失败，请稍后重试', status: 500 };
    }
  }

  function registerVerifiedUser({ email, code, username, passwordHash, avatar = '' }) {
    return commit(db => {
      availableEmail(email);
      consumeCode(email, code);
      db.run('INSERT INTO users (email, username, password_hash, avatar) VALUES (?, ?, ?, ?)',
        [normalizeEmail(email), username.trim(), passwordHash, avatar]);
      return rows('SELECT * FROM users WHERE id = last_insert_rowid()')[0];
    });
  }

  function changeVerifiedEmail({ expectedUser, email, code }) {
    return commit(db => {
      const user = currentUser(expectedUser);
      if (user.email === normalizeEmail(email)) reject('same_email', '新邮箱不能与当前邮箱相同');
      availableEmail(email);
      consumeCode(email, code);
      db.run('UPDATE users SET email = ?, token_version = token_version + 1 WHERE id = ?', [normalizeEmail(email), user.id]);
      return rows('SELECT * FROM users WHERE id = ?', [user.id])[0];
    });
  }

  function commitPassword(expectedUser, passwordHash, verificationInput) {
    return commit(db => {
      const user = currentUser(expectedUser);
      if (verificationInput) {
        const { email, code } = verificationInput;
        if (user.email !== normalizeEmail(email)) reject('account_changed', '账户信息已变更，请重新验证后重试', 409);
        consumeCode(email, code);
      }
      db.run('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [passwordHash, user.id]);
      return rows('SELECT * FROM users WHERE id = ?', [user.id])[0];
    });
  }

  function changeCheckedPassword({ expectedUser, passwordHash }) {
    return commitPassword(expectedUser, passwordHash);
  }

  function resetVerifiedPassword({ expectedUser, passwordHash, email, code }) {
    return commitPassword(expectedUser, passwordHash, { email, code });
  }

  return { checkVerificationCode, registerVerifiedUser, changeVerifiedEmail, changeCheckedPassword, resetVerifiedPassword };
}

module.exports = { createAuthenticationRepository };
