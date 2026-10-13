(function () {
  'use strict';

  var isCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  var isMobile = window.matchMedia && window.matchMedia('(max-width: 820px)').matches;
  var html = document.documentElement;
  html.classList.toggle('is-capacitor-app', isCapacitor);
  html.classList.toggle('is-mobile-layout', isMobile);

  var viewport = document.querySelector('meta[name="viewport"]');
  if (viewport && !/viewport-fit=cover/.test(viewport.content)) {
    viewport.content = viewport.content.replace(/\s+$/, '') + ', viewport-fit=cover';
  }

  function activeFor(path) {
    var p = location.pathname;
    if (path === '/' && (p === '/' || /\/index\.html$/.test(p))) return true;
    return path !== '/' && p.endsWith(path);
  }

  function installBottomNav() {
    if (!isMobile && !isCapacitor) return;
    if (document.querySelector('.app-bottom-nav')) return;
    document.body.classList.add('has-app-bottom-nav');
    var nav = document.createElement('nav');
    nav.className = 'app-bottom-nav';
    nav.setAttribute('aria-label', '移动端底部导航');
    var items = [
      ['/', '⌂', '首页'],
      ['/search_anime.html', '⌕', '搜索'],
      ['/calendar.html', '◴', '更新'],
      ['/agent.html', '✦', '白羽'],
      ['/my.html', '♡', '我的']
    ];
    nav.innerHTML = items.map(function (it) {
      return '<a href="' + it[0] + '"' + (activeFor(it[0]) ? ' class="active"' : '') + '><span class="ico">' + it[1] + '</span><span>' + it[2] + '</span></a>';
    }).join('');
    document.body.appendChild(nav);
  }

  function closeFullscreenIfAny() {
    if (document.fullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen).call(document);
      return true;
    }
    return false;
  }

  function bindNativeBackButton() {
    var app = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (!app || !app.addListener) return;
    app.addListener('backButton', function () {
      if (closeFullscreenIfAny()) return;
      if (history.length > 1) {
        history.back();
      } else if (app.minimizeApp) {
        app.minimizeApp();
      }
    });
  }

  function onFullscreenChange() {
    document.body.classList.toggle('player-fullscreen-active', !!document.fullscreenElement);
  }

  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      installBottomNav();
      bindNativeBackButton();
    }, { once: true });
  } else {
    installBottomNav();
    bindNativeBackButton();
  }
})();
