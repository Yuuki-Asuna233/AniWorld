(function () {
  if (window.customElements?.get('anime-agent')) return;

  const AGENT_CONFIG = window.AnimeAgentConfig || {};
  const listFromConfig = (value, fallback) => Array.isArray(value) && value.length ? value : fallback;
  const WELCOME_TEXT = AGENT_CONFIG.welcomeText || '你好，我是白羽，AniWorld 动漫助手。可以让我帮你找动漫、查更新，或者登录后根据追番和观看记录做个性化推荐。';
  const DEFAULT_SUGGESTIONS = listFromConfig(AGENT_CONFIG.defaultSuggestions, ['根据我的记录推荐', '推荐几部轻松治愈番', '最近有什么高分新番']);
  const DEFAULT_AVATAR = AGENT_CONFIG.defaultAvatar || ('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="#1a202a" width="100" height="100"/><circle cx="50" cy="36" r="19" fill="#5d6a79"/><ellipse cx="50" cy="84" rx="35" ry="22" fill="#5d6a79"/></svg>'));
  const AGENT_MASCOT = AGENT_CONFIG.mascotImage || '/assets/agent/shiraha-stand-ui.webp';
  const MASCOT_LINES = listFromConfig(AGENT_CONFIG.mascotLines, [
    '\u627e\u756a\u3001\u67e5\u66f4\u65b0\uff0c\u4ea4\u7ed9\u767d\u7fbd\u5427\uff5e',
    '\u4eca\u5929\u60f3\u770b\u4ec0\u4e48\u756a\uff1f',
    '\u6211\u53ef\u4ee5\u5e2e\u4f60\u6311\u4e00\u90e8\u3002',
    '\u6709\u65b0\u756a\u60f3\u67e5\u5417\uff1f',
    '\u4e0d\u60f3\u88ab\u5267\u900f\u7684\u8bdd\uff0c\u6211\u4f1a\u5c0f\u5fc3\u54e6\u3002',
    '\u6cbb\u6108\u3001\u70ed\u8840\u3001\u604b\u7231\uff0c\u90fd\u53ef\u4ee5\u95ee\u6211\u3002'
  ]);

  const styles = `
    :host{--agent-accent:#e85d04;--agent-bg:#10151c;--agent-panel:#161b22;--agent-border:#30363d;--agent-text:#e6edf3;--agent-muted:#8b949e;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;position:fixed;right:22px;bottom:22px;z-index:2147483000;color:var(--agent-text)}
    *{box-sizing:border-box}.launcher{width:156px;height:225px;border:0;background:transparent;color:#fff;cursor:pointer;display:flex;align-items:flex-end;justify-content:center;padding:0;position:relative;filter:drop-shadow(0 16px 22px rgba(0,0,0,.45)) drop-shadow(0 0 18px rgba(232,93,4,.22));transition:filter .2s}.launcher::before{content:"";position:absolute;left:22px;right:22px;bottom:4px;height:20px;border-radius:50%;background:radial-gradient(ellipse,rgba(232,93,4,.38),rgba(232,93,4,0) 68%);z-index:-1}.launcher::after{content:"";position:absolute;right:16px;top:39px;width:10px;height:10px;border-radius:50%;background:#ff8a2a;box-shadow:0 0 15px rgba(255,138,42,.9)}.launcher:hover{filter:drop-shadow(0 18px 24px rgba(0,0,0,.5)) drop-shadow(0 0 24px rgba(232,93,4,.34)) saturate(1.05)}.launcher.open{transform:translateY(-3px)}.launcher.busy::after{content:"?";width:32px;height:22px;border-radius:999px;right:4px;top:26px;background:#fff;color:#e85d04;border:1px solid rgba(232,93,4,.45);font-size:16px;line-height:17px;font-weight:900;box-shadow:0 8px 20px rgba(0,0,0,.28)}
    .panel{position:absolute;right:0;bottom:188px;width:min(760px,calc(100vw - 28px));height:min(650px,calc(100vh - 250px));background:rgba(16,21,28,.98);border:1px solid var(--agent-border);border-radius:18px;box-shadow:0 22px 70px rgba(0,0,0,.5);display:none;overflow:hidden;grid-template-rows:auto 1fr}.panel.open{display:grid}
    .head{display:flex;align-items:center;gap:10px;padding:14px 15px;background:var(--agent-panel);border-bottom:1px solid var(--agent-border)}.brand{min-width:0;flex:1}.brand strong{display:block;color:#fff;font-size:15px}.brand small{display:block;color:var(--agent-muted);font-size:11px;margin-top:2px}.head button{border:0;background:transparent;color:var(--agent-muted);cursor:pointer;font-size:18px;padding:4px 6px;border-radius:8px}.head button:hover{color:#fff;background:#202833}.history-toggle{display:none}
    .body{min-height:0;display:grid;grid-template-columns:220px 1fr}.chat{min-width:0;min-height:0;display:grid;grid-template-rows:1fr auto}
    .sidebar{min-width:0;min-height:0;background:#0d1117;border-right:1px solid var(--agent-border);display:flex;flex-direction:column}.side-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px;border-bottom:1px solid var(--agent-border)}.side-head strong{font-size:13px;color:#fff}.side-head button{border:1px solid #3a414b;background:#151b23;color:#c9d1d9;border-radius:8px;padding:5px 8px;font-size:12px;cursor:pointer}.side-head button:hover{border-color:var(--agent-accent);color:#fff}.session-list{flex:1;min-height:0;overflow:auto;padding:8px;display:flex;flex-direction:column;gap:7px;scrollbar-width:thin}.session-empty,.session-hint{color:var(--agent-muted);font-size:12px;line-height:1.6;padding:10px}.session-item{width:100%;border:1px solid transparent;background:transparent;color:inherit;border-radius:11px;padding:9px;text-align:left;cursor:pointer;display:grid;gap:4px;position:relative}.session-item:hover{background:#151b23;border-color:#2f3742}.session-item.active{background:#1d2632;border-color:var(--agent-accent)}.session-title{font-size:13px;font-weight:700;color:#fff;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;padding-right:20px}.session-time{font-size:11px;color:var(--agent-muted)}.session-delete{position:absolute;right:6px;top:6px;width:22px;height:22px;border:0;background:transparent;color:#6e7681;border-radius:7px;cursor:pointer}.session-delete:hover{background:#2a1111;color:#ffb4a8}.account-wrap{position:relative;border-top:1px solid var(--agent-border);padding:10px}.account-button{width:100%;border:1px solid transparent;background:transparent;color:inherit;border-radius:12px;padding:8px;display:flex;align-items:center;gap:10px;cursor:pointer;text-align:left}.account-button:hover,.account-button.open{background:#151b23;border-color:#2f3742}.account-avatar{width:34px;height:34px;border-radius:50%;object-fit:cover;background:#1a202a;border:1px solid #364150;flex:0 0 auto}.account-copy{min-width:0;display:grid;gap:2px}.account-name{font-size:13px;font-weight:700;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.account-status{font-size:11px;color:var(--agent-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.account-menu{position:absolute;left:10px;right:10px;bottom:61px;background:#151b23;border:1px solid var(--agent-border);border-radius:13px;box-shadow:0 16px 40px rgba(0,0,0,.45);padding:10px;display:grid;gap:8px;z-index:5}.account-menu[hidden]{display:none}.account-menu strong{font-size:13px;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.account-menu small{font-size:11px;color:var(--agent-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.account-action{width:100%;border:1px solid #3a414b;background:#0d1117;color:#c9d1d9;border-radius:9px;padding:7px 9px;font-size:12px;cursor:pointer;text-align:center}.account-action:hover{border-color:var(--agent-accent);color:#fff}.account-action.danger:hover{border-color:#f85149;color:#ffb4a8}
    .messages{overflow:auto;padding:15px;display:flex;flex-direction:column;gap:13px;scrollbar-width:thin}.msg{display:flex;flex-direction:column;gap:8px}.msg.user{align-items:flex-end}.bubble{max-width:88%;border-radius:14px;padding:10px 12px;font-size:14px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;background:#202833;color:var(--agent-text)}.user .bubble{background:var(--agent-accent);color:#fff;border-bottom-right-radius:4px}.assistant .bubble{border-bottom-left-radius:4px}.assistant .bubble.thinking,.bubble.thinking{background:transparent;color:var(--agent-muted);padding:2px 0;border-radius:0;box-shadow:none;max-width:none;font-size:13px}
    .cards{display:flex;gap:9px;overflow-x:auto;padding:1px 0 5px;scroll-snap-type:x proximity}.card{flex:0 0 152px;background:var(--agent-panel);border:1px solid var(--agent-border);border-radius:11px;overflow:hidden;color:inherit;text-decoration:none;scroll-snap-align:start;transition:.2s}.card:hover{border-color:var(--agent-accent);transform:translateY(-2px)}.card img{width:100%;height:190px;object-fit:cover;background:#0d1117;display:block}.card-body{padding:9px}.card-title{font-size:13px;font-weight:700;color:#fff;line-height:1.35;min-height:35px}.card-meta{font-size:11px;color:var(--agent-muted);margin-top:5px}.card-reason{font-size:11px;color:#c9d1d9;line-height:1.45;margin-top:6px}.card-actions{padding:0 9px 9px}.dislike{border:0;background:transparent;color:#7d8590;font-size:11px;cursor:pointer;padding:0}.dislike:hover{color:#f97316}.dislike:disabled{opacity:.5}
    .suggestions{display:flex;gap:7px;overflow-x:auto;padding:0 15px 10px}.chip{flex:0 0 auto;border:1px solid #3a414b;background:#151b23;color:#c9d1d9;border-radius:999px;padding:6px 10px;font-size:12px;cursor:pointer}.chip:hover{border-color:var(--agent-accent);color:#fff}
    .composer{border-top:1px solid var(--agent-border);background:var(--agent-panel);padding:11px}.input-row{display:flex;align-items:flex-end;gap:8px;background:#0d1117;border:1px solid var(--agent-border);border-radius:13px;padding:7px}.input-row:focus-within{border-color:var(--agent-accent)}textarea{flex:1;resize:none;max-height:100px;min-height:24px;background:transparent;border:0;outline:0;color:#fff;font:inherit;font-size:14px;line-height:1.5;padding:2px 4px}textarea::placeholder{color:#6e7681}.send{width:34px;height:34px;flex:0 0 auto;border:0;border-radius:9px;background:var(--agent-accent);color:#fff;cursor:pointer;font-size:16px}.send:disabled{opacity:.45;cursor:not-allowed}.foot{font-size:10px;color:#6e7681;text-align:center;margin-top:7px}
    @keyframes mascotBreath{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-1px) scale(1.004)}}@keyframes mascotTinyNod{0%,100%{transform:rotate(0) translateY(0)}35%{transform:rotate(.7deg) translateY(1px)}70%{transform:rotate(-.4deg) translateY(0)}}@keyframes mascotTinyTilt{0%,100%{transform:rotate(0)}30%{transform:rotate(-1.1deg)}68%{transform:rotate(.8deg)}}.launcher{animation:none!important;transform:none!important;width:120px;height:182px}.launcher:hover{animation:none!important}.static-mascot{position:relative;width:116px;height:176px;display:block;pointer-events:none;transform-origin:50% 100%;animation:mascotBreath 5.2s ease-in-out infinite}.launcher-avatar{width:116px;height:176px;object-fit:contain;object-position:bottom center;display:block;pointer-events:none;transform-origin:50% 92%}.launcher.mascot-nod .launcher-avatar{animation:mascotTinyNod .95s ease-in-out 1}.launcher.mascot-tilt .launcher-avatar{animation:mascotTinyTilt 1.15s ease-in-out 1}.mascot-speech{position:absolute;left:-92px;top:76px;max-width:104px;background:#fff;color:#26313d;border:1px solid rgba(232,93,4,.36);border-radius:12px;padding:7px 9px;font-size:11px;font-weight:700;line-height:1.45;text-align:left;box-shadow:0 10px 24px rgba(0,0,0,.18);white-space:normal;pointer-events:none;opacity:0;transform:translateX(6px) scale(.98);transition:opacity .22s ease,transform .22s ease}.mascot-speech::after{content:"";position:absolute;right:-7px;top:18px;border-width:6px 0 6px 7px;border-style:solid;border-color:transparent transparent transparent #fff}.launcher.speaking .mascot-speech{opacity:1;transform:translateX(0) scale(1)}
    @media(max-width:760px){:host{right:8px;bottom:8px}.panel,.panel.guest{position:fixed;inset:0;width:100vw;height:100dvh;border-radius:0;border:0}.launcher{display:none!important}.mascot-stage{width:84px;height:128px}.static-mascot{width:84px;height:128px}.launcher-avatar{width:84px;height:128px}.mascot-speech{left:-84px;top:50px;max-width:88px;font-size:10px;padding:6px 8px}.history-toggle{display:inline-flex}.body{display:block;position:relative}.sidebar{position:absolute;z-index:2;inset:0 auto 0 0;width:min(280px,82vw);transform:translateX(-105%);transition:.2s;box-shadow:18px 0 45px rgba(0,0,0,.45)}.panel.sidebar-open .sidebar{transform:translateX(0)}.chat{height:100%}.card{flex-basis:145px}.card img{height:181px}}
  `;

  class AnimeAgent extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.busy = false;
      this.sessionListGeneration = 0;
      this.sessionLoadGeneration = 0;
      this.abortController = null;
      this.requestId = '';
      this.sessions = [];
      this.user = null;
      this.userLoading = false;
      this.currentToken = window.SiteUtils.getAuthToken() || '';
      this.currentSessionKey = this.sessionKey();
      this.sessionId = localStorage.getItem(this.sessionKey()) || '';
      this.mascotTimer = null;
      this.mascotSpeechTimer = null;
      this.mascotActionTimer = null;
    }

    connectedCallback() {
      this.render();
      this.bind();
      this.refreshAuthState();
      if (this.hasToken()) {
        const owner = this.sessionKey(), generation = this.sessionLoadGeneration;
        this.loadSessions().then(() => {
          if (!this.isConnected || this.busy || owner !== this.sessionKey() || generation !== this.sessionLoadGeneration) return;
          if (this.sessionId) this.loadSession(this.sessionId);
          else this.showWelcome();
        });
      } else {
        this.showWelcome();
      }
      window.addEventListener('storage', event => {
        if (event.key === 'anime_token') this.handleAuthChanged();
      });
      window.addEventListener('focus', () => this.handleAuthChanged());
      window.addEventListener('pageshow', () => this.handleAuthChanged());
      this.authTimer = window.setInterval(() => this.handleAuthChanged(), 2500);
      this.startMascotIdle();
    }

    disconnectedCallback() {
      this.sessionListGeneration++;
      this.sessionLoadGeneration++;
      if (this.authTimer) window.clearInterval(this.authTimer);
      if (this.mascotTimer) window.clearTimeout(this.mascotTimer);
      if (this.mascotSpeechTimer) window.clearTimeout(this.mascotSpeechTimer);
      if (this.mascotActionTimer) window.clearTimeout(this.mascotActionTimer);
    }

    hasToken() {
      return Boolean(window.SiteUtils.getAuthToken());
    }

    sessionKey() {
      const token = window.SiteUtils.getAuthToken() || 'guest';
      return `anime_agent_session_${token === 'guest' ? token : token.slice(-16)}`;
    }

    render() {
      this.shadowRoot.innerHTML = `<style>${styles}</style>
        <section class="panel" aria-label="动漫助手" aria-hidden="true">
          <header class="head">
            <button class="history-toggle" type="button" title="历史对话" aria-label="历史对话">☰</button>
            <div class="brand"><strong>白羽 · 动漫助手</strong><small>站内检索 · 个性化推荐 · 无剧透问答</small></div>
            <button class="new-chat" type="button" title="新对话" aria-label="新对话">↻</button>
            <button class="close" type="button" title="关闭" aria-label="关闭">×</button>
          </header>
          <div class="body">
            <aside class="sidebar" aria-label="历史对话">
              <div class="side-head"><strong>历史对话</strong><button class="side-new" type="button">新建</button></div>
              <div class="session-list"></div>
              <div class="account-wrap">
                <button class="account-button" type="button" aria-label="账号信息">
                  <img class="account-avatar" src="${DEFAULT_AVATAR}" alt="头像">
                  <span class="account-copy"><span class="account-name">未登录</span><span class="account-status">点击登录后保存历史</span></span>
                </button>
                <div class="account-menu" hidden></div>
              </div>
            </aside>
            <main class="chat">
              <div class="messages" aria-live="polite"></div>
              <div>
                <div class="suggestions"></div>
                <form class="composer">
                  <div class="input-row"><textarea rows="1" maxlength="2000" placeholder="问我动漫推荐、更新或作品信息..."></textarea><button class="send" type="submit" aria-label="发送">➤</button></div>
                  <div class="foot">推荐由站内数据生成；剧情问题默认无剧透</div>
                </form>
              </div>
            </main>
          </div>
        </section>
        <button class="launcher" aria-label="打开白羽动漫助手" title="白羽 · 动漫助手">
          <span class="mascot-stage static-mascot" aria-hidden="true">
            <img class="launcher-avatar" src="${AGENT_MASCOT}" alt="">
          </span>
          <span class="mascot-speech"></span>
        </button>`;
    }


    bind() {
      const root = this.shadowRoot;
      this.panel = root.querySelector('.panel');
      this.messages = root.querySelector('.messages');
      this.input = root.querySelector('textarea');
      this.sendButton = root.querySelector('.send');
      this.sessionList = root.querySelector('.session-list');
      this.accountButton = root.querySelector('.account-button');
      this.accountMenu = root.querySelector('.account-menu');
      this.launcher = root.querySelector('.launcher');
      this.mascotSpeech = root.querySelector('.mascot-speech');
      this.launcher.addEventListener('click', () => {
        this.showMascotSpeech();
        this.playMascotGesture('mascot-nod', 980);
        this.toggle(true);
      });
      this.launcher.addEventListener('mouseenter', () => this.showMascotSpeech());
      root.querySelector('.close').addEventListener('click', () => this.toggle(false));
      root.querySelector('.history-toggle').addEventListener('click', () => this.panel.classList.toggle('sidebar-open'));
      root.querySelector('.new-chat').addEventListener('click', () => this.newChat());
      root.querySelector('.side-new').addEventListener('click', () => this.newChat());
      this.accountButton.addEventListener('click', () => this.onAccountClick());
      root.querySelector('.composer').addEventListener('submit', event => {
        event.preventDefault();
        if (this.busy) this.cancelRequest();
        else this.send(this.input.value);
      });
      this.input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          this.send(this.input.value);
        }
      });
      this.input.addEventListener('input', () => {
        this.input.style.height = 'auto';
        this.input.style.height = `${Math.min(this.input.scrollHeight, 100)}px`;
      });
    }

    startMascotIdle() {
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      const schedule = () => {
        window.clearTimeout(this.mascotTimer);
        const delay = 6500 + Math.random() * 8500;
        this.mascotTimer = window.setTimeout(() => {
          if (!this.busy) {
            if (Math.random() < 0.58) this.showMascotSpeech();
            this.playMascotGesture(Math.random() < 0.55 ? 'mascot-nod' : 'mascot-tilt', 1150);
          }
          schedule();
        }, delay);
      };
      schedule();
    }

    showMascotSpeech() {
      if (!this.mascotSpeech || !this.launcher) return;
      const current = this.mascotSpeech.textContent;
      let next = current;
      for (let i = 0; i < 5 && next === current; i += 1) {
        next = MASCOT_LINES[Math.floor(Math.random() * MASCOT_LINES.length)];
      }
      this.mascotSpeech.textContent = next;
      this.launcher.classList.add('speaking');
      window.clearTimeout(this.mascotSpeechTimer);
      this.mascotSpeechTimer = window.setTimeout(() => {
        this.launcher?.classList.remove('speaking');
      }, 3300);
    }

    playMascotGesture(name, duration = 1000) {
      if (!this.launcher || this.busy) return;
      this.launcher.classList.remove('mascot-nod', 'mascot-tilt');
      void this.launcher.offsetWidth;
      this.launcher.classList.add(name);
      window.clearTimeout(this.mascotActionTimer);
      this.mascotActionTimer = window.setTimeout(() => {
        this.launcher?.classList.remove(name);
      }, duration);
    }


    refreshAuthState() {
      const token = window.SiteUtils.getAuthToken() || '';
      const nextSessionKey = this.sessionKey();
      const tokenChanged = token !== this.currentToken;
      if (tokenChanged || nextSessionKey !== this.currentSessionKey) {
        this.sessionListGeneration++;
        this.sessionLoadGeneration++;
        this.currentToken = token;
        this.currentSessionKey = nextSessionKey;
        this.sessionId = localStorage.getItem(nextSessionKey) || '';
        this.sessions = [];
        this.user = null;
        this.closeAccountMenu();
      }
      this.panel.classList.toggle('guest', !this.hasToken());
      if (this.hasToken() && !this.user) this.loadCurrentUser();
      this.updateAccountView();
      this.renderSessionList();
    }

    handleAuthChanged() {
      const before = this.currentToken;
      this.refreshAuthState();
      if (before !== this.currentToken) {
        this.memoryDialog?.close();
        if (this.hasToken()) {
          this.loadCurrentUser();
          this.loadSessions();
        } else {
          this.newChat();
        }
      }
    }

    toggle(open) {
      this.refreshAuthState();
      this.panel.classList.toggle('open', open);
      this.launcher?.classList.toggle('open', open);
      this.panel.setAttribute('aria-hidden', String(!open));
      if (open) {
        if (this.hasToken()) this.loadSessions();
        setTimeout(() => this.input.focus(), 50);
      }
    }

    showWelcome(text = WELCOME_TEXT) {
      this.messages.textContent = '';
      this.addAssistant(text);
      this.renderSuggestions(DEFAULT_SUGGESTIONS);
    }

    newChat() {
      this.sessionLoadGeneration++;
      this.sessionId = '';
      localStorage.removeItem(this.sessionKey());
      this.panel.classList.remove('sidebar-open');
      this.showWelcome('新的对话开始了。告诉我你今天想看什么？');
      this.renderSuggestions(['根据我的记录推荐', '只看已完结', '查本周更新']);
      this.renderSessionList();
    }

    addMessage(role, text, extraClass = '') {
      const block = document.createElement('div');
      block.className = `msg ${role}`;
      const bubble = document.createElement('div');
      bubble.className = `bubble ${extraClass}`.trim();
      bubble.textContent = text;
      block.appendChild(bubble);
      this.messages.appendChild(block);
      this.scrollBottom();
      return { block, bubble };
    }

    addAssistant(text) { return this.addMessage('assistant', text); }

    scrollBottom(force = true) {
      if (!force && !this.nearBottom()) return;
      requestAnimationFrame(() => { this.messages.scrollTop = this.messages.scrollHeight; });
    }

    nearBottom() {
      return this.messages.scrollHeight - this.messages.clientHeight - this.messages.scrollTop < 96;
    }

    renderSuggestions(items) {
      const wrap = this.shadowRoot.querySelector('.suggestions');
      wrap.textContent = '';
      for (const text of items || []) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chip';
        button.textContent = text;
        button.addEventListener('click', () => this.send(text));
        wrap.appendChild(button);
      }
    }

    authHeaders(accept = 'application/json') {
      return window.SiteUtils.authHeaders(accept);
    }

    async loadCurrentUser() {
      if (!this.hasToken()) {
        this.user = null;
        this.updateAccountView();
        return;
      }
      if (this.userLoading) return;
      this.userLoading = true;
      try {
        const response = await fetch('/api/auth/me', {
          headers: this.authHeaders(),
          cache: 'no-store'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.user = await response.json();
      } catch (_) {
        window.SiteUtils.clearAuthToken();
        this.user = null;
        this.sessions = [];
        this.sessionId = '';
        this.currentToken = '';
        this.currentSessionKey = this.sessionKey();
        if (this.panel) this.panel.classList.add('guest');
      } finally {
        this.userLoading = false;
      }
      this.updateAccountView();
      this.renderSessionList();
    }

    updateAccountView() {
      if (!this.accountButton) return;
      const avatar = this.accountButton.querySelector('.account-avatar');
      const name = this.accountButton.querySelector('.account-name');
      const status = this.accountButton.querySelector('.account-status');
      const loggedIn = this.hasToken() && this.user;
      avatar.src = loggedIn && this.user.avatar ? this.user.avatar : DEFAULT_AVATAR;
      avatar.onerror = () => { avatar.src = DEFAULT_AVATAR; };
      name.textContent = loggedIn ? (this.user.username || 'AniWorld 用户') : '未登录';
      status.textContent = loggedIn ? '已同步站内账号' : '点击登录后保存历史';
      this.accountButton.classList.toggle('open', !this.accountMenu?.hidden);
      this.renderAccountMenu();
    }

    renderAccountMenu() {
      if (!this.accountMenu) return;
      this.accountMenu.textContent = '';
      if (this.hasToken() && this.user) {
        const name = document.createElement('strong');
        name.textContent = this.user.username || 'AniWorld 用户';
        const email = document.createElement('small');
        email.textContent = this.user.email || '';
        const profile = document.createElement('button');
        profile.type = 'button';
        profile.className = 'account-action';
        profile.textContent = '个人中心';
        profile.addEventListener('click', () => { location.href = '/my.html'; });
        const memory = document.createElement('button');
        memory.type = 'button';
        memory.className = 'account-action';
        memory.textContent = '白羽记忆';
        memory.addEventListener('click', () => this.showMemory());
        const logout = document.createElement('button');
        logout.type = 'button';
        logout.className = 'account-action danger';
        logout.textContent = '退出登录';
        logout.addEventListener('click', () => this.logout());
        this.accountMenu.append(name, email, profile, memory, logout);
      } else {
        const name = document.createElement('strong');
        name.textContent = '还未登录';
        const hint = document.createElement('small');
        hint.textContent = '登录后可保存和查看历史对话';
        const login = document.createElement('button');
        login.type = 'button';
        login.className = 'account-action';
        login.textContent = '去登录';
        login.addEventListener('click', () => { location.href = '/my.html'; });
        this.accountMenu.append(name, hint, login);
      }
    }

    onAccountClick() {
      if (!this.hasToken()) {
        location.href = '/my.html';
        return;
      }
      if (!this.user) this.loadCurrentUser();
      const hidden = this.accountMenu.hasAttribute('hidden');
      if (hidden) this.accountMenu.removeAttribute('hidden');
      else this.accountMenu.setAttribute('hidden', '');
      this.accountButton.classList.toggle('open', hidden);
      this.renderAccountMenu();
    }

    closeAccountMenu() {
      if (this.accountMenu) this.accountMenu.setAttribute('hidden', '');
      if (this.accountButton) this.accountButton.classList.remove('open');
    }

    logout() {
      window.SiteUtils.clearAuthToken();
      this.user = null;
      this.sessions = [];
      this.sessionId = '';
      this.currentToken = '';
      this.closeAccountMenu();
      this.refreshAuthState();
      this.showWelcome('已退出登录。你仍然可以临时提问；登录后可以保存历史对话和获得个性化推荐。');
      window.dispatchEvent(new Event('anime-auth-changed'));
    }

    pageContext() {
      const params = new URLSearchParams(location.search);
      const shared = window.__animeAgentContext || {};
      return {
        page: location.pathname,
        anilistId: Number(shared.anilistId) || 0,
        title: shared.title || document.querySelector('.info h1')?.textContent || document.title,
        msg: shared.msg || params.get('msg') || '',
        n: shared.n || params.get('n') || '',
        episode: shared.episode || '',
        episodeIndex: Number(shared.episodeIndex) || 0,
        progress: Number(shared.progress) || 0,
        playing: Boolean(shared.playing),
        isFavorited: Boolean(shared.isFavorited)
      };
    }

    formatTime(sec) {
      const n = Number(sec) || 0;
      if (!n) return '';
      const diff = Math.floor(Date.now() / 1000) - n;
      if (diff < 60) return '刚刚';
      if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
      if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
      if (diff < 604800) return `${Math.floor(diff / 86400)}天前`;
      return new Date(n * 1000).toLocaleDateString('zh-CN');
    }

    async loadSessions() {
      const generation = ++this.sessionListGeneration;
      const owner = this.sessionKey();
      const current = () => this.isConnected && owner === this.sessionKey()
        && generation === this.sessionListGeneration;
      if (!this.hasToken()) {
        this.sessions = [];
        this.renderSessionList();
        return;
      }
      try {
        const response = await fetch('/api/agent/sessions', {
          headers: this.authHeaders(),
          cache: 'no-store'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!current()) return;
        this.sessions = Array.isArray(data.results) ? data.results : [];
      } catch (_) {
        if (!current()) return;
        // A temporary failure does not prove that saved sessions disappeared.
      }
      this.renderSessionList();
    }

    renderSessionList() {
      if (!this.sessionList) return;
      this.sessionList.textContent = '';
      if (!this.hasToken()) {
        const hint = document.createElement('div');
        hint.className = 'session-hint';
        hint.textContent = '登录后会自动保存对话，并可以在这里查看历史记录。';
        this.sessionList.appendChild(hint);
        return;
      }
      if (!this.sessions.length) {
        const empty = document.createElement('div');
        empty.className = 'session-empty';
        empty.textContent = '还没有历史对话。发出第一条消息后会自动保存。';
        this.sessionList.appendChild(empty);
        return;
      }
      for (const session of this.sessions) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `session-item ${session.id === this.sessionId ? 'active' : ''}`.trim();
        row.addEventListener('click', () => this.loadSession(session.id));

        const title = document.createElement('span');
        title.className = 'session-title';
        title.textContent = session.title || '未命名对话';

        const time = document.createElement('span');
        time.className = 'session-time';
        time.textContent = this.formatTime(session.updated_at || session.created_at);

        const del = document.createElement('span');
        del.className = 'session-delete';
        del.textContent = '×';
        del.title = '删除对话';
        del.addEventListener('click', event => {
          event.stopPropagation();
          this.deleteSession(session.id);
        });

        row.append(title, time, del);
        this.sessionList.appendChild(row);
      }
    }

    async loadSession(id) {
      if (!this.hasToken() || !id || this.busy) return;
      const generation = ++this.sessionLoadGeneration;
      const owner = this.sessionKey();
      try {
        const response = await fetch(`/api/agent/sessions/${encodeURIComponent(id)}/messages`, {
          headers: this.authHeaders(),
          cache: 'no-store'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!this.isConnected || this.busy || owner !== this.sessionKey()
          || generation !== this.sessionLoadGeneration) return;
        this.sessionId = data.session?.id || id;
        localStorage.setItem(this.sessionKey(), this.sessionId);
        this.messages.textContent = '';
        for (const item of data.results || []) {
          const rendered = this.addMessage(item.role === 'user' ? 'user' : 'assistant', item.content || '');
          if (item.role === 'assistant' && item.cards?.length) this.renderCards(rendered.block, item.cards);
        }
        if (!this.messages.children.length) this.showWelcome();
        this.renderSuggestions(DEFAULT_SUGGESTIONS);
        this.panel.classList.remove('sidebar-open');
        this.renderSessionList();
        this.scrollBottom();
      } catch (_) {
        if (!this.isConnected || this.busy || owner !== this.sessionKey() || generation !== this.sessionLoadGeneration) return;
        // Keep the current conversation on a transient history-load failure.
        window.SiteUtils.toast('历史对话暂时加载失败，请重试。');
      }
    }

    async deleteSession(id) {
      if (!this.hasToken() || !id) return;
      if (!window.confirm('确定删除这条对话记录吗？')) return;
      const owner = this.sessionKey();
      try {
        const response = await fetch(`/api/agent/sessions/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: this.authHeaders()
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!this.isConnected || owner !== this.sessionKey()) return;
        this.sessionLoadGeneration++;
        if (this.sessionId === id) this.newChat();
        await this.loadSessions();
      } catch (_) {}
    }

    async send(raw, confirmationId = '') {
      this.sessionLoadGeneration++;
      const message = String(raw || '').trim();
      if (!message || this.busy) return;
      this.toggle(true);
      this.busy = true;
      this.launcher?.classList.add('busy');
      this.sendButton.disabled = true;
      this.sendButton.textContent = '■';
      this.input.value = '';
      this.input.style.height = 'auto';
      this.renderSuggestions([]);
      this.addMessage('user', message);
      const output = this.addMessage('assistant', '', 'thinking');
      output.bubble.hidden = true;
      this.showProgress(output, '白羽正在理解你的问题…');

      const owner = this.sessionKey();
      output.owner = owner;
      const headers = this.authHeaders('application/x-ndjson');
      try {
        this.requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        this.abortController = new AbortController();
        const response = await fetch('/api/agent/chat', {
          method: 'POST',
          headers: { ...headers, 'X-Agent-Request-Id': this.requestId },
          cache: 'no-store',
          signal: this.abortController.signal,
          body: JSON.stringify({ sessionId: this.sessionId, message, pageContext: this.pageContext(), confirmationId })
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${response.status}`);
        }
        await this.readStream(response, output);
        if (output.bubble.classList.contains('thinking')) {
          output.bubble.classList.remove('thinking');
          output.bubble.textContent = '\u767d\u7fbd\u9171\u6682\u65f6\u6ca1\u6709\u6536\u5230\u56de\u7b54\u3002';
        }
        if (this.hasToken()) await this.loadSessions();
      } catch (error) {
        if (owner !== this.sessionKey()) return;
        const recovered = await this.recoverRequest(this.requestId, headers, owner);
        if (owner !== this.sessionKey()) return;
        if (recovered) {
          if (this.abortController?.signal.aborted) {
            const actions = recovered.actions || [];
            recovered.actions = actions.filter(action => !['play', 'navigate', 'confirm'].includes(action.type));
            if (actions.length !== recovered.actions.length) recovered.answer += '\n已停止后续播放、跳转与待确认操作。';
          }
          if (recovered.sessionId) this.handleEvent(JSON.stringify({type: 'session', sessionId: recovered.sessionId}), output);
          this.handleEvent(JSON.stringify({...recovered, type: 'done'}), output);
          await this.loadSessions();
          return;
        }
        output.bubble.classList.remove('thinking');
        output.bubble.hidden = false;
        output.bubble.textContent = `\u6682\u65f6\u6ca1\u80fd\u5b8c\u6210\u8bf7\u6c42\uff1a${error.message}`;
      } finally {
        this.finishToolProgress(output);
        if (output.progress) output.progress.hidden = true;
        this.abortController = null;
        this.busy = false;
        this.launcher?.classList.remove('busy');
        this.sendButton.disabled = false;
        this.sendButton.textContent = '➤';
        this.input.focus();
        this.scrollBottom(false);
      }
    }

    async recoverRequest(requestId, headers, owner) {
      if (!headers.Authorization || !requestId) return null;
      let confirmedOperations = null;
      for (let attempt = 0; attempt < 6 && owner === this.sessionKey(); attempt++) {
        try {
          const response = await fetch(`/api/agent/requests/${encodeURIComponent(requestId)}`, {
            headers, cache: 'no-store', signal: AbortSignal.timeout(2000)
          });
          if ([404, 503].includes(response.status)) return null;
          if (response.ok) {
            const data = await response.json();
            if (['completed', 'operation_completed'].includes(data.status)) return data.result;
            if (data.operationCompleted && data.result) confirmedOperations = data.result;
            if (data.status !== 'running') return null;
          }
        } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return owner === this.sessionKey() ? confirmedOperations : null;
    }

    async cancelRequest() {
      if (!this.busy) return;
      this.abortController?.abort();
      try {
        await fetch('/api/agent/cancel', {
          method: 'POST',
          headers: this.authHeaders(),
          body: JSON.stringify({ requestId: this.requestId })
        });
      } catch (_) {}
    }

    async readStream(response, output) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      output.completed = false;
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) this.handleEvent(line, output);
        if (done) break;
      }
      if (buffer.trim()) this.handleEvent(buffer, output);
      if (!output.completed) throw new Error('回答未完整结束，请稍后重试');
    }

    showProgress(output, text) {
      if (!output.progress) {
        output.progress = document.createElement('div');
        output.progress.className = 'agent-progress';
        output.progress.setAttribute('role', 'status');
        output.progress.style.cssText = 'font-size:12px;color:var(--agent-muted);margin:6px 0;white-space:pre-wrap';
        output.block.insertBefore(output.progress, output.bubble);
      }
      output.progress.textContent = text;
      output.progress.hidden = !text;
    }

    finishToolProgress(output) {
      for (const note of output.tools?.values() || []) {
        note.textContent = '工具调用已结束，请以最终回答为准';
      }
      output.tools?.clear();
    }

    handleEvent(line, output) {
      if (output.owner && (output.owner !== this.sessionKey() || !output.block.isConnected)) return;
      if (!line.trim()) return;
      const follow = this.nearBottom();
      let event;
      try { event = JSON.parse(line); } catch (_) { throw new Error('服务端返回了无效的响应'); }
      if (event.type === 'run') {
        output.runId = event.runId || '';
      } else if (event.type === 'session') {
        this.sessionId = event.sessionId;
        localStorage.setItem(this.sessionKey(), this.sessionId);
      } else if (event.type === 'progress') {
        this.showProgress(output, event.text || '白羽正在处理请求…');
      } else if (event.type === 'answer_start') {
        this.finishToolProgress(output);
        output.bubble.textContent = '';
        output.bubble.hidden = true;
        output.bubble.classList.remove('thinking');
        this.showProgress(output, '白羽正在作答…');
      } else if (event.type === 'delta') {
        if (output.bubble.classList.contains('thinking')) {
          output.bubble.textContent = '';
          output.bubble.classList.remove('thinking');
        }
        output.bubble.hidden = false;
        output.bubble.textContent += event.text || '';
      } else if (event.type === 'cards') {
        output.pendingCards = event.items || [];
      } else if (event.type === 'sources') {
        output.pendingSources = event.items || [];
      } else if (event.type === 'actions') {
        output.pendingActions = event.items || [];
      } else if (event.type === 'suggestions') {
        output.pendingSuggestions = event.items || [];
      } else if (event.type === 'error') {
        output.bubble.classList.remove('thinking');
        throw new Error(event.error || '请求失败');
      } else if (event.type === 'cancelled') {
        output.bubble.classList.remove('thinking');
        throw new Error(event.error || '已停止本次请求');
      } else if (event.type === 'tool_start') {
        this.showProgress(output, '白羽正在调用工具…');
        output.tools ||= new Map();
        const key = String(event.sequence ?? event.name);
        const note = document.createElement('div');
        note.className = 'agent-tool-status';
        note.textContent = event.text || `白羽正在调用 ${event.name || '工具'}…`;
        note.style.cssText = 'font-size:12px;color:var(--agent-muted);margin-top:4px;';
        output.tools.set(key, note);
        output.block.appendChild(note);
      } else if (event.type === 'tool_result') {
        const key = String(event.sequence ?? event.name);
        const note = output.tools?.get(key);
        if (note) note.textContent = event.text || `已结束调用 ${event.name || '工具'}`;
        output.tools?.delete(key);
        this.showProgress(output, output.tools?.size ? '白羽正在调用工具…' : '白羽正在核对查询结果…');
      } else if (event.type === 'plan') {
        const note = document.createElement('div');
        note.className = 'agent-plan-status';
        note.textContent = `行动计划：${(event.items || []).join(' → ')}`;
        note.style.cssText = 'font-size:12px;color:#8b949e;margin-top:4px;';
        output.block.appendChild(note);
      } else if (event.type === 'done') {
        if (output.completed) return;
        output.completed = true;
        this.finishToolProgress(output);
        this.showProgress(output, '');
        output.bubble.hidden = false;
        if (typeof event.answer === 'string') { output.bubble.textContent = event.answer; output.bubble.classList.remove('thinking'); }
        output.runId = event.runId || output.runId || '';
        const cards = event.cards || output.pendingCards || [];
        const sources = event.sources || output.pendingSources || [];
        if (cards.length) this.renderCards(output.block, cards, output.runId);
        if (sources.length) this.renderSources(output.block, sources);
        this.renderSuggestions(event.suggestions || output.pendingSuggestions || []);
        this.handleActions(event.actions || output.pendingActions || [], output);
        this.renderAnswerFeedback(output, output.runId);
      }
      if (follow) this.scrollBottom();
    }

    renderCards(block, items, runId = '') {
      const wrap = document.createElement('div');
      wrap.className = 'cards';
      for (const item of items) {
        const card = document.createElement('article');
        card.className = 'card';
        const link = document.createElement('a');
        link.href = String(item.href || '').startsWith('/') ? item.href : '/search_anime.html';
        link.style.cssText = 'color:inherit;text-decoration:none;display:block';
        link.addEventListener('click', () => this.recordEvent(item.anilistId, 'recommend_click', runId));
        if (item.image || item.coverFallback) {
          const image = document.createElement('img');
          window.SiteUtils.setCoverImage(image, item);
          image.alt = item.title || '';
          image.loading = 'lazy';
          link.appendChild(image);
        }
        const body = document.createElement('div');
        body.className = 'card-body';
        const title = document.createElement('div');
        title.className = 'card-title';
        title.textContent = item.title || '未知动漫';
        const meta = document.createElement('div');
        meta.className = 'card-meta';
        meta.textContent = [item.score ? `★ ${item.score}` : '', item.year || '', item.status === 'FINISHED' ? '已完结' : item.status === 'RELEASING' ? '连载中' : ''].filter(Boolean).join(' · ');
        body.append(title, meta);
        if (item.reason) {
          const reason = document.createElement('div');
          reason.className = 'card-reason';
          reason.textContent = item.reason;
          body.appendChild(reason);
        }
        link.appendChild(body);
        card.appendChild(link);
        if (this.hasToken()) {
          const actions = document.createElement('div');
          actions.className = 'card-actions';
          const dislike = document.createElement('button');
          dislike.type = 'button';
          dislike.className = 'dislike';
          dislike.textContent = '不感兴趣';
          dislike.addEventListener('click', async () => {
            dislike.disabled = true;
            await this.feedback(item.anilistId, 'not_interested', runId);
            card.remove();
          });
          actions.appendChild(dislike);
          card.appendChild(actions);
        }
        wrap.appendChild(card);
        if (runId) this.recordEvent(item.anilistId, 'recommend_impression', runId);
      }
      block.appendChild(wrap);
    }

    renderAnswerFeedback(output, runId) {
      if (!runId || !this.hasToken() || output.block.querySelector('.answer-feedback')) return;
      const wrap = document.createElement('div');
      wrap.className = 'answer-feedback';
      wrap.style.cssText = 'display:flex;gap:8px;align-items:center;color:#8b949e;font-size:11px;margin-top:2px;';
      const label = document.createElement('span');
      label.textContent = '回答有帮助吗？';
      wrap.appendChild(label);
      for (const [rating, text] of [['like', '有帮助'], ['dislike', '需改进']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.style.cssText = 'border:1px solid #3a414b;background:#151b23;color:#c9d1d9;border-radius:8px;padding:4px 8px;font-size:11px;cursor:pointer;';
        button.addEventListener('click', async () => {
          button.disabled = true;
          await this.answerFeedback(runId, rating);
          label.textContent = '感谢你的反馈';
          wrap.querySelectorAll('button').forEach(item => { item.hidden = true; });
        });
        wrap.appendChild(button);
      }
      output.block.appendChild(wrap);
    }

    handleActions(items, output) {
      for (const action of items || []) {
        if (action?.type === 'confirm') {
          const wrap = document.createElement('div');
          wrap.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
          const confirm = document.createElement('button');
          confirm.type = 'button';
          confirm.textContent = action.confirmText || '确认';
          confirm.style.cssText = 'border:0;border-radius:9px;padding:7px 13px;background:#e85d04;color:#fff;cursor:pointer;';
          confirm.addEventListener('click', () => { confirm.disabled = true; this.send('确认', action.operationId || ''); });
          const cancel = document.createElement('button');
          cancel.type = 'button';
          cancel.textContent = action.cancelText || '取消';
          cancel.style.cssText = 'border:1px solid #3a414b;border-radius:9px;padding:7px 13px;background:#151b23;color:#c9d1d9;cursor:pointer;';
          cancel.addEventListener('click', () => { cancel.disabled = true; this.send('取消', action.operationId || ''); });
          wrap.append(confirm, cancel);
          output.block.appendChild(wrap);
          continue;
        }
        if (!action || action.type !== 'navigate') continue;
        const url = String(action.url || '');
        if (!url.startsWith('/') || url.startsWith('//')) continue;
        const delay = Math.max(0, Math.min(Number(action.delayMs) || 600, 5000));
        const note = document.createElement('div');
        note.textContent = '正在为你打开页面...';
        note.style.cssText = 'font-size:12px;color:#8b949e;margin-top:4px;';
        output.block.appendChild(note);
        window.setTimeout(() => { window.location.href = url; }, delay);
      }
    }

    renderSources(block, items) {
      if (!Array.isArray(items) || !items.length) return;
      const wrap = document.createElement('div');
      wrap.className = 'agent-sources';
      wrap.style.cssText = 'display:grid;gap:6px;max-width:88%;margin-top:2px;';
      const title = document.createElement('div');
      title.textContent = '参考来源';
      title.style.cssText = 'font-size:11px;color:#8b949e;';
      wrap.appendChild(title);
      for (const item of items.slice(0, 4)) {
        const link = document.createElement('a');
        link.href = item.url || '#';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = `${item.title || item.host || '来源'} · ${item.trustLabel || item.host || ''}`.trim();
        link.style.cssText = 'display:block;border:1px solid #30363d;background:#151b23;color:#c9d1d9;text-decoration:none;border-radius:9px;padding:7px 9px;font-size:12px;line-height:1.45;overflow:hidden;text-overflow:ellipsis;';
        wrap.appendChild(link);
      }
      block.appendChild(wrap);
    }

    recordEvent(anilistId, eventType, runId = '') {
      if (!this.hasToken() || !Number(anilistId)) return;
      fetch('/api/agent/events', {
        method: 'POST',
        headers: this.authHeaders(),
        keepalive: true,
        body: JSON.stringify({ anilistId: Number(anilistId), eventType, runId, context: { page: location.pathname } })
      }).catch(() => {});
    }

    async feedback(anilistId, action, runId = '') {
      try {
        await fetch('/api/agent/feedback', {
          method: 'POST',
          headers: this.authHeaders(),
          body: JSON.stringify({ anilistId: Number(anilistId), action, runId })
        });
      } catch (_) {}
    }

    async showMemory() {
      if (!this.hasToken()) return;
      this.memoryDialog?.close();
      const dialog = document.createElement('dialog');
      dialog.style.cssText = 'width:min(480px,90vw);max-height:75vh;overflow:auto;border:1px solid #30363d;border-radius:14px;padding:18px;background:#161b22;color:#e6edf3;';
      const title = document.createElement('h3'); title.textContent = '白羽记住的偏好与信息';
      const status = document.createElement('p'); status.textContent = '正在读取…';
      const list = document.createElement('div');
      const close = document.createElement('button'); close.textContent = '关闭'; close.className = 'account-action'; close.addEventListener('click', () => dialog.close());
      dialog.append(title, status, list, close);
      dialog.addEventListener('close', () => { dialog.remove(); if (this.memoryDialog === dialog) this.memoryDialog = null; }, { once: true });
      this.shadowRoot.append(dialog); this.memoryDialog = dialog; dialog.showModal();
      const token = window.SiteUtils.getAuthToken();
      try {
        const response = await fetch('/api/agent/memory', { headers: this.authHeaders() });
        if (!response.ok) throw new Error('记忆读取失败，请稍后重试');
        const data = await response.json();
        if (!dialog.isConnected || token !== window.SiteUtils.getAuthToken()) return;
        const items = data.profile?.memoryItems || [];
        status.textContent = items.length ? '可逐条遗忘；观看记录和追番仍由个人中心管理。' : '目前没有保存的个人记忆';
        for (const item of items) {
          const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:10px;align-items:center;padding:10px 0;border-top:1px solid #30363d;';
          const text = document.createElement('span'); text.style.flex = '1'; text.textContent = item.value || '';
          const remove = document.createElement('button'); remove.textContent = '忘记'; remove.type = 'button';
          remove.addEventListener('click', async () => {
            if (token !== window.SiteUtils.getAuthToken()) { dialog.close(); return; }
            remove.disabled = true;
            try {
              const deleted = await fetch('/api/agent/memory/items/' + encodeURIComponent(item.id), { method: 'DELETE', headers: this.authHeaders() });
              if (!deleted.ok) throw new Error('删除未完成，请等待当前对话结束后重试');
              row.remove();
            } catch (error) { status.textContent = error.message; remove.disabled = false; }
          });
          row.append(text, remove); list.append(row);
        }
        const clear = document.createElement('button'); clear.textContent = '清空全部 Agent 记忆与聊天记录'; clear.className = 'account-action danger';
        clear.addEventListener('click', async () => {
          if (token !== window.SiteUtils.getAuthToken()) { dialog.close(); return; }
          if (!window.confirm('清空白羽记忆与聊天记录？观看记录和追番会保留。')) return;
          clear.disabled = true;
          try {
            const response = await fetch('/api/agent/memory', { method: 'DELETE', headers: this.authHeaders() });
            if (!response.ok) throw new Error('清空未完成，请等待当前对话结束后重试');
            if (token !== window.SiteUtils.getAuthToken()) return;
            dialog.close(); this.newChat(); await this.loadSessions();
          } catch (error) { status.textContent = error.message; clear.disabled = false; }
        });
        list.append(clear);
      } catch (error) { status.textContent = error.message; }
    }

    async answerFeedback(runId, rating) {
      try {
        await fetch('/api/agent/answer-feedback', {
          method: 'POST',
          headers: this.authHeaders(),
          body: JSON.stringify({ runId, sessionId: this.sessionId, rating })
        });
      } catch (_) {}
    }
  }

  window.customElements.define('anime-agent', AnimeAgent);
  function mount() {
    if (!document.querySelector('anime-agent')) document.body.appendChild(document.createElement('anime-agent'));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
