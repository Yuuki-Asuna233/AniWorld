const { saveAvatar, isSafeAvatar, normalizeAvatar } = require('../services/avatar');
/**
 * Auth routes — registration, login, password reset, profile
 * Depends on: database, jwt, bcrypt, sendVerificationEmail, avatarUpload, JWT_SECRET, JWT_EXPIRES
 */

function mountAuthRoutes(app, deps) {
  const { database, jwt, bcrypt, sendVerificationEmail, avatarUpload, JWT_SECRET, JWT_EXPIRES, requireAuth } = deps;

  app.use('/api/auth', require('../middleware/rate-limit').createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 30 }));
  app.use('/api/auth', (req, res, next) => {
    req.body = req.body || {};
    for (const key of ['email', 'username', 'code', 'password', 'confirmPassword', 'currentPassword', 'newPassword']) {
      const value = req.body[key];
      if (value !== undefined && (typeof value !== 'string' || value.length > 254)) {
        return res.status(400).json({ error: '账号信息格式不正确' });
      }
    }
    next();
  });

  const issueToken = user => jwt.sign({ id: user.id, version: user.token_version },
    JWT_SECRET, { algorithm: 'HS256', expiresIn: JWT_EXPIRES });
  const authMutation = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      console.error('[auth] Account operation failed:', error.message);
      if (!res.headersSent) res.status(500).json({ error: '账户操作失败，请稍后重试' });
    }
  };
  const validCode = code => /^\d{6}$/.test(code.trim());

  // POST /api/auth/send-code — Send email verification code
  app.post('/api/auth/send-code', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: '请输入邮箱' });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    const existing = database.getUserByEmail(email);
    if (existing) {
      return res.status(400).json({ error: '该邮箱已被注册' });
    }

    try {
      const domain = email.split('@')[1];
      await new Promise((resolve) => {
        const dns = require('dns');
        const timer = setTimeout(() => { resolve(); }, 3000);
        dns.resolveMx(domain, (err, addresses) => {
          clearTimeout(timer);
          if (err || !addresses || addresses.length === 0) {
            console.log('[auth] No MX records for', domain, '- allowing anyway');
          }
          resolve();
        });
      });
    } catch (e) {
      console.log('[auth] DNS check error, allowing:', e.message);
    }

    const code = String(require('crypto').randomInt(100000, 1000000));
    const expiresAt = Math.floor(Date.now() / 1000) + 180;
    if (!database.saveVerificationCode(email, code, expiresAt)) {
      return res.status(503).json({ error: '验证码暂时无法保存，请稍后重试' });
    }

    try {
      await sendVerificationEmail(email, code, {
        subject: 'AniWorld 邮箱验证邮件',
        title: '邮箱验证',
        intro: '尊敬的用户您好，您正在进行 AniWorld 邮箱验证。',
        logLabel: 'Verification code'
      });
    } catch (e) {
      console.error('[auth] Failed to send email:', e.message);
      if (process.env.SMTP_USER) {
        return res.status(500).json({ error: '邮件发送失败，请稍后重试' });
      }
    }

    res.json({ success: true, message: '验证码已发送，3分钟内有效' });
  });

  // POST /api/auth/register
  app.post('/api/auth/register', authMutation(async (req, res) => {
    const { email, username, password, confirmPassword, code, avatar } = req.body;

    if (!email || !username || !password || !confirmPassword || !code) {
      return res.status(400).json({ error: '请填写所有必填字段' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    if (typeof username !== 'string' || username.trim().length < 1 || username.length > 20) return res.status(400).json({ error: '用户名长度1-20个字符' });
    if (typeof password !== 'string' || password.length < 6 || Buffer.byteLength(password) > 72) return res.status(400).json({ error: '密码至少6个字符，UTF-8编码不超过72字节' });
    if (password !== confirmPassword) return res.status(400).json({ error: '两次密码不一致' });
    if (!validCode(code)) return res.status(400).json({ error: '验证码格式不正确' });

    if (avatar !== undefined && !isSafeAvatar(avatar)) return res.status(400).json({ error: '头像地址不合法' });
    const verified = database.checkVerificationCode(email, code);
    if (!verified) return res.status(400).json({ error: '验证码错误或已过期' });

    const existing = database.getUserByEmail(email);
    if (existing) return res.status(400).json({ error: '该邮箱已被注册' });

    let avatarUrl;
    try { avatarUrl = await normalizeAvatar(avatar || '', 'new'); }
    catch (_) { return res.status(400).json({ error: '头像必须是可解码的光栅图片' }); }
    const passwordHash = await bcrypt.hash(password, 10);
    const result = database.registerVerifiedUser({ email, code, username, passwordHash, avatar: avatarUrl });
    if (result.error) return res.status(result.status).json({ error: result.message });
    const user = result.user;

    const token = issueToken(user);

    res.json({
      success: true, token,
      user: { id: user.id, email: user.email, username: user.username, avatar: user.avatar || '', createdAt: user.created_at || 0 }
    });
  }));

  // POST /api/auth/login
  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (typeof password !== 'string' || Buffer.byteLength(password) > 72) return res.status(400).json({ error: '密码格式不正确' });
    if (!email || !password) return res.status(400).json({ error: '请输入邮箱和密码' });

    const user = database.getUserByEmail(email);
    if (!user) return res.status(400).json({ error: '邮箱或密码错误' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: '邮箱或密码错误' });

    const token = issueToken(user);

    res.json({
      success: true, token,
      user: { id: user.id, email: user.email, username: user.username, avatar: user.avatar || '', createdAt: user.created_at || 0 }
    });
  });

  // GET /api/auth/me
  app.get('/api/auth/me', requireAuth, (req, res) => {
    const user = database.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    res.json({ id: user.id, email: user.email, username: user.username, avatar: user.avatar || '', createdAt: user.created_at || 0 });
  });

  // PUT /api/auth/profile
  app.put('/api/auth/profile', requireAuth, async (req, res) => {
    const { username, avatar } = req.body;
    const updates = {};
    if (username !== undefined) {
      if (typeof username !== 'string' || username.trim().length < 1 || username.length > 20) return res.status(400).json({ error: '用户名长度1-20个字符' });
      updates.username = username;
    }
    if (avatar !== undefined) {
      if (!isSafeAvatar(avatar)) return res.status(400).json({ error: '头像地址不合法' });
      try { updates.avatar = await normalizeAvatar(avatar, req.user.id); }
      catch (_) { return res.status(400).json({ error: '头像必须是可解码的光栅图片' }); }
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: '没有要更新的内容' });

    const updated = database.updateUserProfile(req.user.id, updates);
    if (!updated) return res.status(500).json({ error: '更新失败' });

    const token = issueToken(updated);

    res.json({
      success: true, token,
      user: { id: updated.id, email: updated.email, username: updated.username, avatar: updated.avatar || '', createdAt: updated.created_at || 0 }
    });
  });

  // POST /api/auth/change-email
  // The new address must be verified and the current password must be
  // supplied, so an intercepted session alone cannot silently rebind email.
  app.post('/api/auth/change-email', requireAuth, authMutation(async (req, res) => {
    const { email, code, currentPassword } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail || !code || !currentPassword) {
      return res.status(400).json({ error: '请填写新邮箱、验证码和当前密码' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }
    if (!validCode(code)) return res.status(400).json({ error: '验证码格式不正确' });
    if (Buffer.byteLength(currentPassword) > 72) return res.status(400).json({ error: '当前密码格式不正确' });

    const user = database.getUserById(req.user.id);
    if (!user) return res.status(400).json({ error: '当前密码错误' });
    if (normalizedEmail === String(user.email || '').toLowerCase()) {
      return res.status(400).json({ error: '新邮箱不能与当前邮箱相同' });
    }
    if (database.getUserByEmail(normalizedEmail)) {
      return res.status(400).json({ error: '该邮箱已被注册' });
    }
    if (!database.checkVerificationCode(normalizedEmail, code)) {
      return res.status(400).json({ error: '验证码错误或已过期' });
    }
    if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
      return res.status(400).json({ error: '当前密码错误' });
    }

    const result = database.changeVerifiedEmail({ expectedUser: user, email: normalizedEmail, code });
    if (result.error) return res.status(result.status).json({ error: result.message });
    const updated = result.user;
    const token = issueToken(updated);
    return res.json({
      success: true,
      token,
      message: '邮箱修改成功',
      user: {
        id: updated.id,
        email: updated.email,
        username: updated.username,
        avatar: updated.avatar || '',
        createdAt: updated.created_at || 0,
      },
    });
  }));

  // POST /api/auth/change-password
  app.post('/api/auth/change-password', requireAuth, authMutation(async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: '请填写所有密码字段' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 6 || Buffer.byteLength(newPassword) > 72) {
      return res.status(400).json({ error: '新密码至少6个字符，UTF-8编码不超过72字节' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: '两次新密码不一致' });
    }
    if (Buffer.byteLength(currentPassword) > 72) return res.status(400).json({ error: '当前密码格式不正确' });

    const user = database.getUserById(req.user.id);
    if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
      return res.status(400).json({ error: '当前密码错误' });
    }
    if (await bcrypt.compare(newPassword, user.password_hash)) {
      return res.status(400).json({ error: '新密码不能与当前密码相同' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    const result = database.changeCheckedPassword({ expectedUser: user, passwordHash: newHash });
    if (result.error) return res.status(result.status).json({ error: result.message });
    return res.json({ success: true, message: '密码修改成功，请重新登录' });
  }));

  // POST /api/auth/avatar
  app.post('/api/auth/avatar', requireAuth, (req, res) => {
    avatarUpload.single('avatar')(req, res, async (err) => {
      if (err) {
        if (err.message === '只允许上传图片文件') {
          return res.status(400).json({ error: '只允许上传图片文件（jpg/png/gif/webp等）' });
        }
        return res.status(400).json({ error: '上传失败: ' + err.message });
      }
      if (!req.file) return res.status(400).json({ error: '请选择图片文件' });

      let avatarUrl;
      try { avatarUrl = await saveAvatar(req.file.buffer, req.user.id); }
      catch (error) { return res.status(400).json({ error: '头像必须是可解码的光栅图片' }); }
      const updated = database.updateUserProfile(req.user.id, { avatar: avatarUrl });
      if (!updated) return res.status(500).json({ error: '保存头像失败' });

      const token = issueToken(updated);

      res.json({
        success: true, avatar: avatarUrl, token,
        user: { id: updated.id, email: updated.email, username: updated.username, avatar: updated.avatar || '', createdAt: updated.created_at || 0 }
      });
    });
  });

  // POST /api/auth/send-reset-code
  app.post('/api/auth/send-reset-code', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: '请输入邮箱' });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });

    const user = database.getUserByEmail(email);
    if (!user) return res.status(400).json({ error: '该邮箱未注册' });

    const code = String(require('crypto').randomInt(100000, 1000000));
    const expiresAt = Math.floor(Date.now() / 1000) + 180;
    if (!database.saveVerificationCode(email, code, expiresAt)) {
      return res.status(503).json({ error: '验证码暂时无法保存，请稍后重试' });
    }

    try {
      await sendVerificationEmail(email, code, {
        subject: 'AniWorld 重置密码验证码',
        title: '密码重置',
        intro: '尊敬的用户您好，您正在重置 AniWorld 账号密码。',
        logLabel: 'Password reset code'
      });
    } catch (e) {
      console.error('[auth] Failed to send reset email:', e.message);
      if (process.env.SMTP_USER) return res.status(500).json({ error: '邮件发送失败，请稍后重试' });
    }

    res.json({ success: true, message: '验证码已发送，3分钟内有效' });
  });

  // POST /api/auth/reset-password
  app.post('/api/auth/reset-password', authMutation(async (req, res) => {
    const { email, code, newPassword, confirmPassword } = req.body;
    if (!email || !code || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: '请填写所有必填字段' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 6 || Buffer.byteLength(newPassword) > 72) return res.status(400).json({ error: '新密码至少6个字符，UTF-8编码不超过72字节' });
    if (newPassword !== confirmPassword) return res.status(400).json({ error: '两次密码不一致' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    if (!validCode(code)) return res.status(400).json({ error: '验证码格式不正确' });

    const verified = database.checkVerificationCode(email, code);
    if (!verified) return res.status(400).json({ error: '验证码错误或已过期' });

    const user = database.getUserByEmail(email);
    if (!user) return res.status(400).json({ error: '该邮箱未注册' });
    if (await bcrypt.compare(newPassword, user.password_hash)) {
      return res.status(400).json({ error: '新密码不能与旧密码相同' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    const result = database.resetVerifiedPassword({ expectedUser: user, passwordHash: newHash, email, code });
    if (result.error) return res.status(result.status).json({ error: result.message });

    res.json({ success: true, message: '密码已重置，请使用新密码登录' });
  }));
}

module.exports = { mountAuthRoutes };
