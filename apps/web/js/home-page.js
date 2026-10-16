function goSearch() {
  const q = document.getElementById('quickSearch').value.trim();
  if (q) location.href = 'search_anime.html?q=' + encodeURIComponent(q);
}

// ==================== Router ====================
function route() {
  const path = location.pathname;
  if (path === '/' || path === '/index.html' || path.endsWith('/')) {
    renderHome();
  } else if (path === '/search.html') {
    location.replace('search_anime.html' + location.search);
  } else {
    renderHome();
  }
}

// ==================== Home Page ====================
async function renderHome() {
  document.title = 'AniWorld - 动漫世界';
  document.getElementById('app').innerHTML = `
    <div class="hero-board">
      <div class="carousel" id="carousel">
        <div class="carousel-track" id="carouselTrack">
          <!-- Slide 1: Brand -->
          <div class="carousel-slide slide-brand">
            <div class="slide-bg"></div>
            <div class="slide-content">
              <h2>探索<span class="accent">动漫</span>世界</h2>
              <div class="sub">发现你最喜欢的动漫，获取最新资讯</div>
              <div class="brand-stats">
                <div class="bs-item"><div class="bs-num">25,000+</div><div class="bs-lbl">收录动漫</div></div>
                <div class="bs-item"><div class="bs-num">100万+</div><div class="bs-lbl">剧集</div></div>
                <div class="bs-item"><div class="bs-num">实时</div><div class="bs-lbl">数据更新</div></div>
              </div>
            </div>
          </div>
          <!-- Slides 2-6 populated by JS -->
        </div>
        <button class="carousel-arrow prev" onclick="carouselPrev()" aria-label="上一张">&#10094;</button>
        <button class="carousel-arrow next" onclick="carouselNext()" aria-label="下一张">&#10095;</button>
        <div class="carousel-dots" id="carouselDots"></div>
      </div>
      <div class="hero-side-grid" id="heroSideGrid">
        <div class="hero-side-empty">加载推荐中...</div>
      </div>
    </div>
    <main>
      <div class="section-title">🔥 热门动漫</div>
      <div class="anime-grid" id="trendingGrid"><div class="loading"><div class="spinner"></div>加载中...<div class="load-bar-wrap"><div class="load-bar"></div></div></div></div>

      <div class="section-title">📅 今日更新</div>
      <div class="today-grid" id="todayGrid"><div class="loading"><div class="spinner"></div>加载中...<div class="load-bar-wrap"><div class="load-bar"></div></div></div></div>

      <div class="section-title">🆕 新番推荐</div>
      <div class="anime-grid" id="newGrid"><div class="loading"><div class="spinner"></div>加载中...<div class="load-bar-wrap"><div class="load-bar"></div></div></div></div>

      <div class="section-title">⭐ 经典神作</div>
      <div class="anime-grid" id="classicGrid"><div class="loading"><div class="spinner"></div>加载中...<div class="load-bar-wrap"><div class="load-bar"></div></div></div></div>
    </main>
  `;

  // Load all 4 grids in parallel (was sequential — 4x slower)
  const [trendingItems, todayItems, newItems, classicItems] = await Promise.all([
    loadGrid('/api/oi/trending', 'trendingGrid'),
    loadTodayGrid(),
    loadGrid('/api/oi/newseason', 'newGrid'),
    loadGrid('/api/oi/classic', 'classicGrid')
  ]);
  buildHeroSideCards(trendingItems, todayItems, classicItems);

  // Build carousel slides 2-6 from loaded anime data (safe wrapper)
  try { buildCarouselSlides(); } catch(e) { console.warn('Carousel init failed:', e.message); }
}

// ==================== Carousel ====================
let carouselIdx = 0;
let carouselTimer = null;
const CAROUSEL_INTERVAL = 4500;

function buildCarouselSlides() {
  var data = window._animeData || [];
  if (!data.length) return;

  // Collect anime with images from all loaded data
  var candidates = [];
  var seen = new Set();
  for (var i = 0; i < data.length; i++) {
    var a = data[i];
    if (!a || !a.image || seen.has(a.title)) continue;
    if (!a.title || a.title.length < 2) continue;
    seen.add(a.title);
    candidates.push(a);
  }
  if (candidates.length === 0) return;

  // Pick exactly 5 (or fewer if not enough)
  const picked = [];
  const pool = [...candidates];
  for (let i = 0; i < 5 && pool.length > 0; i++) {
    const ri = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(ri, 1)[0]);
  }

  const track = document.getElementById('carouselTrack');
  const dots = document.getElementById('carouselDots');
  if (!track || !dots) return;

  // Remove existing dynamic slides & dots (keep brand slide at index 0)
  const slides = track.querySelectorAll('.carousel-slide:not(.slide-brand)');
  slides.forEach(s => s.remove());

  picked.forEach((a, i) => {
    const title = (a.title || '未知动漫').substring(0, 32);
    const desc = buildSlideDesc(a);
    const score = a.score ? '★ ' + Number(a.score).toFixed(1) : '';
    const year = a.year ? a.year : '';
    const tagLabel = i === 0 ? '🔥 热番推荐' : i === 1 ? '🆕 新番速递' : i === 2 ? '⭐ 经典回顾' : (i === 3 ? '📺 人气作品' : '🎬 精选动漫');
    const tagClass = i === 0 ? 'tag-hot' : (i === 1 ? 'tag-new' : '');
    const slideIdx = window._animeData ? window._animeData.indexOf(a) : -1;

    const slide = document.createElement('div');
    slide.className = 'carousel-slide';
    slide.innerHTML = `
      <img class="slide-bg" ${window.SiteUtils.coverImageAttributes(a)} alt="">
      <div class="slide-overlay"></div>
      <div class="slide-content">
        <span class="tag ${tagClass}">${tagLabel}</span>
        <h2>${escapeHtml(title)}</h2>
        <div class="sub">${desc}</div>
        <div class="slide-meta">
          ${score ? '<span class="sm-score">'+score+'</span>' : ''}
          ${year ? '<span class="sm-year">'+year+'</span>' : ''}
        </div>
        <button class="slide-btn" onclick="playAnime(window._animeData[${slideIdx}])">立即观看 ▶</button>
      </div>`;
    track.appendChild(slide);
  });

  // Rebuild dots
  const totalSlides = track.children.length;
  dots.innerHTML = '';
  for (let i = 0; i < totalSlides; i++) {
    const dot = document.createElement('button');
    dot.className = 'carousel-dot' + (i === 0 ? ' active' : '');
    dot.setAttribute('aria-label', '幻灯片 ' + (i + 1));
    dot.onclick = () => goToSlide(i);
    dots.appendChild(dot);
  }

  // Reset to first slide
  carouselIdx = 0;
  updateCarousel();
  startCarouselAuto();
}

function buildSlideDesc(a) {
  const genres = a.genres && a.genres.length ? a.genres.slice(0, 3).join(' · ') : '';
  const eps = episodeProgressText(a);
  return [genres, eps].filter(Boolean).join(' ｜ ') || '精彩动漫，不容错过';
}

function episodeProgressText(a) {
  if (a.nextAiring && a.nextAiring.episode) {
    const currentEp = Math.max(0, Number(a.nextAiring.episode) - 1);
    return currentEp > 0 ? '更新至第' + currentEp + '集' : '即将开播';
  }
  if (a.status === 'FINISHED' && a.episodes && a.episodes !== '?') return a.episodes + '集全';
  return a.episodes && a.episodes !== '?' ? a.episodes + '集' : '';
}

function nextAiringEpisodeText(a) {
  return a.nextAiring && a.nextAiring.episode ? '第' + a.nextAiring.episode + '集更新' : '';
}

function buildHeroSideCards(trendingItems, todayItems, classicItems) {
  const grid = document.getElementById('heroSideGrid');
  if (!grid) return;

  const tagged = []
    .concat((trendingItems || []).map(a => ({ anime: a, tag: '热门' })))
    .concat((todayItems || []).map(a => ({ anime: a, tag: '更新' })))
    .concat((classicItems || []).map(a => ({ anime: a, tag: '经典' })))
    .filter(item => item.anime && item.anime.image && item.anime.title);

  const seen = new Set();
  const pool = tagged.filter(item => {
    const key = item.anime.title || item.anime.id || '';
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const picked = [];
  while (pool.length > 0 && picked.length < 4) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }

  if (picked.length === 0) {
    grid.innerHTML = '<div class="hero-side-empty">暂无推荐</div>';
    return;
  }

  grid.innerHTML = picked.map(item => heroSideCard(item.anime, item.tag)).join('');
}

function heroSideCard(a, tag) {
  const idx = window._animeData.push(a) - 1;
  const meta = tag === '更新'
    ? nextAiringEpisodeText(a)
    : episodeProgressText(a);
  const sub = [meta, a.year ? String(a.year) : ''].filter(Boolean).join(' · ');
  const score = a.score ? '★ ' + a.score : '';
  return `
    <div class="hero-side-card" onclick="playAnime(window._animeData[${idx}])">
      <div class="side-img">
        <img ${window.SiteUtils.coverImageAttributes(a)} alt="${escapeHtml(a.title)}" loading="lazy">
        <span class="side-tag">${escapeHtml(tag)}</span>
        ${score ? '<span class="side-score">' + escapeHtml(score) + '</span>' : ''}
      </div>
      <div class="side-info">
        <h3>${escapeHtml(a.title)}</h3>
        <div class="side-meta">${escapeHtml(sub || (a.genres ? a.genres.slice(0,2).join(' · ') : ''))}</div>
      </div>
    </div>
  `;
}

function goToSlide(idx) {
  const track = document.getElementById('carouselTrack');
  const dots = document.querySelectorAll('.carousel-dot');
  if (!track) return;
  const total = track.children.length;
  if (total === 0) return;
  carouselIdx = ((idx % total) + total) % total;
  track.style.transform = 'translateX(-' + (carouselIdx * 100) + '%)';
  dots.forEach((d, i) => d.classList.toggle('active', i === carouselIdx));
}

function updateCarousel() { goToSlide(carouselIdx); }

function carouselNext() { goToSlide(carouselIdx + 1); resetCarouselTimer(); }
function carouselPrev() { goToSlide(carouselIdx - 1); resetCarouselTimer(); }

function startCarouselAuto() {
  stopCarouselAuto();
  carouselTimer = setInterval(() => goToSlide(carouselIdx + 1), CAROUSEL_INTERVAL);
}

function stopCarouselAuto() {
  if (carouselTimer) { clearInterval(carouselTimer); carouselTimer = null; }
}

function resetCarouselTimer() {
  stopCarouselAuto();
  startCarouselAuto();
}

// Pause on hover (safely)
(function() {
  var app = document.getElementById('app');
  if (!app) return;
  var obs = new MutationObserver(function() {
    var carousel = document.getElementById('carousel');
    if (carousel) {
      carousel.addEventListener('mouseenter', stopCarouselAuto);
      carousel.addEventListener('mouseleave', startCarouselAuto);
      obs.disconnect();
    }
  });
  obs.observe(app, { childList: true, subtree: true });
})();

// Touch swipe support
var touchStartX = 0;
var touchEndX = 0;
document.addEventListener('touchstart', function(e) { touchStartX = e.changedTouches[0].screenX; }, { passive: true });
document.addEventListener('touchend', function(e) {
  touchEndX = e.changedTouches[0].screenX;
  var diff = touchStartX - touchEndX;
  if (Math.abs(diff) > 60) {
    if (diff > 0) carouselNext ? carouselNext() : null;
    else carouselPrev ? carouselPrev() : null;
  }
}, { passive: true });

// ==================== Grid Loading ====================
async function loadGrid(endpoint, gridId) {
  try {
    const r = await fetch(endpoint);
    const data = await r.json();
    const grid = document.getElementById(gridId);
    if (data.results && data.results.length > 0) {
      grid.innerHTML = data.results.map(a => animeCard(a)).join('');
      return data.results;
    } else {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="icon">📭</div>暂无数据</div>';
      return [];
    }
  } catch(e) {
    const grid = document.getElementById(gridId);
    if (grid) grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="icon">⚠️</div>加载失败</div>';
    return [];
  }
}

async function loadTodayGrid() {
  try {
    const r = await fetch('/api/oi/today');
    const data = await r.json();
    const grid = document.getElementById('todayGrid');
    if (data.results && data.results.length > 0) {
      grid.innerHTML = data.results.map(a => todayCard(a)).join('');
      return data.results;
    } else {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="icon">📭</div>今天暂无更新</div>';
      return [];
    }
  } catch(e) {
    const grid = document.getElementById('todayGrid');
    if (grid) grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="icon">⚠️</div>加载失败</div>';
    return [];
  }
}

function animeCard(a) {
  const idx = window._animeData.push(a) - 1;
  const progress = episodeProgressText(a);
  return `
    <div class="anime-card" onclick="playAnime(window._animeData[${idx}])">
      <div class="img-wrap">
        <img ${window.SiteUtils.coverImageAttributes(a)} alt="${escapeHtml(a.title)}" loading="lazy">
        ${a.score ? '<span class="score">★ ' + a.score + '</span>' : ''}
        ${a.year ? '<span class="eps">' + escapeHtml(String(a.year)) + '</span>' : ''}
        ${progress ? '<span class="new-tag" style="background:#22c55e">📺 ' + progress + '</span>' : ''}
        ${a.source === 'anilist' ? '<span class="new-tag" style="background:#6366f1;left:auto;right:10px">AniList</span>' : ''}
      </div>
      <div class="info">
        <h3>${escapeHtml(a.title)}</h3>
        <div class="meta">${a.genres ? a.genres.slice(0,3).map(g=>escapeHtml(g)).join(' · ') : ''}</div>
      </div>
    </div>
  `;
}

function todayCard(a) {
  const idx = window._animeData.push(a) - 1;
  const nextEp = nextAiringEpisodeText(a);
  const hasChinese = a.source === 'oiapi';
  const subtitle = !hasChinese && a.romajiTitle ? '<div class="meta today-subtitle">' + escapeHtml(a.romajiTitle.substring(0, 40)) + '</div>' : '';
  return `
    <div class="anime-card" onclick="playAnime(window._animeData[${idx}])">
      <div class="img-wrap">
        <img ${window.SiteUtils.coverImageAttributes(a)} alt="${escapeHtml(a.title)}" loading="lazy">
        <span class="new-tag" style="background:#22c55e">更新</span>
        ${!hasChinese ? '<span class="new-tag" style="right:10px;left:auto;background:rgba(99,102,241,0.8)">AniList</span>' : ''}
        ${a.score ? '<span class="score">★ ' + a.score + '</span>' : ''}
      </div>
      <div class="info">
        <h3>${escapeHtml(a.title.substring(0, 28))}</h3>
        ${subtitle}
        <div class="meta today-ep">${nextEp ? '📺 ' + nextEp : ''}</div>
      </div>
    </div>
  `;
}

// ==================== Init ====================
route();
window.addEventListener('popstate', route);
