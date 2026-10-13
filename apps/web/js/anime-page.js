(function(){ 'use strict';
  // Version: 20260608-1001-fix-src-redecl
})();
const { escapeHtml } = window.SiteUtils;
let currentMsg = '';
let currentN = '';
let currentAnimeAnilistId = 0;
let currentType = '1';
let currentSourceJ = '1'; // working j value for current source
let playlist = [];
let currentEp = 0;
let episodeJMap = {}; // idx -> verified j value
let allSources = []; // all working source (type, j) combinations
let currentSourceIdx = 0;
let currentAniEpisodes = 0; // AniList regular episode count (for SP detection)
let currentSpeed = 1; // current playback speed

// ===== Custom Controls Bar Init =====
(function initCustomControls() {
  const video = document.getElementById('videoPlayer');
  const cp = document.getElementById('customPlayer');
  if (!video || !cp) return;

  const ctrlPlay = document.getElementById('ctrlPlay');
  const ctrlTime = document.getElementById('ctrlTime');
  const ctrlProgressFill = document.getElementById('ctrlProgressFill');
  const ctrlProgressHandle = document.getElementById('ctrlProgressHandle');
  const ctrlProgressInput = document.getElementById('ctrlProgressInput');
  const ctrlProgressWrap = document.getElementById('ctrlProgressWrap');
  const ctrlVolumeBtn = document.getElementById('ctrlVolumeBtn');
  const ctrlVolumeSlider = document.getElementById('ctrlVolumeSlider');
  const ctrlFullscreen = document.getElementById('ctrlFullscreen');
  const ctrlSpeed = document.getElementById('ctrlSpeed');
  const isTouchDevice = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  let playerLocked = false;
  let gestureBrightness = Number(localStorage.getItem('aniworld_player_brightness') || 0.55);
  let gestureVolume = Number(localStorage.getItem('aniworld_player_volume') || video.volume || 1);

  function callNative(method, payload) {
    try {
      const nativeControls = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AppControls;
      if (nativeControls && typeof nativeControls[method] === 'function') {
        return nativeControls[method](payload || {});
      }
    } catch (err) {}
    return Promise.resolve(null);
  }

  function clamp01(n) {
    n = Number(n);
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function setGestureVolume(value) {
    gestureVolume = clamp01(value);
    localStorage.setItem('aniworld_player_volume', String(gestureVolume));
    video.volume = gestureVolume;
    video.muted = gestureVolume <= 0.01;
    if (ctrlVolumeSlider) ctrlVolumeSlider.value = gestureVolume;
    callNative('setVolume', { value: gestureVolume });
    updateVolumeIcon();
  }

  function setGestureBrightness(value) {
    gestureBrightness = Math.max(0.05, clamp01(value));
    localStorage.setItem('aniworld_player_brightness', String(gestureBrightness));
    callNative('setBrightness', { value: gestureBrightness }).then(function(result) {
      if (!result) {
        video.style.filter = 'brightness(' + (0.45 + gestureBrightness * 1.15).toFixed(2) + ')';
      }
    });
  }

  function showGestureHud(kind, value, label) {
    let hud = document.getElementById('playerGestureHud');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'playerGestureHud';
      hud.className = 'player-gesture-hud';
      hud.innerHTML = '<div class="hud-icon"></div><div class="hud-label"></div><div class="hud-bar"><span></span></div>';
      cp.appendChild(hud);
    }
    hud.querySelector('.hud-icon').textContent = kind === 'brightness' ? '☀' : kind === 'volume' ? '♪' : '↔';
    hud.querySelector('.hud-label').textContent = label || Math.round(clamp01(value) * 100) + '%';
    hud.querySelector('.hud-bar span').style.width = Math.round(clamp01(value) * 100) + '%';
    hud.classList.add('show');
    clearTimeout(hud._timer);
    hud._timer = setTimeout(function() { hud.classList.remove('show'); }, 650);
  }

  function setNativeViewingMode(enabled) {
    callNative('setImmersive', { enabled: !!enabled });
    callNative('setKeepAwake', { enabled: !!enabled });
    callNative('setOrientation', { mode: enabled ? 'landscape' : 'unspecified' });
    if (!enabled) {
      callNative('resetBrightness');
      video.style.filter = '';
    }
  }

  function setPlayerLocked(locked) {
    playerLocked = !!locked;
    cp.classList.toggle('is-locked', playerLocked);
    cp.classList.add('user-inactive');
    cp.classList.remove('user-active');
    const lockBtn = document.getElementById('ctrlPlayerLock');
    const floatBtn = document.getElementById('playerUnlockFloat');
    if (lockBtn) lockBtn.textContent = playerLocked ? '🔒' : '🔓';
    if (floatBtn) floatBtn.textContent = playerLocked ? '🔒 双击解锁' : '🔓';
    showSeekFeedback(playerLocked ? '已锁定屏幕' : '已解锁');
  }

  function installPlayerLockButtons() {
    if (document.getElementById('ctrlPlayerLock')) return;
    const lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.id = 'ctrlPlayerLock';
    lockBtn.className = 'ctrl-btn player-lock-btn';
    lockBtn.title = '锁定/解锁';
    lockBtn.textContent = '🔓';
    lockBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      setPlayerLocked(!playerLocked);
    });
    ctrlFullscreen.parentNode.insertBefore(lockBtn, ctrlFullscreen);

    const floatBtn = document.createElement('button');
    floatBtn.type = 'button';
    floatBtn.id = 'playerUnlockFloat';
    floatBtn.className = 'player-unlock-float';
    floatBtn.textContent = '🔒 双击解锁';
    let lastUnlockTap = 0;
    floatBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      const now = Date.now();
      if (now - lastUnlockTap < 520) {
        setPlayerLocked(false);
        showFSControls();
        lastUnlockTap = 0;
      } else {
        lastUnlockTap = now;
        showSeekFeedback('再点一次解锁');
      }
    });
    floatBtn.addEventListener('dblclick', function(e) {
      e.preventDefault();
      e.stopPropagation();
      setPlayerLocked(false);
      showFSControls();
    });
    cp.appendChild(floatBtn);
  }

  installPlayerLockButtons();
  function installMobilePlayerChrome() {
    if (document.getElementById('playerMobileTop')) return;
    const top = document.createElement('div');
    top.id = 'playerMobileTop';
    top.className = 'player-mobile-top';
    top.innerHTML = `
      <button type="button" class="pm-back" aria-label="返回详情">‹</button>
      <div class="pm-title"><span id="pmClock">--:--</span><strong id="pmAnimeTitle">AniWorld</strong></div>
      <div class="pm-actions">
        <button type="button" data-tip="投屏">投屏</button>
        <button type="button" data-tip="分享">⌯</button>
        <button type="button" data-tip="更多">⋮</button>
      </div>`;
    cp.appendChild(top);
    top.querySelector('.pm-back').addEventListener('click', function(e) {
      e.stopPropagation();
      if (document.fullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen).call(document);
      }
    });
    top.querySelectorAll('.pm-actions button').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        showSeekFeedback(btn.dataset.tip + '功能稍后开放');
      });
    });
    const updateTop = function() {
      const now = new Date();
      const clock = document.getElementById('pmClock');
      const title = document.getElementById('pmAnimeTitle');
      if (clock) clock.textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      const epText = currentEp >= 0 ? ' - 第' + (currentEp + 1) + '集' : '';
      if (title) title.textContent = (currentMsg || document.querySelector('.info h1')?.textContent || '正在播放') + epText;
    };
    updateTop();
    window.setInterval(updateTop, 15000);
    video.addEventListener('loadedmetadata', updateTop);
    video.addEventListener('play', updateTop);
  }
  installMobilePlayerChrome();
  callNative('getVolume').then(function(info) {
    if (info && typeof info.value === 'number') {
      gestureVolume = clamp01(info.value);
      if (ctrlVolumeSlider) ctrlVolumeSlider.value = gestureVolume;
    }
  }).catch(function(){});

  function formatTime(s) {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  // Play / Pause
  ctrlPlay.addEventListener('click', function() {
    if (video.paused) video.play(); else video.pause();
  });
  const playIcon = document.getElementById('playIcon');
  const pauseIcon = document.getElementById('pauseIcon');
  function updatePlayPauseIcon() {
    if (video.paused) {
      if (playIcon) playIcon.style.display = 'block';
      if (pauseIcon) pauseIcon.style.display = 'none';
      cp.classList.add('paused');
    } else {
      if (playIcon) playIcon.style.display = 'none';
      if (pauseIcon) pauseIcon.style.display = 'block';
      cp.classList.remove('paused');
    }
  }
  video.addEventListener('play', updatePlayPauseIcon);
  video.addEventListener('pause', updatePlayPauseIcon);

  // ===== 移动端手势系统（长按3x倍速、滑动seek、轻触显隐/暂停） =====
  let _touchState = null;
  let _lastTapTime = 0;
  let _lastTapX = 0, _lastTapY = 0;
  function _resetTouch() {
    if (_touchState && _touchState.timer) clearTimeout(_touchState.timer);
    _touchState = null;
    cp.classList.remove('speed-boost');
    var tip = document.querySelector('.seek-tooltip');
    if (tip) tip.style.display = 'none';
  }
  function _showSeekTip(sec) {
    var tip = document.querySelector('.seek-tooltip');
    tip.textContent = formatTime(sec) + ' / ' + formatTime(video.duration);
    tip.style.display = 'block';
    if (ctrlProgressHandle) {
      var hr = ctrlProgressHandle.getBoundingClientRect();
      var pr = cp.getBoundingClientRect();
      tip.style.left = (hr.left + hr.width/2 - pr.left) + 'px';
    }
  }
  cp.addEventListener('touchstart', function(e) {
    if (e.touches.length !== 1) { _resetTouch(); return; }
    if (playerLocked) {
      if (!e.target.closest('#playerUnlockFloat') && !e.target.closest('#ctrlPlayerLock')) {
        e.preventDefault();
      }
      return;
    }
    if (e.target.closest('.player-controls')) return;
    if (e.target.closest('.ep-selector-panel')) return;
    if (e.target.closest('.speed-selector-panel')) return;
    if (e.target.closest('.settings-panel')) return;
    if (e.target.closest('.quality-selector-panel')) return;
    var t = e.touches[0];
    _touchState = {
      sx: t.clientX, sy: t.clientY,
      st: Date.now(), moved: false,
      mode: '',
      isLP: false, isSS: false,
      timer: null, origPct: parseFloat(ctrlProgressFill.style.width) || 0
    };
    _touchState.startBrightness = gestureBrightness;
    _touchState.startVolume = gestureVolume;
    _touchState.timer = setTimeout(function() {
      if (!_touchState) return;
      _touchState.isLP = true;
      _touchState._saveSpeed = video.playbackRate;
      video.playbackRate = 3;
      ctrlSpeed.textContent = '3x';
      cp.classList.add('speed-boost');
      if (video.paused) video.play();
    }, 500);
  }, { passive: false });
  cp.addEventListener('touchmove', function(e) {
    if (playerLocked) {
      e.preventDefault();
      return;
    }
    if (!_touchState) return;
    var t = e.touches[0];
    var rawDx = t.clientX - _touchState.sx;
    var rawDy = t.clientY - _touchState.sy;
    var dx = Math.abs(rawDx);
    var dy = Math.abs(rawDy);
    if (dx < 5 && dy < 5) return;
    _touchState.moved = true;
    if (_touchState.timer) { clearTimeout(_touchState.timer); _touchState.timer = null; }
    if (_touchState.isLP) {
      video.playbackRate = _touchState._saveSpeed || 1;
      ctrlSpeed.textContent = ((_touchState._saveSpeed || 1) === 1 ? '1' : (_touchState._saveSpeed || 1)) + 'x';
      cp.classList.remove('speed-boost');
      _touchState.isLP = false;
    }
    if (!_touchState.mode && dy > dx && dy > 12 && (cp.classList.contains('is-fullscreen') || isTouchDevice)) {
      var rect = cp.getBoundingClientRect();
      _touchState.mode = (_touchState.sx - rect.left) < rect.width / 2 ? 'brightness' : 'volume';
    } else if (!_touchState.mode && dx > dy && dx > 10) {
      _touchState.mode = 'seek';
    }

    if (_touchState.mode === 'brightness') {
      e.preventDefault();
      var bDelta = (-rawDy / Math.max(160, cp.getBoundingClientRect().height)) * 1.25;
      var bValue = clamp01(_touchState.startBrightness + bDelta);
      setGestureBrightness(bValue);
      showGestureHud('brightness', bValue);
    } else if (_touchState.mode === 'volume') {
      e.preventDefault();
      var vDelta = (-rawDy / Math.max(160, cp.getBoundingClientRect().height)) * 1.25;
      var vValue = clamp01(_touchState.startVolume + vDelta);
      setGestureVolume(vValue);
      showGestureHud('volume', vValue);
    } else if (_touchState.mode === 'seek') {
      _touchState.isSS = true;
      e.preventDefault();
      var dur = video.duration || 0;
      if (dur <= 0) return;
      var dir = (rawDx > 0 ? 1 : -1);
      var delta = (dx * 0.3) / window.innerWidth * dir * 100;
      var newPct = Math.max(0, Math.min(100, _touchState.origPct + delta));
      ctrlProgressFill.style.width = newPct + '%';
      if (ctrlProgressHandle) { ctrlProgressHandle.style.left = newPct + '%'; ctrlProgressHandle.style.opacity = '1'; }
      _showSeekTip((newPct / 100) * dur);
    }
  }, { passive: false });
  cp.addEventListener('touchend', function(e) {
    if (playerLocked) {
      e.preventDefault();
      return;
    }
    if (!_touchState) return;
    if (_touchState.timer) { clearTimeout(_touchState.timer); _touchState.timer = null; }
    var elapsed = Date.now() - _touchState.st;
    if (_touchState.isLP) {
      video.playbackRate = _touchState._saveSpeed || 1;
      ctrlSpeed.textContent = ((_touchState._saveSpeed || 1) === 1 ? '1' : (_touchState._saveSpeed || 1)) + 'x';
      cp.classList.remove('speed-boost');
      e.preventDefault();
    } else if (_touchState.mode === 'brightness' || _touchState.mode === 'volume') {
      e.preventDefault();
    } else if (_touchState.isSS) {
      var dur = video.duration || 0;
      if (dur > 0) {
        var pct = parseFloat(ctrlProgressFill.style.width) / 100;
        video.currentTime = pct * dur;
        if (video.paused) video.play();
      }
      setTimeout(function() {
        if (ctrlProgressHandle && video.duration > 0) {
          ctrlProgressHandle.style.opacity = '';
          ctrlProgressHandle.style.left = (video.currentTime / video.duration * 100) + '%';
          ctrlProgressFill.style.width = (video.currentTime / video.duration * 100) + '%';
        }
      }, 150);
      var tip = document.querySelector('.seek-tooltip');
      if (tip) tip.style.display = 'none';
      e.preventDefault();
    } else if (!_touchState.moved && elapsed < 300) {
      // 检测双击（两次短触 < 400ms 且位置接近）
      var now = Date.now();
      var nearX = Math.abs(_touchState.sx - _lastTapX) < 30;
      var nearY = Math.abs(_touchState.sy - _lastTapY) < 30;
      if (now - _lastTapTime < 400 && nearX && nearY) {
        // 双击 → 切换全屏
        _lastTapTime = 0;
        if (!document.fullscreenElement) {
          (cp.requestFullscreen || cp.webkitRequestFullscreen || cp.msRequestFullscreen).call(cp);
        } else {
          (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen).call(document);
        }
      } else {
        // 单击
        _lastTapTime = now;
        _lastTapX = _touchState.sx;
        _lastTapY = _touchState.sy;
        var isFS = cp.classList.contains('is-fullscreen');
        if (isFS && !fsControlsVisible) {
          showFSControls();
        } else {
          if (video.paused) video.play(); else video.pause();
        }
      }
      e.preventDefault();
    }
    _resetTouch();
  });
  cp.addEventListener('touchcancel', function() {
    if (_touchState && _touchState.isLP) {
      video.playbackRate = _touchState._saveSpeed || 1;
      ctrlSpeed.textContent = ((_touchState._saveSpeed || 1) === 1 ? '1' : (_touchState._saveSpeed || 1)) + 'x';
      cp.classList.remove('speed-boost');
    }
    _resetTouch();
  });

  // Click video to toggle play/pause (desktop single-click, not double-click)
  let clickTimer = null;
  video.addEventListener('click', function(e) {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
    clickTimer = setTimeout(function() {
      clickTimer = null;
      var isFullscreen = cp.classList.contains('is-fullscreen');
      if (isFullscreen && !fsControlsVisible) {
        showFSControls();
      } else {
        if (video.paused) video.play(); else video.pause();
      }
    }, 250);
    video.focus();
  });

  // Time & Progress
  video.addEventListener('timeupdate', function() {
    const cur = video.currentTime || 0;
    const dur = video.duration || 0;
    ctrlTime.textContent = formatTime(cur) + ' / ' + formatTime(dur);
    if (dur > 0) {
      const pct = (cur / dur) * 100;
      ctrlProgressFill.style.width = pct + '%';
      ctrlProgressInput.value = pct;
      if (ctrlProgressHandle && !ctrlProgressWrap.classList.contains('dragging') && !mouseOverProgress) {
        ctrlProgressHandle.style.left = pct + '%';
      }
    }
  });
  video.addEventListener('loadedmetadata', function() {
    ctrlTime.textContent = formatTime(video.currentTime || 0) + ' / ' + formatTime(video.duration || 0);
    ctrlProgressInput.value = 0;
    ctrlProgressFill.style.width = '0%';
  });

  // Seek
  ctrlProgressInput.addEventListener('input', function() {
    const dur = video.duration || 0;
    if (dur > 0) {
      video.currentTime = (parseFloat(ctrlProgressInput.value) / 100) * dur;
    }
  });

  // Progress bar hover tooltip
  const tooltip = document.createElement('div');
  tooltip.className = 'ctrl-progress-tooltip';
  tooltip.style.cssText = 'position:absolute; bottom:28px; background:rgba(0,0,0,.85); color:#fff; font-size:12px; padding:4px 8px; border-radius:4px; pointer-events:none; opacity:0; transition:opacity .15s; white-space:nowrap; z-index:35;';
  ctrlProgressWrap.appendChild(tooltip);
  ctrlProgressWrap.addEventListener('mousemove', function(e) {
    const dur = video.duration || 0;
    if (dur <= 0) return;
    const rect = ctrlProgressWrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    tooltip.textContent = formatTime(ratio * dur);
    tooltip.style.left = (ratio * 100) + '%';
    tooltip.style.transform = 'translateX(-50%)';
    tooltip.style.opacity = '1';
    // 圆点跟随鼠标位置
    if (ctrlProgressHandle) {
      ctrlProgressHandle.style.left = (ratio * 100) + '%';
    }
  });
  // 标记鼠标是否在进度条上
  let mouseOverProgress = false;
  ctrlProgressWrap.addEventListener('mouseenter', function() { mouseOverProgress = true; });
  ctrlProgressWrap.addEventListener('mouseleave', function() {
    mouseOverProgress = false;
    tooltip.style.opacity = '0';
    // 圆点回到当前播放位置（仅在非拖动时）
    if (ctrlProgressHandle && !ctrlProgressWrap.classList.contains('dragging')) {
      const dur = video.duration || 0;
      if (dur > 0) {
        const pct = (video.currentTime / dur) * 100;
        ctrlProgressHandle.style.left = pct + '%';
      }
    }
  });

  // ===== 全屏控制栏自动隐藏 =====
  let fsActivityTimer = null;
  let fsHideTimer = null;
  let fsControlsVisible = true; // 独立状态：控制栏是否可见
  function showFSControls() {
    if (!cp.classList.contains('is-fullscreen')) return;
    fsControlsVisible = true;
    cp.classList.add('user-active');
    cp.classList.remove('user-inactive');
    clearTimeout(fsHideTimer);
    fsHideTimer = setTimeout(function() {
      if (video && !video.paused) {
        fsControlsVisible = false;
        cp.classList.remove('user-active');
        cp.classList.add('user-inactive');
      }
    }, 1000);
  }
  // 全屏时追踪鼠标移动
  cp.addEventListener('mousemove', function() {
    if (cp.classList.contains('is-fullscreen')) showFSControls();
  });
  cp.addEventListener('mouseenter', function() {
    if (cp.classList.contains('is-fullscreen')) showFSControls();
  });
  // 全屏播放时添加 video-playing 类
  video.addEventListener('play', function() {
    cp.classList.add('video-playing');
    cp.classList.remove('video-paused');
    if (cp.classList.contains('is-fullscreen')) showFSControls();
  });
  video.addEventListener('pause', function() {
    cp.classList.remove('video-playing');
    cp.classList.add('video-paused');
    cp.classList.add('user-active');
    cp.classList.remove('user-inactive');
    fsControlsVisible = true;
    clearTimeout(fsHideTimer);
  });
  // ===== 缓冲/卡顿加载提示（PC & 移动端通用）=====
  var _videoBufferingShown = false;
  var _videoBufferingTimer = null;
  video.addEventListener('waiting', function() {
    // 仅在视频未结束时显示（ended 时 waiting 无意义）
    if (video.ended) return;
    clearTimeout(_videoBufferingTimer);
    var loadingEl = document.getElementById('playerLoading');
    // 如果已经在显示（例如切换播放源时的 showLoading），不覆盖
    if (loadingEl && !loadingEl.classList.contains('hidden')) return;
    _videoBufferingTimer = setTimeout(function() {
      showLoading('正在加载中，请稍后...', '正在为您奔走数据', 90);
      _videoBufferingShown = true;
    }, 400);
  });
  function _hideBufferingIfNeeded() {
    clearTimeout(_videoBufferingTimer);
    if (_videoBufferingShown) {
      hideLoading();
      _videoBufferingShown = false;
    }
  }
  video.addEventListener('canplay', _hideBufferingIfNeeded);
  video.addEventListener('playing', _hideBufferingIfNeeded);

  // ===== 进度条触摸拖动（移动端）=====
  let touchSeekActive = false;
  let touchSeekMoved = false;
  ctrlProgressWrap.addEventListener('touchstart', function(e) {
    if (video.duration <= 0) return;
    touchSeekActive = true;
    touchSeekMoved = false;
    ctrlProgressWrap.classList.add('dragging');
    const touch = e.touches[0];
    const rect = ctrlProgressWrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
    video.currentTime = ratio * video.duration;
    if (ctrlProgressHandle) ctrlProgressHandle.style.left = (ratio * 100) + '%';
    e.preventDefault();
  }, { passive: false });
  ctrlProgressWrap.addEventListener('touchmove', function(e) {
    if (!touchSeekActive || video.duration <= 0) return;
    touchSeekMoved = true;
    const touch = e.touches[0];
    const rect = ctrlProgressWrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
    video.currentTime = ratio * video.duration;
    if (ctrlProgressHandle) ctrlProgressHandle.style.left = (ratio * 100) + '%';
    e.preventDefault();
  }, { passive: false });
  ctrlProgressWrap.addEventListener('touchend', function() {
    touchSeekActive = false;
    ctrlProgressWrap.classList.remove('dragging');
    if (touchSeekMoved) {
      video.play().catch(function(){});
    }
    // 圆点回到当前播放位置
    if (ctrlProgressHandle && video.duration > 0) {
      const pct = (video.currentTime / video.duration) * 100;
      ctrlProgressHandle.style.left = pct + '%';
    }
  }, { passive: true });

  // Volume (vertical slider)
  const volumeWrap = document.getElementById('volumeWrap');
  const volumeSliderWrap = document.getElementById('volumeSliderWrap');
  function updateVolumeIcon() {
    if (video.muted || video.volume === 0) ctrlVolumeBtn.textContent = '🔇';
    else if (video.volume < 0.5) ctrlVolumeBtn.textContent = '🔉';
    else ctrlVolumeBtn.textContent = '🔊';
  }
  ctrlVolumeBtn.addEventListener('click', function() {
    video.muted = !video.muted;
    if (video.muted) callNative('setVolume', { value: 0 });
    else setGestureVolume(gestureVolume || 0.6);
    updateVolumeIcon();
  });
  ctrlVolumeSlider.addEventListener('input', function() {
    setGestureVolume(parseFloat(ctrlVolumeSlider.value));
  });
  // Keep slider visible while interacting
  ctrlVolumeSlider.addEventListener('mousedown', function() {
    if (volumeSliderWrap) volumeSliderWrap.classList.add('active');
  });
  document.addEventListener('mouseup', function() {
    if (volumeSliderWrap) volumeSliderWrap.classList.remove('active');
  });
  video.addEventListener('volumechange', updateVolumeIcon);

  // Playback speed
  const speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  ctrlSpeed.addEventListener('click', function() {
    toggleSpeedSelector();
  });
  // Render speed selector grid
  function renderSpeedSelector() {
    const grid = document.getElementById('speedSelGrid');
    if (!grid) return;
    grid.innerHTML = speeds.map(s => {
      const label = (s === 1 ? '1.0' : s) + 'x';
      return '<button class="speed-sel-btn' + (Math.abs(s - currentSpeed) < 0.01 ? ' on' : '') + '" onclick="setSpeed(' + s + '); toggleSpeedSelector();">' + label + '</button>';
    }).join('');
  }
  renderSpeedSelector();
  // Close speed panel when clicking outside
  document.addEventListener('click', function(e) {
    const panel = document.getElementById('speedSelectorPanel');
    const btn = document.getElementById('ctrlSpeed');
    if (panel && panel.classList.contains('open') && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      panel.classList.remove('open');
    }
  });

  // Fullscreen
  ctrlFullscreen.addEventListener('click', function() {
    if (!document.fullscreenElement) {
      (cp.requestFullscreen || cp.webkitRequestFullscreen || cp.msRequestFullscreen).call(cp);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen).call(document);
    }
  });
  document.addEventListener('fullscreenchange', function() {
    if (document.fullscreenElement) {
      cp.classList.add('is-fullscreen');
      document.body.classList.add('player-fullscreen-active');
      setNativeViewingMode(true);
      // 强制 video 铺满整个全屏容器（top→bottom，left→right），control bar 浮在视频上方
      video.style.cssText = 'position:fixed !important; top:0 !important; left:0 !important; width:100vw !important; height:100vh !important; object-fit:contain !important; object-position:center center !important; max-height:none !important; max-width:none !important; margin:0 !important; padding:0 !important; background:#000 !important;';
      // 启动全屏控制栏自动隐藏
      fsControlsVisible = true;
      if (!video.paused) showFSControls();
    } else {
      setPlayerLocked(false);
      document.body.classList.remove('player-fullscreen-active');
      setNativeViewingMode(false);
      cp.classList.remove('is-fullscreen');
      video.style.cssText = 'width:100%; max-height:65vh; display:block; background:#000;';
      fsControlsVisible = true;
      closeAllPanelsExcept(null);
      clearTimeout(fsHideTimer);
      cp.classList.add('user-active');
      cp.classList.remove('user-inactive');
    }
  });
  // Intercept native video fullscreen to use customPlayer
  const origRequest = video.requestFullscreen ? video.requestFullscreen.bind(video) : null;
  if (origRequest) {
    Object.defineProperty(video, 'requestFullscreen', {
      value: function() {
        if (!document.fullscreenElement) {
          return (cp.requestFullscreen || cp.webkitRequestFullscreen || cp.msRequestFullscreen).call(cp);
        }
        return origRequest();
      }
    });
  }
  if (video.webkitRequestFullscreen) {
    const origW = video.webkitRequestFullscreen.bind(video);
    Object.defineProperty(video, 'webkitRequestFullscreen', {
      value: function() {
        if (!document.fullscreenElement) {
          return (cp.webkitRequestFullscreen).call(cp);
        }
        return origW();
      }
    });
  }
  video.addEventListener('dblclick', function(e) {
    e.preventDefault();
    if (!document.fullscreenElement) {
      (cp.requestFullscreen || cp.webkitRequestFullscreen || cp.msRequestFullscreen).call(cp);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen).call(document);
    }
  });

  // Keyboard shortcuts (arrow keys seek, space toggle play, long-press right = 3x)
  let longPressTimer = null;
  let isLongPress = false;
  let preLongPressSpeed = 1;
  document.addEventListener('keydown', function(e) {
    if (e.repeat) return; // ignore auto-repeat while holding
    // Only handle when video is the active element or in fullscreen, or user clicked on player recently
    const active = document.activeElement;
    const isPlayerFocused = cp.contains(active) || active === video || active === document.body;
    const isFullscreen = document.fullscreenElement === cp || document.webkitFullscreenElement === cp;
    if (!isPlayerFocused && !isFullscreen) return;
    // Ignore if typing in an input/textarea
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 5);
        showSeekFeedback('-5s');
        break;
      case 'ArrowRight':
        e.preventDefault();
        // Start long-press detection
        isLongPress = false;
        longPressTimer = setTimeout(function() {
          isLongPress = true;
          preLongPressSpeed = video.playbackRate;
          video.playbackRate = 3;
          showSeekFeedback('3x 快进');
        }, 400);
        break;
      case ' ':
      case 'k':
        e.preventDefault();
        if (video.paused) video.play().catch(()=>{}); else video.pause();
        break;
      case 'f':
        e.preventDefault();
        ctrlFullscreen.click();
        break;
      case 'm':
        e.preventDefault();
        video.muted = !video.muted;
        updateVolumeIcon();
        break;
    }
  });
  document.addEventListener('keyup', function(e) {
    if (e.key === 'ArrowRight') {
      clearTimeout(longPressTimer);
      longPressTimer = null;
      if (isLongPress) {
        // Long press ended: restore speed
        video.playbackRate = preLongPressSpeed;
        isLongPress = false;
      } else {
        // Short press: seek +5s
        video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5);
        showSeekFeedback('+5s');
      }
    }
  });

  // Quality info display (read-only, shows video_type from API)
  const ctrlQuality = document.getElementById('ctrlQuality');

  // Settings panel
  document.addEventListener('click', function(e) {
    const panel = document.getElementById('settingsPanel');
    const btn = document.getElementById('ctrlSettings');
    if (panel && panel.classList.contains('open') && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      panel.classList.remove('open');
    }
  });

  // Auto-play next / loop single episode
  let autoPlayNext = false;
  let loopSingle = false;
  const autoPlayToggle = document.getElementById('autoPlayToggle');
  const loopToggle = document.getElementById('loopToggle');
  if (autoPlayToggle) {
    autoPlayToggle.addEventListener('change', function() {
      autoPlayNext = this.checked;
      if (autoPlayNext && loopToggle && loopToggle.checked) {
        loopToggle.checked = false;
        loopSingle = false;
      }
    });
  }
  if (loopToggle) {
    loopToggle.addEventListener('change', function() {
      loopSingle = this.checked;
      if (loopSingle && autoPlayToggle && autoPlayToggle.checked) {
        autoPlayToggle.checked = false;
        autoPlayNext = false;
      }
    });
  }
  video.addEventListener('ended', function() {
    if (loopSingle) {
      video.currentTime = 0;
      video.play().catch(()=>{});
    } else if (autoPlayNext) {
      const nextEp = currentEp + 1;
      if (nextEp < playlist.length) {
        playEp(nextEp);
      }
    }
  });

  // Show brief feedback toast on seek
  function showSeekFeedback(text) {
    let toast = document.getElementById('seekFeedback');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'seekFeedback';
      toast.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.7);color:#fff;padding:8px 16px;border-radius:8px;font-size:14px;z-index:40;pointer-events:none;opacity:0;transition:opacity .15s;';
      cp.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.opacity = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 600);
  }
})();

// Compatible fetch with timeout (AbortSignal.timeout not supported in older browsers)
function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = controller.signal;
  return fetch(url, { ...options, signal }).finally(() => clearTimeout(timer));
}

function getParams() {
  const params = new URLSearchParams(location.search);
  currentMsg = params.get('msg') || '';
  currentN = params.get('n') || '';
  // Note: 'ep' param is resume episode number (handled by resumeFromHistory),
  // NOT the AniList total episode count. Do NOT assign to currentAniEpisodes.
}
getParams();

let secondaryLoadsScheduled = false;
function scheduleSecondaryLoads() {
  if (secondaryLoadsScheduled) return;
  secondaryLoadsScheduled = true;
  const revision = detailsRevision;
  const run = () => {
    if (revision !== detailsRevision) { secondaryLoadsScheduled = false; scheduleSecondaryLoads(); return; }
    loadFranchise();
    loadRecommendations();
  };
  if ('requestIdleCallback' in window) {
    requestIdleCallback(run, { timeout: 2500 });
  } else {
    setTimeout(run, 1200);
  }
}

async function init() {
  if (!currentMsg || currentN === '') {
    showError('缺少必要参数（msg 或 n），请先从搜索页进入');
    return;
  }
  _franchiseHighlightIdx = parseInt(currentN) || 1;
  // Show initial page loading progress
  const infoEl = document.getElementById('info');
  const posterEl = document.getElementById('poster');
  infoEl.innerHTML = `
    <div style="padding:40px 0;display:flex;flex-direction:column;align-items:center;gap:16px;">
      <div class="spin" style="width:44px;height:44px;border:3px solid #30363d;border-top-color:#e85d04;border-radius:50%;animation:spin .8s linear infinite;"></div>
      <div style="color:#e6edf3;font-size:15px;font-weight:600;" id="pageLoadMsg">正在获取动漫详情...</div>
      <div style="width:240px;height:6px;background:#21262d;border-radius:3px;overflow:hidden;">
        <div style="height:100%;background:linear-gradient(90deg,#e85d04,#fd7e14);border-radius:3px;transition:width .4s ease;width:10%;" id="pageLoadBar"></div>
      </div>
      <div style="color:#8b949e;font-size:12px;" id="pageLoadSub">连接数据源中</div>
    </div>`;
  await loadDetails();
}

let detailsRevision = 0;
async function loadDetails() {
  const revision = ++detailsRevision;
  const ownsDetails = () => revision === detailsRevision;
  const infoEl = document.getElementById('info');
  const posterEl = document.getElementById('poster');

  function updatePageProgress(msg, sub, pct) {
    const msgEl = document.getElementById('pageLoadMsg');
    const barEl = document.getElementById('pageLoadBar');
    const subEl = document.getElementById('pageLoadSub');
    if (msgEl) msgEl.textContent = msg;
    if (barEl) barEl.style.width = pct + '%';
    if (subEl) subEl.textContent = sub;
  }

  try {
    updatePageProgress('正在获取动漫详情...', '连接数据源中', 15);
    const d = await fetchDetails(currentMsg, currentN);
    if (!ownsDetails()) return;
    if (d.error) throw new Error(d.error);
    if (!isUsableDetails(d)) throw new Error('详情数据不完整，请重新匹配播放源');
    updatePageProgress('正在解析剧集信息...', '处理播放列表', 50);

    // CRITICAL: backend may have resolved the correct numeric n
    if (d.resolved_n && String(d.resolved_n) !== String(currentN)) {
      currentN = String(d.resolved_n);
    }

    // Use episodes from backend (AniList) for SP/OVA detection
    if (d.episodes && d.episodes !== '?' && !isNaN(parseInt(d.episodes))) {
      currentAniEpisodes = parseInt(d.episodes);
    }

    updatePageProgress('正在渲染页面...', '即将显示作品', 85);
    renderInfo(d);
    if (d.playlist && d.playlist.length > 0) {
      playlist = d.playlist;
      renderEpisodes(d.playlist, d);
    }
    updatePageProgress('加载完成', '', 100);
    scheduleSecondaryLoads();
  } catch (e) {
    if (!ownsDetails()) return;
    // Fallback chain: bridge → try n+1/n+2 → error
    let recovered = false;

    // Fallback 1: try bridge API
    try {
      const bridged = await tryBridge(currentMsg);
      if (!ownsDetails()) return;
      if (bridged && bridged.found) {
        currentMsg = bridged.msg;
        currentN = bridged.n;
        const d2 = await fetchDetails(currentMsg, currentN);
        if (!ownsDetails()) return;
        if (!d2.error && isUsableDetails(d2)) {
          renderInfo(d2);
          playlist = d2.playlist;
          renderEpisodes(d2.playlist, d2);
          scheduleSecondaryLoads();
          recovered = true;
        }
      }
    } catch (bridgeErr) {}

    // Fallback 2: 仅当搜索词不含明确季数时，尝试相邻 n 值（防止误跳到其他季）
    if (!recovered && currentN) {
      const hasSeasonHint = /第[一二三四五六七八九十\d]+[季期]|最终季|Season\s*\d+|Part\s*\d+/i.test(currentMsg);
      const startN = parseInt(currentN) || 1;
      const tryRange = hasSeasonHint ? [] : [startN + 1, startN + 2]; // 无季数标记时才试探，最多2次
      for (let tryN of tryRange) {
        try {
          const d3 = await fetchDetails(currentMsg, tryN);
          if (!ownsDetails()) return;
          if (!d3.error && isUsableDetails(d3)) {
            currentN = String(tryN);
            renderInfo(d3);
            playlist = d3.playlist;
            renderEpisodes(d3.playlist, d3);
            scheduleSecondaryLoads();
            recovered = true;
            break;
          }
        } catch (tryErr) {}
      }
    }

    if (!recovered) {
      showError(
        '加载失败：' + (e.message || '请求失败') +
        '<br><small style="opacity:0.7">当前搜索词: ' + escapeHtml(currentMsg) + '</small>' +
        '<br><button onclick="location.href=\'/search_anime.html?q=\' + encodeURIComponent(currentMsg)" style="margin-top:8px;background:#21262d;color:#8b949e;border:1px solid #30363d;padding:8px 24px;border-radius:20px;cursor:pointer;font-size:14px">🔍 重新搜索</button>' +
        ' <button onclick="history.back()" style="margin-top:8px;background:#21262d;color:#8b949e;border:1px solid #30363d;padding:8px 24px;border-radius:20px;cursor:pointer;font-size:14px">← 返回</button>',
        true
      );
    }
  }
}

function isUsableDetails(d) {
  return !!(
    d &&
    !d.error &&
    String(d.name || '').trim() &&
    Array.isArray(d.playlist) &&
    d.playlist.length > 0
  );
}

async function fetchDetails(msg, n) {
  const r = await fetch('/api/oi/details?msg=' + encodeURIComponent(msg) + '&n=' + n);
  if (!r.ok) {
    // Try to read server error message from JSON body
    try {
      const body = await r.json();
      if (body && body.error) return { error: body.error };
    } catch (parseErr) {}
    return { error: '请求失败 (HTTP ' + r.status + ')' };
  }
  return await r.json();
}

async function tryBridge(title) {
  try {
    const params = new URLSearchParams();
    params.append('title', title);
    const r = await fetch('/api/oi/bridge?' + params.toString());
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

function updateAnimeAgentContext(extra) {
  const video = document.getElementById('videoPlayer');
  const followBtn = document.getElementById('followBtn');
  const ep = playlist && playlist[currentEp] ? playlist[currentEp] : null;
  const actual = window.PlaybackSessions.playing;
  const matchesSelection = actual && actual.animeId === getCurrentAnimeId() && actual.episodeIndex === currentEp;
  const progress = matchesSelection && video && video.duration && !isNaN(video.duration)
    ? Math.round((video.currentTime / video.duration) * 100)
    : 0;
  window.__animeAgentContext = Object.assign({
    page: location.pathname,
    anilistId: currentAnimeAnilistId,
    title: document.querySelector('.info h1')?.textContent || currentMsg,
    msg: currentMsg,
    n: currentN,
    episodeIndex: currentEp + 1,
    episode: ep?.name || ep?.title || ep?.ji || ('第' + (currentEp + 1) + '集'),
    progress,
    playing: !!(matchesSelection && video && !video.paused),
    isFavorited: !!(followBtn && followBtn.classList.contains('followed'))
  }, extra || {});
}

function renderInfo(d) {
  const infoEl = document.getElementById('info');
  const posterEl = document.getElementById('poster');
  currentAnimeAnilistId = Number(d.aniId) || 0;
  updateAnimeAgentContext({ title: d.name || currentMsg });

  posterEl.innerHTML = d.image
    ? '<img src="' + escapeHtml(window.SiteUtils.safeImageUrl(d.image)) + '" alt="' + escapeHtml(d.name) + '" onerror="this.style.display=\'none\'">'
    : '';

  // Build unique anime ID
  const animeId = getCurrentAnimeId();

  let html = '<h1>' + escapeHtml(d.name || '未知标题') + '</h1>';
  html += '<div class="meta">';
  if (d.ji) html += '<span>📡 ' + escapeHtml(d.ji) + '</span>';
  if (d.year) html += '<span>📅 ' + escapeHtml(d.year) + '</span>';
  if (d.class) html += '<span>🏷 ' + escapeHtml(d.class) + '</span>';
  if (d.aniScore) html += '<span>⭐ ' + escapeHtml(d.aniScore) + '分</span>';
  if (d.aniFormat) html += '<span>🎬 ' + escapeHtml(d.aniFormat) + '</span>';
  if (d.aniStatus) {
    const statusMap = { FINISHED: '已完结', RELEASING: '连载中', NOT_YET_RELEASED: '未开播', CANCELLED: '已取消', HIATUS: '休刊中' };
    html += '<span>📺 ' + escapeHtml(statusMap[d.aniStatus] || d.aniStatus) + '</span>';
  }
  html += '</div>';
  if (d.aniGenres && d.aniGenres.length > 0) {
    html += '<div class="meta" style="margin-top:6px;">' + d.aniGenres.map(function(g) {
      return '<span style="background:#21262d;padding:2px 8px;border-radius:10px;font-size:12px;">' + escapeHtml(g) + '</span>';
    }).join('') + '</div>';
  }
  if (d.desc) html += '<div class="desc">' + escapeHtml(d.desc) + '</div>';

  // Follow button
  const token = getAnimeToken();
  if (!token) {
    html += '<div class="follow-login-tip">💡 <a href="my.html">登录</a>后可追番和记录观看历史</div>';
  } else {
    html += '<button class="follow-btn not-followed" id="followBtn"><span class="follow-heart">♡</span> 追番</button>';
  }
  infoEl.innerHTML = html;
  document.getElementById('followBtn')?.addEventListener('click', () => toggleFollow(animeId, d.name || '', d.image || ''));

  // Check follow status
  if (token) checkFollowStatus(animeId);
}

// ===== In-player episode selector =====
function toggleEpSelector() {
  const panel = document.getElementById('epSelectorPanel');
  if (!panel) return;
  closeAllPanelsExcept(panel);
  panel.classList.toggle('open');
}
function toggleSpeedSelector() {
  const panel = document.getElementById('speedSelectorPanel');
  if (!panel) return;
  closeAllPanelsExcept(panel);
  panel.classList.toggle('open');
}
function setSpeed(rate) {
  const video = document.getElementById('videoPlayer');
  if (!video) return;
  video.playbackRate = rate;
  currentSpeed = rate;
  const ctrlSpeed = document.getElementById('ctrlSpeed');
  if (ctrlSpeed) ctrlSpeed.textContent = (rate === 1 ? '1' : rate) + 'x';
  // Update selector UI
  document.querySelectorAll('.speed-sel-btn').forEach(btn => {
    const btnRate = parseFloat(btn.textContent);
    btn.classList.toggle('on', Math.abs(btnRate - rate) < 0.01);
  });
}
function toggleSettingsPanel() {
  const panel = document.getElementById('settingsPanel');
  if (!panel) return;
  closeAllPanelsExcept(panel);
  panel.classList.toggle('open');
}
function closeAllPanelsExcept(except) {
  ['epSelectorPanel', 'speedSelectorPanel', 'settingsPanel', 'qualitySelectorPanel'].forEach(function(id) {
    const p = document.getElementById(id);
    if (p && p !== except) p.classList.remove('open');
  });
}

// ===== 画质切换 =====
function getQualityLabel(source) {
  // 优先使用实际检测到的视频高度
  if (source._realHeight) {
    const h = source._realHeight;
    if (h >= 2160) return '4K';
    if (h >= 1440) return '2K';
    if (h >= 1080) return '1080P';
    if (h >= 720)  return '720P';
    if (h >= 480)  return '480P';
    return h + 'P';
  }
  const url = (source.play_url || source.proxy_url || '').toLowerCase();
  // 1. 从URL提取分辨率：xxxp 或 _xxx_ 或 -xxx-
  const r1 = url.match(/[\/_-](\d{3,4})p/i);
  const r2 = url.match(/[\/_-](\d{4})[\/_.-]/);
  const res = r1 ? parseInt(r1[1]) : (r2 ? parseInt(r2[1]) : 0);
  if (res >= 3840) return '4K';
  if (res >= 2560) return '2K';
  if (res >= 1920) return '1080P';
  if (res >= 1280) return '720P';
  if (res >= 720) return '480P';
  if (res >= 360) return '360P';
  // 2. 关键词匹配
  if (url.includes('4k') || url.includes('2160p')) return '4K';
  if (url.includes('1080p') || url.includes('fhd') || url.includes('fullhd')) return '1080P';
  if (url.includes('720p') || url.includes('hd')) return '720P';
  if (url.includes('480p') || url.includes('sd')) return '480P';
  if (url.includes('360p')) return '360P';
  // 3. 兜底：type → 按顺序标记
  const labels = { '1': '1080P', '2': '720P', '3': '480P' };
  return labels[String(source.type)] || ('线路 ' + source.type);
}

function getQualityCodec(source) {
  const vt = (source.video_type || '').toLowerCase();
  const url = (source.play_url || source.proxy_url || '').toLowerCase();
  if (/x265|hevc|h265|hvc1|hev1/.test(vt) || /x265|hevc|h265|hvc1|hev1/.test(url)) return 'HEVC';
  if (/x264|avc|h264/.test(vt) || /x264|avc|h264/.test(url)) return 'H264';
  return vt.toUpperCase() || '';
}

function toggleQualitySelector() {
  var ctrlQ = document.getElementById('ctrlQuality');
  // 只有一种画质时不允许打开面板
  if (ctrlQ && ctrlQ.getAttribute('data-single') === '1') return;
  const panel = document.getElementById('qualitySelectorPanel');
  if (!panel) return;
  closeAllPanelsExcept(panel);
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) renderQualitySelector();
}

function renderQualitySelector() {
  const list = document.getElementById('qualitySelList');
  const ctrlQ = document.getElementById('ctrlQuality');
  if (!list || !ctrlQ) return;
  var items = [];

  // HLS 多级别检测：如果当前播放的是HLS且有多个清晰度
  var hlsLevels = [];
  if (typeof window.hlsInstance !== 'undefined' && window.hlsInstance && window.hlsInstance.levels && window.hlsInstance.levels.length > 1) {
    hlsLevels = window.hlsInstance.levels;
  }

  if (hlsLevels.length > 1) {
    // HLS 内置多清晰度 —— 使用 levels 切换
    items.push({ label: '自动', idx: -1, isHls: true, active: hlsInstance.currentLevel === -1 });
    hlsLevels.forEach(function(lv, i) {
      var h = lv.height || 0;
      var label = h >= 2160 ? '4K' : h >= 1080 ? '1080P' : h >= 720 ? '720P' : h >= 480 ? '480P' : (h + 'P');
      var bitrate = lv.bitrate ? ' · ' + (lv.bitrate / 1000000).toFixed(1) + 'Mbps' : '';
      items.push({ label: label, idx: i, sub: bitrate, isHls: true, active: hlsInstance.currentLevel === i });
    });
  } else if (allSources && allSources.length > 1) {
    // OIAPI 多线路源
    allSources.forEach(function(s, i) {
      var label = getQualityLabel(s);
      var codec = getQualityCodec(s);
      items.push({ label: label, idx: i, codec: codec, isHls: false, active: i === currentSourceIdx });
    });
  } else if (allSources && allSources.length === 1) {
    // 仅一个源，显示但不可切换
    var s = allSources[0];
    var label = getQualityLabel(s);
    var codec = getQualityCodec(s);
    ctrlQ.textContent = label;
    ctrlQ.style.cursor = 'default';
    ctrlQ.setAttribute('data-single', '1');
    list.innerHTML = '<div class="quality-item" style="color:#8b949e;cursor:default;pointer-events:none">' +
      '<span>' + label + '</span><span class="q-codec">' + codec + '</span></div>';
    return;
  }

  if (items.length === 0) {
    list.innerHTML = '<div class="quality-item" style="color:#8b949e;cursor:default">仅当前画质</div>';
    return;
  }

  // 去重：同标签只保留一个，优先保留当前激活的
  var seen = {};
  var deduped = [];
  for (var k = 0; k < items.length; k++) {
    var it = items[k];
    if (!seen[it.label]) {
      seen[it.label] = it;
      deduped.push(it);
    } else if (it.active && !seen[it.label].active) {
      // 替换为当前激活的
      for (var j = 0; j < deduped.length; j++) {
        if (deduped[j] === seen[it.label]) { deduped[j] = it; break; }
      }
      seen[it.label] = it;
    }
  }
  items = deduped;

  // 去重后只有一种画质（忽略"自动"选项）→ 不可切换
  var realItems = items.filter(it => it.idx !== -1);
  if (realItems.length <= 1) {
    var singleLabel = realItems.length === 1 ? realItems[0].label : (items.length > 0 ? items[0].label : '当前画质');
    ctrlQ.textContent = singleLabel;
    ctrlQ.style.cursor = 'default';
    ctrlQ.setAttribute('data-single', '1');
    list.innerHTML = '<div class="quality-item" style="color:#8b949e;cursor:default;pointer-events:none">' +
      '<span>' + singleLabel + '</span></div>';
    return;
  }

  ctrlQ.removeAttribute('data-single');
  ctrlQ.style.cursor = '';

  list.innerHTML = items.map(function(it) {
    var right = it.codec ? '<span class="q-codec">' + it.codec + '</span>' : (it.sub || '');
    return '<div class="quality-item' + (it.active ? ' on' : '') + '" onclick="selectQuality(' + it.idx + ',' + it.isHls + ')">' +
      '<span>' + it.label + '</span>' + right +
      '</div>';
  }).join('');

  // 更新按钮文字
  var cur = items.find(function(it) { return it.active; });
  if (cur) {
    ctrlQ.textContent = cur.label;
  }
  ctrlQ.style.cursor = '';
}

function selectQuality(idx, isHls) {
  if (isHls) {
    // HLS 级别切换（即时，不需重载）
    if (typeof window.hlsInstance !== 'undefined' && window.hlsInstance) {
      window.hlsInstance.currentLevel = idx; // -1 = auto
    }
  } else {
    // 切换 OIAPI 线路
    if (idx >= 0 && idx < allSources.length && idx !== currentSourceIdx) {
      switchSource(idx);
      return; // switchSource 内部会刷新 UI
    }
  }
  // 刷新面板高亮 + 按钮文字
  renderQualitySelector();
  var panel = document.getElementById('qualitySelectorPanel');
  if (panel) panel.classList.remove('open');
}

function renderEpSelector(list, regularCount, hasSpecials) {
  const grid = document.getElementById('epSelGrid');
  const title = document.getElementById('epSelTitle');
  if (!grid) return;
  if (title) {
    if (hasSpecials) {
      title.textContent = '选择集数（' + regularCount + '集正片 + ' + (list.length - regularCount) + '特别篇）';
    } else {
      title.textContent = '选择集数（共' + list.length + '集）';
    }
  }
  grid.innerHTML = list.map((ep, i) => {
    const isSpecial = hasSpecials && i >= regularCount;
    const label = typeof ep === 'string' ? ep : (ep.title || '第' + (i + 1) + '集');
    if (isSpecial) {
      const epStr = typeof ep === 'string' ? ep : (ep.title || '');
      const isOva = /OVA|OAD|oad/i.test(epStr);
      const badge = isOva ? 'OVA' : 'SP';
      const displayLabel = badge + (i - regularCount + 1);
      return '<button class="ep-sel-btn ' + (isOva ? 'ova' : 'sp') + (i === currentEp ? ' on' : '') + '" data-ep-index="' + i + '" onclick="playEp(' + i + '); toggleEpSelector();">' + displayLabel + '</button>';
    }
    return '<button class="ep-sel-btn' + (i === currentEp ? ' on' : '') + '" data-ep-index="' + i + '" onclick="playEp(' + i + '); toggleEpSelector();">' + escapeHtml(label) + '</button>';
  }).join('');
}

function renderEpisodes(list, aniData) {
  document.getElementById('epSection').style.display = 'block';
  document.getElementById('playerWrapper').style.display = 'none';
  const title = document.getElementById('epTitle');
  if (title) title.textContent = '客户端观看';
  const grid = document.getElementById('epGrid');
  grid.replaceChildren();
  const notice = document.createElement('p');
  notice.textContent = '请在 Android / Windows 客户端打开本作品，选择 AGE、DM84 或 enlie 播放。网页目录的剧集资料不代表这些源均已收录。';
  grid.appendChild(notice);
}

// ===== 新番推荐（从更新日历随机抽取） =====
async function loadRecommendations() {
  const section = document.getElementById('recommendSection');
  const grid = document.getElementById('recommendGrid');
  if (!section || !grid) return;
  grid.innerHTML = '<div style="padding:20px;color:#8b949e;font-size:14px;">加载推荐中...</div>';
  section.style.display = 'block';
  try {
    const fetchResults = async (url) => {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return Array.isArray(data.results) ? data.results : [];
    };

    // Use several independent sources. The recommendation section should not
    // disappear just because one narrow category endpoint returns empty.
    const endpoints = [
      '/api/oi/trending',
      '/api/oi/newseason',
      '/api/oi/recommend?excludeId=' + encodeURIComponent(currentAnimeAnilistId || ''),
      '/api/oi/rankings?type=popular',
      '/api/oi/rankings?type=toprated'
    ];

    const settled = await Promise.allSettled(endpoints.map(fetchResults));
    let all = settled.flatMap(item => item.status === 'fulfilled' ? item.value : []);

    // Deduplicate by title
    const seen = new Set();
    all = all.filter(item => {
      const id = Number(item.anilistId || item.id || 0);
      if (currentAnimeAnilistId && id && id === Number(currentAnimeAnilistId)) return false;
      const title = item.title || item.name || item.romaji || item.nativeTitle || '';
      if (!title || title === currentMsg) return false;
      const key = id ? `id:${id}` : `title:${String(title).toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Shuffle and take 8
    const results = all.sort(() => Math.random() - 0.5).slice(0, 8);
    renderRecommendations(results);
  } catch (e) {
    console.error('Load recommendations:', e);
    section.style.display = 'none';
  }
}

function renderRecommendations(results) {
  const section = document.getElementById('recommendSection');
  const grid = document.getElementById('recommendGrid');
  if (!section || !grid) return;
  if (!results || results.length === 0) {
    grid.innerHTML = '<div style="padding:18px;color:#8b949e;font-size:14px;">暂时没有拿到推荐番剧，稍后刷新试试。</div>';
    section.style.display = 'block';
    return;
  }
  grid.innerHTML = results.map((item, idx) => {
    const displayTitle = item.title || '未知';
    const scoreStr = item.score ? '<span class="rec-score">★ ' + (item.score / 10).toFixed(1) + '</span>' : '';
    const yearStr = item.seasonYear ? '<span class="rec-badge">' + item.seasonYear + '</span>' : '';
    const epStr = item.episodes && item.episodes !== '?' ? '<span class="rec-badge">' + item.episodes + '集</span>' : '';
    const statusStr = item.status === 'RELEASING' ? '<span class="rec-badge" style="background:#e85d04;color:#fff;">连载中</span>' : '';
    const dataIdx = window._animeData.length + idx;
    return '<a class="recommend-card" href="javascript:void(0)" onclick="playAnime(window._animeData[' + dataIdx + ']); return false" title="' + escapeHtml(displayTitle) + '">\n' +
      '<img src="' + escapeHtml(window.SiteUtils.safeImageUrl(item.image)) + '" alt="' + escapeHtml(displayTitle) + '" loading="lazy" onerror="this.style.display=\'none\'">\n' +
      '<div class="rec-info">\n' +
        '<div class="rec-title">' + escapeHtml(displayTitle) + '</div>\n' +
        '<div class="rec-meta">' + scoreStr + yearStr + epStr + statusStr + '</div>\n' +
      '</div>\n' +
    '</a>';
  }).join('');
  // 将数据存入全局数组供 onclick 使用
  results.forEach(item => window._animeData.push(item));
  section.style.display = 'block';
}

// Extract episode identifier from playlist item
function getEpisodeJ(list, idx) {
  if (idx < 0 || idx >= list.length) {
    return String(idx + 1);
  }
  const ep = list[idx];
  if (typeof ep === 'object' && ep !== null) {
    // Use explicit episode number fields if available
    if (ep.j !== undefined) return String(ep.j);
    if (ep.ep !== undefined) return String(ep.ep);
    if (ep.num !== undefined) return String(ep.num);
    if (ep.episode !== undefined) return String(ep.episode);
    if (ep.id !== undefined) return String(ep.id);
    // Try to extract number from title like "第5集" or "EP05"
    if (ep.title) {
      const m = ep.title.match(/第?0*(\d+)[集話话]?/);
      if (m) return m[1];
      const m2 = ep.title.match(/EP?0*(\d+)/i);
      if (m2) return m2[1];
    }
  }
  if (typeof ep === 'string') {
    // Capture the full number including leading zeros (e.g. "第01集" → "01", "第1集" → "1")
    const m = ep.match(/第?(\d+)[集話话]?/);
    if (m) return m[1];
    const m2 = ep.match(/EP?(\d+)/i);
    if (m2) return m2[1];
  }
  return String(idx + 1);
}

// (settings removed)


function updateQualityUI() {
  // (settings removed - no-op)
}

function switchQuality(t) {
  currentType = String(t);
  // (settings removed - fallback to replay)
  if (playlist.length > 0) {
    playEp(currentEp);
  }
}


function findPlayableSourceIndex(videoEl, startIdx) {
  if (!Array.isArray(allSources) || allSources.length === 0) return -1;
  const supportsHevc = browserReportsHevcSupport(videoEl);
  for (let i = Math.max(0, startIdx || 0); i < allSources.length; i++) {
    if (!isLikelyHevcSource(allSources[i]) || supportsHevc) return i;
  }
  return -1;
}

// Network work uses the immutable selection and remains cancellable through JSON parsing.
async function playbackJson(path, session, timeoutMs) {
  const controller = new AbortController();
  const cancel = session.add(() => controller.abort());
  const timer = setTimeout(cancel, timeoutMs);
  try {
    if (!session.active()) return null;
    const response = await fetch(path, { signal: controller.signal });
    return response.ok ? await response.json() : null;
  } catch (_) { return null; }
  finally { clearTimeout(timer); session.cleanups.delete(cancel); }
}
function playbackQuery(session) {
  return 'msg=' + encodeURIComponent(session.identity.msg) + '&n=' + session.identity.n;
}
async function tryPlayJ(j, type, session) {
  const data = await playbackJson('/api/oi/play?' + playbackQuery(session)
    + '&j=' + encodeURIComponent(j) + '&type=' + (type || 'auto'), session, 10000);
  return data?.play_url && !data.error ? data : null;
}
async function fetchSources(j, session) {
  return playbackJson('/api/oi/sources?' + playbackQuery(session)
    + '&j=' + encodeURIComponent(j), session, 12000);
}

// Quick loading message helper with progress bar
function showLoading(msg, sub, pct) {
  const el = document.getElementById('playerLoading');
  const msgEl = document.getElementById('loadingMsg');
  const subEl = document.getElementById('loadingSub');
  const barEl = document.getElementById('loadingBar');
  const pctEl = document.getElementById('loadingPct');
  if (el) el.classList.remove('hidden');
  if (msgEl) msgEl.textContent = msg || '正在获取播放地址...';
  if (subEl) subEl.textContent = sub || '';
  if (barEl && typeof pct === 'number') {
    barEl.style.width = Math.min(100, Math.max(0, pct)) + '%';
  }
  if (pctEl && typeof pct === 'number') {
    pctEl.textContent = Math.round(pct) + '%';
  } else if (pctEl) {
    pctEl.textContent = '';
  }
}
function hideLoading() {
  const el = document.getElementById('playerLoading');
  const barEl = document.getElementById('loadingBar');
  const pctEl = document.getElementById('loadingPct');
  if (el) el.classList.add('hidden');
  if (barEl) barEl.style.width = '0%';
  if (pctEl) pctEl.textContent = '';
}

// Render source selector UI (旧 sourceGroup/sourceList 已移除，直接使用画质选择器)
function renderSources() {
  renderQualitySelector();
}

function playbackIdentity(idx) {
  return { animeId: getCurrentAnimeId(), anilistId: currentAnimeAnilistId,
    title: document.querySelector('.info h1')?.textContent || currentMsg,
    image: document.querySelector('.poster img')?.src || '', msg: currentMsg,
    n: Number(currentN) || 1, episode: String(getEpisodeJ(playlist, idx)),
    episodeIndex: idx, token: getAnimeToken() };
}
function playbackResume(session) {
  const video = document.getElementById('videoPlayer');
  if (session && window.PlaybackSessions.playing === session.identity && Number.isFinite(video.currentTime)) {
    return { position: video.currentTime,
      paused: video.error ? !(session.wasPlaying ?? !session.resume?.paused) : video.paused, rate: video.playbackRate };
  }
  return session?.resume || { position: 0, paused: false, rate: currentSpeed };
}
function beginPlayback(idx) {
  const identity = playbackIdentity(idx), previous = window.PlaybackSessions.current;
  const sameEpisode = previous && previous.identity.animeId === identity.animeId && previous.identity.episode === identity.episode;
  let resume = sameEpisode ? playbackResume(previous) : { position: 0, paused: false, rate: currentSpeed };
  if (!sameEpisode && window._resumeEp != null && Number(window._resumeEp) === Number(identity.episode)) {
    resume = { ...resume, position: window._resumePosition, percent: window._resumeProgress };
  }
  saveWatchHistory({ force: true });
  clearTimeout(historySaveTimer);
  historySaveTimer = null;
  const session = window.PlaybackSessions.begin(identity);
  session.resume = resume;
  const video = document.getElementById('videoPlayer');
  video.pause();
  video.removeAttribute('src');
  video.load();
  currentEp = idx;
  updateAnimeAgentContext();
  return session;
}
async function switchSource(idx) {
  if (idx < 0 || idx >= allSources.length) return;
  const source = allSources[idx], session = beginPlayback(currentEp);
  currentSourceIdx = idx;
  currentType = source.type;
  currentSourceJ = source.j;
  episodeJMap[currentEp] = source.j;
  renderSources();
  await setupVideo(source, session);
}
async function playEp(idx) {
  showToast('请在 Android / Windows 客户端选择播放源观看');
}

// Load franchise data (seasons, movies, OVAs)
let _franchiseCache = [];              // cached for switchFranchise lookup
let _franchiseBaseTitle = '';         // extracted base title, stable across switches
let _franchiseHighlightIdx = 1;       // which entry gets the "current" highlight

// Fetch franchise entries with a single search query
async function _fetchFranchise(msg) {
  try {
    const url = '/api/oi/franchise?msg=' + encodeURIComponent(msg);
    const r = await fetchWithTimeout(url, {}, 10000);
    if (!r.ok) return [];
    const data = await r.json();
    return data.entries || [];
  } catch (e) { return []; }
}

async function loadFranchise() {
  const revision = detailsRevision;
  try {
    // Derive the best search query for franchise lookup.
    // extractBaseTitle strips season markers but NOT subtitles like "怕寂寞的龙",
    // so we also try shorter variants if the initial search returns too few results.
    let searchTitle = _franchiseBaseTitle || extractBaseTitle(currentMsg);
    if (!searchTitle || searchTitle.length < 2) return;

    // ===== Primary search =====
    let entriesAll = await _fetchFranchise(searchTitle);
    if (revision !== detailsRevision) return;

    // ===== Fallback: if only 1 or 0 results, try broader queries =====
    if (entriesAll.length <= 1 && searchTitle.length > 4) {
      const backupQueries = [];

      // Strategy A: drop the last space-separated word (subtitle / descriptor)
      const parts = searchTitle.split(/\s+/);
      if (parts.length >= 2) {
        const shorter = parts.slice(0, -1).join(' ');
        if (shorter.length >= 4) backupQueries.push(shorter);
        // Even shorter: try just the first word (often the core title)
        if (parts.length >= 3 && parts[0].length >= 4) {
          backupQueries.push(parts[0]);
        }
      }

      // Strategy B: first 6-8 Chinese characters of the longest CJK run
      const cnRuns = searchTitle.match(/[\u4e00-\u9fff]{6,}/g);
      if (cnRuns) {
        for (const run of cnRuns) {
          const short = run.slice(0, 8);
          if (!backupQueries.includes(short) && short.length >= 6) {
            backupQueries.push(short);
          }
        }
      }

      for (const q of backupQueries) {
        const fb = await _fetchFranchise(q);
        if (revision !== detailsRevision) return;
        if (fb.length > entriesAll.length) {
          entriesAll = fb;
          searchTitle = q; // use the effective query for filtering & future calls
          break;
        }
      }
    }

    // Remember the effective search query so subsequent calls skip the fallback
    _franchiseBaseTitle = searchTitle;

    if (entriesAll.length === 0) return;

    // Filter: only keep same-franchise entries, using the original searchTitle as reference
    const entries = entriesAll.filter(e => {
      return isSameFranchise(searchTitle, e.title);
    });
    if (entries.length === 0) return;

    _franchiseCache = entries; // save for switchFranchise lookup

    const bar = document.getElementById('franchiseBar');
    const list = document.getElementById('franchiseList');
    bar.classList.add('open');
    const badgeClass = { 'TV': 'tv', '剧场版': 'movie', 'OVA': 'ova', '特别篇': 'special' };

    // Highlight by title (most reliable) with index as fallback
    // After a fallback search the indices shift, but currentMsg always holds the real title
    const byTitle = entries.find(e => e.title === currentMsg);
    const highlightIdx = byTitle ? byTitle.index : _franchiseHighlightIdx;

    list.innerHTML = entries.map(e => {
      const isCurrent = e.index === highlightIdx;
      return '<div class="franchise-item' + (isCurrent ? ' current' : '') + '" onclick="switchFranchise(' + e.index + ')" title="' + escapeHtml(e.title) + '">'
        + (e.image ? '<img src="' + escapeHtml(window.SiteUtils.safeImageUrl(e.image)) + '" alt="" onerror="this.style.display=\'none\'">' : '')
        + '<div class="fi-info">'
        + '<div class="fi-title">' + escapeHtml(e.title) + '</div>'
        + '<div class="fi-meta">' + escapeHtml(e.year || '') + (e.ji ? ' · ' + escapeHtml(e.ji) : '') + '</div>'
        + '<span class="fi-badge ' + (badgeClass[e.type] || 'tv') + '">' + e.type + '</span>'
        + '</div></div>';
    }).join('');
  } catch (e) {}
}

// Switch to a different season/movie in the franchise
async function switchFranchise(idx) {
  saveWatchHistory({ force: true });
  window.PlaybackSessions.dispose();
  document.getElementById('videoPlayer').pause();
  const nIdx = parseInt(idx) || 1;
  const entry = _franchiseCache.find(e => e.index === nIdx);

  if (entry) {
    currentMsg = entry.title;       // exact OIAPI title → precise details lookup
    currentN = String(entry.index); // correct OIAPI index
  } else {
    currentN = String(idx);
  }

  // Pin the highlight index BEFORE loadDetails (which may overwrite currentN via resolved_n)
  _franchiseHighlightIdx = nIdx;

  document.getElementById('info').innerHTML = '<div style="padding:20px;color:#8b949e;">加载中...</div>';
  document.getElementById('franchiseList').innerHTML = '';

  const revision = detailsRevision + 1;
  await loadDetails(); // may change currentN — but we don't rely on it for highlighting

  if (revision !== detailsRevision) return;
  // Refresh franchise sidebar (uses _franchiseHighlightIdx for correct "current" badge)
  loadFranchise();
  // Scroll to top
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function setupVideo(data, session, attempt = {}) {
  if (!session?.active()) return;
  const video = document.getElementById('videoPlayer');
  const resume = attempt.resume || playbackResume(session);
  saveWatchHistory({ force: true });
  const media = window.PlaybackSessions.media(session);
  session.resume = resume;
  video.pause();
  video.removeAttribute('src');
  video.load();
  const direct = data.play_url || '';
  const useProxy = Boolean(attempt.useProxy || !direct);
  const url = useProxy ? (data.proxy_url ? withVideoCacheBust(data.proxy_url) : '') : direct;
  if (!url) { hideLoading(); showError('视频源地址为空，请尝试其他来源'); return; }
  showLoading('正在加载视频流...', '', 80);
  let handlingFailure = false, failureRevision = 0;
  let playbackWanted = !resume.paused;
  const sameUrl = (left, right) => String(left || '').split('#')[0] === String(right || '').split('#')[0];
  const fail = async (reason, network = false, automatic = false) => {
    if (!media.active() || handlingFailure || (automatic && !playbackWanted)) return;
    handlingFailure = true;
    const revision = ++failureRevision;
    cancelTimeout();
    stopBufferProgress();
    if (network && !session.refreshed) {
      session.refreshed = true;
      const fresh = await tryPlayJ(currentSourceJ || session.identity.episode, currentType, media);
      if (!media.active() || revision !== failureRevision || (automatic && !playbackWanted)) return;
      if (fresh?.play_url && !sameUrl(fresh.play_url, direct)) {
        const source = { ...data, ...fresh };
        allSources[currentSourceIdx] = source;
        renderSources();
        await setupVideo(source, session, { resume: playbackResume(session) });
        return;
      }
    }
    const next = findPlayableSourceIndex(video, currentSourceIdx + 1);
    if (next >= 0 && !sameUrl(allSources[next]?.play_url, direct)) {
      await switchSource(next);
      return;
    }
    if (network && !useProxy && data.proxy_url) {
      await setupVideo(data, session, { resume: playbackResume(session), useProxy: true });
      return;
    }
    if (!media.active()) return;
    hideLoading();
    showError('视频加载失败：' + escapeHtml(reason) + '。请重试或选择其他来源');
  };
  // One startup budget spans manifest, level and first-fragment requests.
  let cancelTimeout = () => {};
  const armStartupTimeout = () => {
    cancelTimeout();
    cancelTimeout = media.timer(() => { void fail('视频流加载超时', true, true); }, 60000);
  };
  if (playbackWanted) armStartupTimeout();
  let hasStarted = false, bufferingSince = null, seekGraceUntil = 0, seekPending = false;
  let progressPosition = video.currentTime, progressAt = performance.now();
  const resetProgress = (now = performance.now()) => {
    progressPosition = video.currentTime;
    progressAt = now;
    bufferingSince = null;
  };
  const atEnd = () => video.ended || (!seekPending && !video.seeking && Number.isFinite(video.duration) && video.duration > 0 &&
    video.currentTime >= video.duration - 0.5);
  media.interval(() => {
    const now = performance.now();
    if (!hasStarted || !playbackWanted || video.paused || atEnd()) {
      resetProgress(now);
      return;
    }
    if (now < seekGraceUntil) {
      // A seek changes currentTime before data arrives. Update the baseline,
      // but keep the deadline measured from seeking rather than seeked.
      progressPosition = video.currentTime;
      return;
    }
    // Downloaded bytes and readiness events do not prove that playback advances.
    // Accumulate small time changes so slow playback rates still count as progress.
    if (!seekPending && !video.seeking && Number.isFinite(video.currentTime) && video.currentTime - progressPosition >= 0.5) {
      progressPosition = video.currentTime;
      progressAt = now;
      if (video.readyState >= 3) {
        bufferingSince = null;
        if (handlingFailure) { failureRevision++; handlingFailure = false; }
      }
    }
    if (handlingFailure) return;
    if (video.readyState < 3 || now - progressAt >= 2000) bufferingSince ??= now;
    if (now - progressAt >= 20000 || (bufferingSince != null && now - bufferingSince >= 45000)) {
      void fail('视频源持续缓冲，请求恢复', true, true);
    }
  }, 1000);
  const stopBufferProgress = media.interval(() => {
    if (video.buffered.length && video.duration > 0) {
      const percent = Math.round(video.buffered.end(video.buffered.length - 1) / video.duration * 100);
      showLoading('正在缓冲视频...', '已缓冲 ' + percent + '%', 80 + Math.min(percent, 100) * 0.2);
    }
  }, 500);
  const ready = () => {
    if (video.error || video.readyState < 3) return;
    if (!hasStarted) resetProgress();
    hasStarted = true;
    cancelTimeout(); stopBufferProgress(); clearError(); hideLoading();
  };
  media.listen(video, 'canplay', ready);
  media.listen(video, 'play', () => {
    playbackWanted = true;
    resetProgress();
    if (!hasStarted) armStartupTimeout();
  });
  media.listen(video, 'playing', () => { session.wasPlaying = true; ready(); });
  media.listen(video, 'waiting', () => {
    if (hasStarted && playbackWanted && !video.paused && !video.seeking && !atEnd()) {
      bufferingSince ??= performance.now();
    }
  });
  media.listen(video, 'pause', () => {
    if (!video.error) {
      session.wasPlaying = false;
      playbackWanted = false;
      failureRevision++; handlingFailure = false;
      cancelTimeout();
      resetProgress();
    }
  });
  media.listen(video, 'seeking', () => {
    failureRevision++; handlingFailure = false;
    const now = performance.now();
    seekPending = true;
    resetProgress(now);
    seekGraceUntil = now + 8000;
  });
  media.listen(video, 'seeked', () => {
    seekPending = false;
    resetProgress();
  });
  const metadata = media.listen(video, 'loadedmetadata', () => {
    if (video.readyState < 1 || !Number.isFinite(video.duration) || video.duration <= 0) return;
    metadata();
    const target = resume.position != null ? resume.position : (Number(resume.percent) || 0) / 100 * video.duration;
    video.currentTime = Math.max(0, Math.min(target, Math.max(0, video.duration - 0.1)));
    video.playbackRate = resume.rate || currentSpeed;
    window.PlaybackSessions.playing = session.identity;
    delete window._resumeEp; delete window._resumeProgress;
    delete window._resumePosition; delete window._resumeExactEpisode;
    data._realHeight = video.videoHeight || data._realHeight;
    renderQualitySelector(); updateAnimeAgentContext();
  });
  const play = () => { if (playbackWanted && media.active()) video.play().catch(() => {}); };
  media.listen(video, 'error', () => { void fail('错误码 ' + (video.error?.code || '未知'), video.error?.code === 2 || video.error?.code === 4); });
  if (isLikelyHevcSource(data) && !browserReportsHevcSupport(video)) {
    await fail(hevcUnsupportedMessage());
    return;
  }
  const isHls = /\.m3u8(?:$|[?#])/i.test(direct || url) || data.video_type === 'm3u8';
  try {
    if (isHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 30, manifestLoadingTimeOut: 15000,
        levelLoadingTimeOut: 15000, fragLoadingTimeOut: 20000 });
      window.hlsInstance = hls;
      media.add(() => {
        try { hls.destroy(); } finally { if (window.hlsInstance === hls) window.hlsInstance = null; }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { if (media.active()) { renderQualitySelector(); play(); } });
      hls.on(Hls.Events.LEVEL_SWITCHED, () => { if (media.active()) renderQualitySelector(); });
      hls.on(Hls.Events.ERROR, (_event, error) => {
        if (error.fatal && media.active()) void fail(error.details || 'HLS 加载失败', error.type === Hls.ErrorTypes.NETWORK_ERROR);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      video.src = url;
      video.load();
      play();
    }
  } catch (error) { await fail(error.message || '播放器初始化失败', true); }
}
async function autoTestLines() {
  // Refresh the same episode through the same ownership and resume pipeline.
  await playEp(currentEp);
}
window.addEventListener('pagehide', () => window.PlaybackSessions.dispose());

function clearError() {
  document.getElementById('errorContainer').innerHTML = '';
}

function showError(msg, raw) {
  document.getElementById('errorContainer').innerHTML =
    '<div class="error-msg" style="max-width:1100px;margin:20px auto;padding:0 20px;">' + (raw ? msg : escapeHtml(msg)) + '</div>';
}


init();
