// common.js - shared page navigation and progress behavior.
// 所有页面都通过 <script src="common.js"> 引入

const { escapeHtml, toast } = window.SiteUtils;

// 全局动漫数据缓存，用于 onclick 传递参数（避免 encodeURIComponent 编码导致 JS 语法错误）
window._animeData = window._animeData || [];

function search() {
  const input = document.getElementById('headerSearch');
  const v = input?.value?.trim();
  if (v) location.href = 'search_anime.html?q=' + encodeURIComponent(v);
}

// ==================== 全局顶部进度条 (NProgress 风格) ====================
const Progress = (() => {
  let bar, pct, timer, started = false;

  function ensureStyle() {
    if (document.getElementById('top-progress-style')) return;
    const s = document.createElement('style');
    s.id = 'top-progress-style';
    s.textContent = `
      #top-progress-bar{position:fixed;top:0;left:0;height:3px;z-index:99999;pointer-events:none;transition:width .3s ease;will-change:width}
      #top-progress-bar .bar-inner{height:100%;background:linear-gradient(90deg,#e85d04,#fd7e14);border-radius:0 2px 2px 0;box-shadow:0 0 10px rgba(232,93,4,.5)}
      #top-progress-bar .bar-glow{position:absolute;right:0;top:0;height:100%;width:100px;background:linear-gradient(90deg,transparent,rgba(232,93,4,.3));animation:topBarGlow 1.5s ease-in-out infinite}
      @keyframes topBarGlow{0%,100%{opacity:.3}50%{opacity:.8}}
    `;
    document.head.appendChild(s);
  }

  function ensureBar() {
    if (bar) return;
    ensureStyle();
    bar = document.createElement('div');
    bar.id = 'top-progress-bar';
    bar.innerHTML = '<div class="bar-glow"></div><div class="bar-inner"></div>';
    bar.style.width = '0%';
    document.body.appendChild(bar);
  }

  function start() {
    ensureBar();
    if (started) return;
    started = true;
    pct = 0;
    bar.style.width = '0%';
    trickle();
  }

  function trickle() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (!started) { clearInterval(timer); return; }
      if (pct < 20) pct += 3;
      else if (pct < 50) pct += 2;
      else if (pct < 80) pct += 0.8;
      else if (pct < 95) pct += 0.1;
      else clearInterval(timer);
      bar.style.width = Math.min(pct, 95) + '%';
    }, 200);
  }

  function set(n) {
    ensureBar();
    pct = Math.min(100, Math.max(0, n));
    if (timer) clearInterval(timer);
    bar.style.width = pct + '%';
  }

  function done() {
    ensureBar();
    if (timer) clearInterval(timer);
    started = false;
    pct = 100;
    bar.style.width = '100%';
    bar.style.transition = 'width .2s ease';
    setTimeout(() => {
      bar.style.transition = 'opacity .4s ease';
      bar.style.opacity = '0';
      setTimeout(() => {
        bar.style.width = '0%';
        bar.style.opacity = '1';
        bar.style.transition = 'width .3s ease';
      }, 400);
    }, 250);
  }

  return { start, set, done };
})();

// 页面加载时自动启动进度条
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => Progress.start());
} else {
  Progress.start();
}
window.addEventListener('load', () => setTimeout(() => Progress.done(), 200));

// 所有页面点击卡片→用中文名实时桥接 OIAPI 再跳转播放
// 注意：此函数不传 ep 参数，所有非历史记录页面的点击都默认从第1集开始
// 只有 my.html 的 goPlayProgress() 才传 ep 参数跳到指定集数
async function playAnime(a) {
  // OIAPI 来源（搜索页结果）：已有时实解析的 oiMsg/oiIndex，直接跳转
  if (a.source === 'oiapi' && a.oiMsg && a.oiIndex) {
    Progress.start();
    location.href = '/anime.html?msg=' + encodeURIComponent(a.oiMsg) + '&n=' + a.oiIndex;
    return;
  }
  // 用中文名实时桥接 OIAPI
  const title = a.title;  // title_chinese
  if (!title) {
    const q = a.romajiTitle || a.englishTitle || '';
    location.href = '/search_anime.html?q=' + encodeURIComponent(q);
    return;
  }

  toast('正在匹配视频源...');
  Progress.start();
  try {
    const r = await fetch('/api/oi/bridge-resolve?title=' + encodeURIComponent(title));
    const data = await r.json();
    if (data.found) {
      location.href = '/anime.html?msg=' + encodeURIComponent(data.oiMsg) + '&n=' + data.oiIndex;
    } else {
      // 桥接失败：直接用中文名兜底跳转
      location.href = '/anime.html?msg=' + encodeURIComponent(title) + '&n=1';
    }
  } catch (e) {
    location.href = '/anime.html?msg=' + encodeURIComponent(title) + '&n=1';
  }
}
