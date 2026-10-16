// ==================== Auth Helpers ====================
const API = '';
const DEFAULT_AVATAR = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="#1a1a2e" width="100" height="100"/><circle cx="50" cy="38" r="20" fill="#555"/><ellipse cx="50" cy="85" rx="35" ry="22" fill="#555"/></svg>');

const {
  clearAuthToken: clearToken,
  escapeHtml,
  getAuthToken: getToken,
  setAuthToken: setToken,
  toast
} = window.SiteUtils;

async function api(method, url, body = null, options = {}) {
  return window.SiteUtils.authJson(method, API + url, body, { cacheBust: true, ...options });
}

function timeAgo(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  if (diff < 604800) return Math.floor(diff / 86400) + '天前';
  return new Date(ts * 1000).toLocaleDateString('zh-CN');
}

// ==================== Render ====================
let currentTab = 'profile';
let renderGeneration = 0, tabGeneration = 0, tabAbort = null;
let displayedSession = null;

function invalidateTabRequest() {
  tabGeneration++;
  tabAbort?.abort();
  tabAbort = null;
}

function beginTabRequest(tab) {
  const container = document.getElementById('tabContent');
  const session = window.SiteUtils.captureAuthSession();
  if (!container || currentTab !== tab || !session.token || !displayedSession?.isCurrent()) return null;
  invalidateTabRequest();
  const generation = tabGeneration, controller = new AbortController();
  tabAbort = controller;
  return { container, session, signal: controller.signal,
    isCurrent: () => !controller.signal.aborted && generation === tabGeneration &&
      currentTab === tab && session.isCurrent() && document.getElementById('tabContent') === container };
}

function authFormRequest() {
  const card = document.getElementById('authCard'), session = window.SiteUtils.captureAuthSession();
  return { session, isCurrent: () => card && card.isConnected &&
    document.getElementById('authCard') === card && session.isCurrent() };
}

async function render() {
  const session = window.SiteUtils.captureAuthSession(), generation = ++renderGeneration;
  invalidateTabRequest();
  displayedSession = null;
  closeEditModal();
  const current = () => generation === renderGeneration && session.isCurrent();
  if (!session.token) {
    renderAuth();
    return;
  }
  document.getElementById('app').innerHTML = '<div class="loading"><div class="spinner"></div>加载中...</div>';
  // Validate token by fetching user info
  try {
    const user = await api('GET', '/api/auth/me', null, { requireSuccess: true, session });
    if (!current()) return;
    if (!user || user.error || !user.id || typeof user.username !== 'string') {
      throw new Error('账户信息响应异常，请重试');
    }
    renderUserCenter(user, session);
  } catch(e) {
    if (!current()) return;
    const credentialErrors = ['请先登录', 'AUTH_REQUIRED', 'INVALID_TOKEN', 'TOKEN_EXPIRED'];
    if (e.status === 401 && credentialErrors.includes(e.data?.error)) {
      clearToken(); renderAuth(); return;
    }
    document.getElementById('app').innerHTML = `
      <div class="empty"><p>暂时无法加载账户信息，请检查网络后重试</p>
        <button class="btn btn-primary" onclick="render()">重试</button>
        <button class="btn btn-logout" onclick="doLogout()">退出登录</button>
      </div>`;
  }
}

// ==================== Auth (Login/Register) ====================
let authMode = 'login'; // 'login' | 'register' | 'reset'
let codeTimer = null;
let codeSeconds = 0;

function renderAuth() {
  renderGeneration++;
  invalidateTabRequest();
  displayedSession = null;
  if (codeTimer) { clearInterval(codeTimer); codeTimer = null; }
  codeSeconds = 0;
  document.getElementById('app').innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card" id="authCard">
        <h2>${authMode === 'login' ? '登录' : authMode === 'register' ? '注册' : '重置密码'}</h2>
        <p class="sub">${authMode === 'login' ? '欢迎回到 AniWorld' : authMode === 'register' ? '创建你的 AniWorld 账号' : '请使用注册邮箱重置密码'}</p>
        ${authMode === 'register' ? renderRegisterForm() : authMode === 'reset' ? renderResetForm() : renderLoginForm()}
        <div class="error-msg" id="authError"></div>
        <div class="success-msg" id="authSuccess"></div>
        <button class="btn btn-primary" id="authSubmit" onclick="${authMode === 'login' ? 'doLogin()' : authMode === 'register' ? 'doRegister()' : 'doResetPassword()'}">
          ${authMode === 'login' ? '登录' : authMode === 'register' ? '注册' : '重置密码'}
        </button>
        <div class="toggle-link">
          ${authMode === 'login'
            ? '还没有账号？<a onclick="switchAuth(\'register\')">立即注册</a><br><br><a onclick="switchAuth(\'reset\')" style="font-size:12px;color:var(--text-dim)">忘记密码？</a>'
            : authMode === 'register'
              ? '已有账号？<a onclick="switchAuth(\'login\')">去登录</a>'
              : '<a onclick="switchAuth(\'login\')">← 返回登录</a>'}
        </div>
      </div>
    </div>
  `;
}

function renderLoginForm() {
  return `
    <div class="form-group">
      <label>邮箱</label>
      <input type="email" id="loginEmail" placeholder="请输入邮箱" autocomplete="email">
    </div>
    <div class="form-group">
      <label>密码</label>
      <input type="password" id="loginPassword" placeholder="请输入密码" autocomplete="current-password" onkeydown="if(event.key==='Enter')doLogin()">
    </div>
  `;
}

function renderRegisterForm() {
  return `
    <div class="form-group">
      <label>头像</label>
      <div class="avatar-upload">
        <img class="avatar-preview" id="regAvatarPreview" src="${DEFAULT_AVATAR}" alt="头像">
        <div class="avatar-actions">
          <input type="file" id="regAvatarFile" accept="image/*" onchange="previewAvatarFile(this,'regAvatarPreview')" style="font-size:13px;color:var(--text-dim);padding:6px 0">
          <span class="avatar-hint">选择图片文件（可选），支持 jpg/png/gif/webp</span>
        </div>
      </div>
    </div>
    <div class="form-group">
      <label>用户名</label>
      <input type="text" id="regUsername" placeholder="给自己起个名字吧" maxlength="20" autocomplete="username">
    </div>
    <div class="form-group">
      <label>邮箱</label>
      <input type="email" id="regEmail" placeholder="请输入真实邮箱" autocomplete="email">
    </div>
    <div class="form-group">
      <label>密码</label>
      <input type="password" id="regPassword" placeholder="至少6个字符" autocomplete="new-password">
    </div>
    <div class="form-group">
      <label>确认密码</label>
      <input type="password" id="regConfirmPassword" placeholder="再次输入密码">
    </div>
    <div class="form-group">
      <label>验证码</label>
      <div class="input-row">
        <input type="text" id="regCode" placeholder="6位验证码" maxlength="6">
        <button class="btn btn-outline btn-sm" id="sendCodeBtn" onclick="sendCode()">获取验证码</button>
      </div>
      <div class="code-timer" id="codeTimerTxt"></div>
    </div>
  `;
}

function renderResetForm() {
  return `
    <div class="form-group">
      <label>注册邮箱</label>
      <input type="email" id="resetEmail" placeholder="请输入注册时使用的邮箱" autocomplete="email">
    </div>
    <div class="form-group">
      <label>新密码</label>
      <input type="password" id="resetNewPassword" placeholder="至少6个字符" autocomplete="new-password">
    </div>
    <div class="form-group">
      <label>确认新密码</label>
      <input type="password" id="resetConfirmPassword" placeholder="再次输入新密码">
    </div>
    <div class="form-group">
      <label>验证码</label>
      <div class="input-row">
        <input type="text" id="resetCode" placeholder="6位验证码" maxlength="6">
        <button class="btn btn-outline btn-sm" id="sendResetCodeBtn" onclick="sendResetCode()">获取验证码</button>
      </div>
      <div class="code-timer" id="codeTimerTxt"></div>
    </div>
  `;
}

function switchAuth(mode) {
  if (codeTimer) { clearInterval(codeTimer); codeTimer = null; }
  codeSeconds = 0;
  authMode = mode;
  renderAuth();
}

function previewAvatarFile(input, previewId) {
  const file = input.files[0];
  if (!file) return;
  // Validate file type
  if (!file.type.startsWith('image/')) {
    toast('请选择图片文件', '#ef4444');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  const preview = document.getElementById(previewId);
  reader.onload = (e) => {
    if (preview?.isConnected && document.getElementById(previewId) === preview) preview.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function uploadAvatar(file, session = window.SiteUtils.captureAuthSession()) {
  if (!file) return null;
  const token = session.token;
  if (!session.isCurrent()) throw new DOMException('账户已切换', 'AbortError');
  if (!token) return null;
  const formData = new FormData();
  formData.append('avatar', file);
  const r = await fetch(API + '/api/auth/avatar', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token },
    body: formData
  });
  const data = await r.json();
  if (!session.isCurrent()) throw new DOMException('账户已切换', 'AbortError');
  if (data.success && data.token) {
    const wasDisplayed = displayedSession?.isCurrent();
    const modal = document.getElementById('editModalOverlay');
    const modalWasCurrent = modal?.authSession?.isCurrent();
    setToken(data.token);
    const renewed = window.SiteUtils.captureAuthSession();
    if (modalWasCurrent) modal.authSession = renewed;
    if (wasDisplayed) {
      displayedSession = renewed;
      loadTabContent();
    } else {
      void render();
    }
  }
  return data;
}

async function uploadAvatarBeforeRegister(file) {
  // For registration, we can't call /api/auth/avatar since user isn't logged in yet
  // Instead we convert the image to base64 data URL and store it temporarily
  // The actual upload happens after registration via saving a data URL
  if (!file) return '';
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(reader.error || new Error('头像读取失败'));
    reader.onabort = () => reject(new DOMException('头像读取已取消', 'AbortError'));
    reader.readAsDataURL(file);
  });
}

async function sendCode() {
  const request = authFormRequest();
  const email = document.getElementById('regEmail')?.value.trim();
  const errEl = document.getElementById('authError');
  const btn = document.getElementById('sendCodeBtn');

  if (!email) { errEl.textContent = '请先输入邮箱'; return; }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) { errEl.textContent = '邮箱格式不正确'; return; }

  if (codeSeconds > 0) { errEl.textContent = `请${codeSeconds}秒后再试`; return; }

  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = '发送中...';

  try {
    const r = await api('POST', '/api/auth/send-code', { email });
    if (!request.isCurrent()) return;
    if (r.success) {
      errEl.textContent = '';
      document.getElementById('authSuccess').textContent = r.message;
      codeSeconds = 60;
      btn.textContent = codeSeconds + 's';
      codeTimer = setInterval(() => {
        if (!request.isCurrent()) { clearInterval(codeTimer); codeTimer = null; return; }
        codeSeconds--;
        if (codeSeconds <= 0) {
          clearInterval(codeTimer);
          btn.textContent = '获取验证码';
          btn.disabled = false;
          document.getElementById('codeTimerTxt').textContent = '';
        } else {
          btn.textContent = codeSeconds + 's';
          document.getElementById('codeTimerTxt').textContent = '验证码已发送，3分钟内有效';
        }
      }, 1000);
    } else {
      errEl.textContent = r.error || '发送失败';
      btn.disabled = false;
      btn.textContent = '获取验证码';
    }
  } catch(e) {
    if (!request.isCurrent()) return;
    errEl.textContent = '网络错误，请重试';
    btn.disabled = false;
    btn.textContent = '获取验证码';
  }
}

async function doLogin() {
  const request = authFormRequest();
  const email = document.getElementById('loginEmail')?.value.trim();
  const password = document.getElementById('loginPassword')?.value;
  const errEl = document.getElementById('authError');

  if (!email || !password) { errEl.textContent = '请填写邮箱和密码'; return; }

  errEl.textContent = '';
  try {
    const r = await api('POST', '/api/auth/login', { email, password }, { session: request.session });
    if (!request.isCurrent()) return;
    if (r.success) {
      setToken(r.token);
      toast('登录成功！');
      render();
    } else {
      errEl.textContent = r.error || '登录失败';
    }
  } catch(e) {
    if (!request.isCurrent()) return;
    errEl.textContent = '网络错误，请重试';
  }
}

async function doRegister() {
  const request = authFormRequest();
  const email = document.getElementById('regEmail')?.value.trim();
  const username = document.getElementById('regUsername')?.value.trim();
  const password = document.getElementById('regPassword')?.value;
  const confirmPassword = document.getElementById('regConfirmPassword')?.value;
  const code = document.getElementById('regCode')?.value.trim();
  const avatarFile = document.getElementById('regAvatarFile')?.files[0];
  const errEl = document.getElementById('authError');

  if (!email || !username || !password || !confirmPassword || !code) {
    errEl.textContent = '请填写所有必填字段'; return;
  }
  if (password.length < 6) { errEl.textContent = '密码至少6个字符'; return; }
  if (password !== confirmPassword) { errEl.textContent = '两次密码不一致'; return; }

  errEl.textContent = '';
  try {
    // Upload avatar if file selected (use base64 for registration)
    let avatar = '';
    if (avatarFile) {
      avatar = await uploadAvatarBeforeRegister(avatarFile);
    }
    if (!request.isCurrent()) return;
    const r = await api('POST', '/api/auth/register', { email, username, password, confirmPassword, code, avatar }, { session: request.session });
    if (!request.isCurrent()) return;
    if (r.success) {
      setToken(r.token);
      toast('注册成功！');
      render();
    } else {
      errEl.textContent = r.error || '注册失败';
    }
  } catch(e) {
    if (!request.isCurrent()) return;
    errEl.textContent = '网络错误，请重试';
  }
}

async function sendResetCode() {
  const request = authFormRequest();
  const email = document.getElementById('resetEmail')?.value.trim();
  const errEl = document.getElementById('authError');
  const btn = document.getElementById('sendResetCodeBtn');

  if (!email) { errEl.textContent = '请先输入邮箱'; return; }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) { errEl.textContent = '邮箱格式不正确'; return; }
  if (codeSeconds > 0) { errEl.textContent = `请${codeSeconds}秒后再试`; return; }

  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = '发送中...';

  try {
    const r = await api('POST', '/api/auth/send-reset-code', { email });
    if (!request.isCurrent()) return;
    if (r.success) {
      errEl.textContent = '';
      document.getElementById('authSuccess').textContent = r.message;
      codeSeconds = 60;
      btn.textContent = codeSeconds + 's';
      codeTimer = setInterval(() => {
        if (!request.isCurrent()) { clearInterval(codeTimer); codeTimer = null; return; }
        codeSeconds--;
        if (codeSeconds <= 0) {
          clearInterval(codeTimer);
          btn.textContent = '获取验证码';
          btn.disabled = false;
          document.getElementById('codeTimerTxt').textContent = '';
        } else {
          btn.textContent = codeSeconds + 's';
          document.getElementById('codeTimerTxt').textContent = '验证码已发送，3分钟内有效';
        }
      }, 1000);
    } else {
      errEl.textContent = r.error || '发送失败';
      btn.disabled = false;
      btn.textContent = '获取验证码';
    }
  } catch(e) {
    if (!request.isCurrent()) return;
    errEl.textContent = '网络错误，请重试';
    btn.disabled = false;
    btn.textContent = '获取验证码';
  }
}

async function doResetPassword() {
  const request = authFormRequest();
  const email = document.getElementById('resetEmail')?.value.trim();
  const code = document.getElementById('resetCode')?.value.trim();
  const newPassword = document.getElementById('resetNewPassword')?.value;
  const confirmPassword = document.getElementById('resetConfirmPassword')?.value;
  const errEl = document.getElementById('authError');

  if (!email || !code || !newPassword || !confirmPassword) {
    errEl.textContent = '请填写所有必填字段'; return;
  }
  if (newPassword.length < 6) { errEl.textContent = '新密码至少6个字符'; return; }
  if (newPassword !== confirmPassword) { errEl.textContent = '两次密码不一致'; return; }

  errEl.textContent = '';
  try {
    const r = await api('POST', '/api/auth/reset-password', { email, code, newPassword, confirmPassword }, { session: request.session });
    if (!request.isCurrent()) return;
    if (r.success) {
      document.getElementById('authSuccess').textContent = '密码已重置！请使用新密码登录';
      document.getElementById('authSubmit').disabled = true;
      toast('密码已重置，请登录');
      setTimeout(() => { if (request.isCurrent()) switchAuth('login'); }, 2000);
    } else {
      errEl.textContent = r.error || '重置失败';
    }
  } catch(e) {
    if (!request.isCurrent()) return;
    errEl.textContent = '网络错误，请重试';
  }
}

// ==================== User Center ====================
async function renderUserCenter(user, session) {
  invalidateTabRequest();
  displayedSession = session;
  document.getElementById('app').innerHTML = `
    <div class="user-center">
      <div class="user-header">
        <img class="user-avatar" id="userAvatar" src="${escapeHtml(window.SiteUtils.safeImageUrl(user.avatar) || DEFAULT_AVATAR)}" alt="头像" onerror="this.src='${DEFAULT_AVATAR}'">
        <div class="user-info">
          <h2 id="displayName">${escapeHtml(user.username)}</h2>
          <p class="email">${escapeHtml(user.email)}</p>
        </div>
        <div class="user-actions">
          <button class="btn btn-edit" onclick="showEditProfile()">编辑资料</button>
          <button class="btn btn-logout" onclick="doLogout()">退出登录</button>
        </div>
      </div>

      <div class="tabs">
        <button class="tab-btn ${currentTab === 'profile' ? 'active' : ''}" onclick="switchTab('profile')">个人资料</button>
        <button class="tab-btn ${currentTab === 'favorites' ? 'active' : ''}" onclick="switchTab('favorites')">我的追番</button>
        <button class="tab-btn ${currentTab === 'history' ? 'active' : ''}" onclick="switchTab('history')">历史记录</button>
      </div>

      <div id="tabContent"><div class="loading"><div class="spinner"></div>加载中...</div></div>
    </div>
  `;
  loadTabContent();
}

function doLogout() {
  clearToken();
  toast('已退出登录');
  currentTab = 'profile';
  authMode = 'login';
  render();
}

async function switchTab(tab) {
  invalidateTabRequest();
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.textContent.includes(
      tab === 'profile' ? '个人资料' : tab === 'favorites' ? '我的追番' : '历史记录'
    ));
  });
  document.getElementById('tabContent').innerHTML = '<div class="loading"><div class="spinner"></div>加载中...</div>';
  await loadTabContent();
}

async function loadTabContent() {
  const container = document.getElementById('tabContent');
  if (currentTab === 'profile') {
    container.innerHTML = renderProfileTab();
  } else if (currentTab === 'favorites') {
    await loadFavoritesTab();
  } else if (currentTab === 'history') {
    await loadHistoryTab();
  }
}

function renderProfileTab() {
  return `
    <div style="padding:20px;background:#111118;border:1px solid var(--border);border-radius:12px">
      <p style="color:var(--text-dim);line-height:1.8;font-size:14px">
        👋 欢迎来到你的个人中心！<br><br>
        在这里你可以：
        <br>• 📌 <b style="color:#fff">追番</b> — 收藏你喜爱的动漫，随时回顾
        <br>• 📺 <b style="color:#fff">查看历史</b> — 从上次观看的进度继续播放
        <br>• ✏️ <b style="color:#fff">编辑资料</b> — 修改用户名和头像
        <br><br>
        点击上方标签页开始探索吧！
      </p>
    </div>
  `;
}

async function loadFavoritesTab() {
  const request = beginTabRequest('favorites');
  if (!request) return;
  const { container } = request;
  container.innerHTML = '<div class="loading"><div class="spinner"></div>加载中...</div>';

  try {
    const r = await api('GET', '/api/user/favorites', null,
      { session: request.session, signal: request.signal, requireSuccess: true });
    if (!request.isCurrent()) return;
    if (!Array.isArray(r?.results)) throw new Error('追番数据格式异常');
    if (r.results && r.results.length > 0) {
      container.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <span style="color:var(--text-dim);font-size:14px;">共 ${r.results.length} 部</span>
          <button onclick="clearAllFavorites()" style="background:#da3633;color:#fff;border:none;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:13px;">🗑️ 清空追番</button>
        </div>
        <div class="content-grid">${r.results.map(f => favCard(f)).join('')}</div>`;
    } else {
      container.innerHTML = `<div class="empty"><div class="icon">📭</div><p>还没有追番，快去发现喜欢的动漫吧！</p></div>`;
    }
  } catch(e) {
    if (!request.isCurrent()) return;
    container.innerHTML = '<div class="empty"><p>加载失败</p></div>';
  }
}

async function clearAllFavorites() {
  if (!displayedSession?.isCurrent()) return;
  const session = window.SiteUtils.captureAuthSession();
  if (!confirm('确定清空所有追番记录？此操作不可撤销。')) return;
  if (!session.isCurrent()) return;
  const btn = document.querySelector('button[onclick="clearAllFavorites()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 清空中...'; }
  try {
    const r = await api('DELETE', '/api/user/favorites/clear', null, { session });
    if (!session.isCurrent()) return;
    if (r && r.success) {
      toast('追番记录已清空');
      await loadFavoritesTab();
    } else {
      toast('清空失败：' + (r?.error || '服务器未响应'), '#da3633');
      if (btn) { btn.disabled = false; btn.textContent = '🗑️ 清空追番'; }
    }
  } catch(e) {
    if (!session.isCurrent()) return;
    toast('操作失败，请检查服务器是否已重启', '#da3633');
    if (btn) { btn.disabled = false; btn.textContent = '🗑️ 清空追番'; }
  }
}

function favCard(f) {
  return `
    <div class="fav-card" data-play="${escapeHtml(JSON.stringify(f))}">
      <img ${window.SiteUtils.coverImageAttributes(f)} alt="" loading="lazy">
      <div class="card-info">
        <div class="card-title">${escapeHtml(f.anime_title)}</div>
        <div class="card-meta">追番时间：${timeAgo(f.created_at)}</div>
      </div>
      <div class="card-time" style="color:#e85d04;font-size:12px">→ 观看</div>
    </div>
  `;
}

async function loadHistoryTab() {
  const request = beginTabRequest('history');
  if (!request) return;
  const { container } = request;
  container.innerHTML = '<div class="loading"><div class="spinner"></div>加载中...</div>';

  try {
    const r = await api('GET', '/api/user/history', null,
      { session: request.session, signal: request.signal, requireSuccess: true });
    if (!request.isCurrent()) return;
    if (!Array.isArray(r?.results)) throw new Error('历史数据格式异常');
    if (r.results && r.results.length > 0) {
      container.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <span style="color:var(--text-dim);font-size:14px;">共 ${r.results.length} 条</span>
          <button onclick="clearAllHistory()" style="background:#da3633;color:#fff;border:none;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:13px;">🗑️ 清空历史</button>
        </div>
        <div class="content-grid">${r.results.map(h => histCard(h)).join('')}</div>`;
      initHistorySwipe();
    } else {
      container.innerHTML = `<div class="empty"><div class="icon">🕐</div><p>还没有观看记录</p></div>`;
    }
  } catch(e) {
    if (!request.isCurrent()) return;
    container.innerHTML = '<div class="empty"><p>加载失败</p></div>';
  }
}

async function clearAllHistory() {
  if (!displayedSession?.isCurrent()) return;
  const session = window.SiteUtils.captureAuthSession();
  if (!confirm('确定清空所有观看历史？此操作不可撤销。')) return;
  if (!session.isCurrent()) return;
  const btn = document.querySelector('button[onclick="clearAllHistory()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 清空中...'; }
  try {
    const r = await api('DELETE', '/api/user/history/clear', null, { session });
    if (!session.isCurrent()) return;
    if (r && r.success) {
      toast('观看历史已清空');
      await loadHistoryTab();
    } else {
      toast('清空失败：' + (r?.error || '服务器未响应'), '#da3633');
      if (btn) { btn.disabled = false; btn.textContent = '🗑️ 清空历史'; }
    }
  } catch(e) {
    if (!session.isCurrent()) return;
    toast('操作失败，请检查服务器是否已重启', '#da3633');
    if (btn) { btn.disabled = false; btn.textContent = '🗑️ 清空历史'; }
  }
}

function histCard(h) {
  const progressPct = Math.max(0, Math.min(100, Math.round(Number(h.progress) || 0)));
  const seconds = Math.max(0, Math.floor(Number(h.position_seconds) || 0));
  const progressText = h.position_seconds != null && !(h.duration_seconds > 0)
    ? `已观看 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : `${progressPct}%`;
  const epInfo = h.episode_title || (h.episode_number ? '第' + h.episode_number + '集' : '');
  return `
    <div class="hist-card" data-history-id="${escapeHtml(encodeURIComponent(h.anime_id))}" data-play="${escapeHtml(JSON.stringify(h))}">
      <img ${window.SiteUtils.coverImageAttributes(h)} alt="" loading="lazy">
      <div class="card-info">
        <div class="card-title">${escapeHtml(h.anime_title)}</div>
        <div class="card-meta">${escapeHtml(epInfo)}</div>
        <div class="card-progress">
          <div class="card-progress-bar"><div class="fill" style="width:${progressPct}%"></div></div>
          <span class="card-progress-text">${progressText}</span>
        </div>
      </div>
      <button type="button" class="hist-delete-btn" aria-label="删除记录">删除记录</button>
      <div class="card-time">${timeAgo(h.updated_at)}</div>
    </div>
  `;
}

async function deleteHistoryRecord(event, encodedAnimeId) {
  event.preventDefault();
  event.stopPropagation();
  await confirmDeleteHistoryRecord(decodeURIComponent(encodedAnimeId));
}

async function confirmDeleteHistoryRecord(animeId) {
  if (!displayedSession?.isCurrent()) return;
  const session = window.SiteUtils.captureAuthSession();
  if (!confirm('确定删除这条历史记录吗？')) return;
  if (!session.isCurrent()) return;
  try {
    const r = await api('DELETE', '/api/user/history/' + encodeURIComponent(animeId), null, { session });
    if (!session.isCurrent()) return;
    if (r && r.success) {
      toast('历史记录已删除');
      await loadHistoryTab();
    } else {
      toast('删除失败：' + (r?.error || '服务器未响应'), '#da3633');
    }
  } catch(e) {
    if (!session.isCurrent()) return;
    toast('操作失败，请检查服务器是否已重启', '#da3633');
  }
}

function initHistorySwipe() {
  document.querySelectorAll('.hist-card').forEach(card => {
    let startX = 0, startY = 0;
    card.addEventListener('touchstart', e => {
      if (!e.touches || e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });
    card.addEventListener('touchend', e => {
      const touch = e.changedTouches && e.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (dx < -70 && Math.abs(dy) < 45) {
        e.preventDefault();
        e.stopPropagation();
        card.dataset.skipClick = '1';
        card.classList.add('swipe-hint');
        setTimeout(() => card.classList.remove('swipe-hint'), 180);
        confirmDeleteHistoryRecord(decodeURIComponent(card.dataset.historyId || ''));
      }
    });
  });
}

function goPlay(msg, n, animeId) {
  window.location.href = `anime.html?msg=${encodeURIComponent(msg)}&n=${n}`;
}

function goPlayProgress(msg, n, animeId, episodeNumber, progress, position = null) {
  window.location.href = `anime.html?msg=${encodeURIComponent(msg)}&n=${n}&ep=${encodeURIComponent(episodeNumber)}&progress=${Number(progress) || 0}${position !== null ? `&position=${Number(position) || 0}` : ''}`;
}

// ==================== Edit Profile Modal ====================
function showEditProfile() {
  if (!displayedSession?.isCurrent()) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'editModalOverlay';
  overlay.authSession = displayedSession;
  
  const currentName = document.getElementById('displayName')?.textContent || '';
  const currentAvatar = document.getElementById('userAvatar')?.src || '';

  overlay.innerHTML = `
    <div class="modal">
      <h3>编辑资料</h3>
      <div class="form-group">
        <label>头像</label>
        <div class="avatar-upload">
          <img class="avatar-preview" id="editAvatarPreview" src="${escapeHtml(window.SiteUtils.safeImageUrl(currentAvatar) || DEFAULT_AVATAR)}" alt="头像" onerror="this.src='${DEFAULT_AVATAR}'">
          <div class="avatar-actions">
            <input type="file" id="editAvatarFile" accept="image/*" onchange="previewAvatarFile(this,'editAvatarPreview')" style="font-size:13px;color:var(--text-dim);padding:6px 0">
            <span class="avatar-hint">选择图片文件，留空保持当前头像</span>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>用户名</label>
        <input type="text" id="editUsername" value="${escapeHtml(currentName)}" maxlength="20">
      </div>
      <div class="form-group">
        <div class="error-msg" id="editError"></div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-cancel" onclick="closeEditModal()">取消</button>
        <button class="btn btn-save" onclick="saveProfile()">保存</button>
      </div>
    </div>
  `;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeEditModal();
  });

  document.body.appendChild(overlay);
}

function closeEditModal() {
  document.getElementById('editModalOverlay')?.remove();
}

async function saveProfile() {
  const overlay = document.getElementById('editModalOverlay');
  let session = overlay?.authSession;
  const current = () => session?.isCurrent() && overlay?.isConnected &&
    document.getElementById('editModalOverlay') === overlay;
  if (!current()) return;
  const username = document.getElementById('editUsername')?.value.trim();
  const avatarFile = document.getElementById('editAvatarFile')?.files[0];
  const errEl = document.getElementById('editError');

  if (!username) { errEl.textContent = '用户名不能为空'; return; }
  if (username.length > 20) { errEl.textContent = '用户名最多20个字符'; return; }

  try {
    // Upload avatar if new file selected
    if (avatarFile) {
      const avResult = await uploadAvatar(avatarFile, session);
      if (avResult?.success && avResult.token) {
        if (getToken() !== avResult.token) return;
        session = window.SiteUtils.captureAuthSession();
        overlay.authSession = session;
      }
      if (!current()) return;
      if (!avResult || !avResult.success) {
        errEl.textContent = (avResult && avResult.error) || '头像上传失败';
        return;
      }
      // Token already updated by uploadAvatar
    }
    // Always update username
    const r = await api('PUT', '/api/auth/profile', { username }, { session });
    if (!current()) return;
    if (r.success) {
      setToken(r.token);
      closeEditModal();
      toast('资料已更新');
      render();
    } else {
      errEl.textContent = r.error || '更新失败';
    }
  } catch(e) {
    if (!current()) return;
    errEl.textContent = '网络错误';
  }
}

// ==================== Init ====================
window.addEventListener('storage', event => {
  if (event.key === 'anime_token' || event.key === null) void render();
});
render();

// Keep untrusted catalogue/user strings in data, never in executable HTML.
document.addEventListener('click', event => {
  const card = event.target.closest('[data-play]');
  if (!card) return;
  const item = JSON.parse(card.dataset.play);
  if (event.target.closest('.hist-delete-btn')) {
    return deleteHistoryRecord(event, encodeURIComponent(item.anime_id));
  }
  if (card.dataset.skipClick === '1') { card.dataset.skipClick = '0'; return; }
  const n = Math.max(1, parseInt(item.anime_n, 10) || 1);
  if (card.classList.contains('hist-card')) {
    goPlayProgress(item.anime_msg || item.anime_title, n, item.anime_id,
      item.episode_number || '1', item.progress, item.position_seconds);
  } else goPlay(item.anime_msg || item.anime_title, n, item.anime_id);
});
