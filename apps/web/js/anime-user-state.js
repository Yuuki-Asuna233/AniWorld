// ==================== Auth & Follow System ====================
function getAnimeToken() { return window.SiteUtils.getAuthToken(); }

async function animeApi(method, url, body) {
  return window.SiteUtils.authJson(method, url, body);
}

async function checkFollowStatus(animeId) {
  try {
    const r = await animeApi('GET', '/api/user/favorites/check/' + encodeURIComponent(animeId));
    const btn = document.getElementById('followBtn');
    if (btn && r.favorited) {
      btn.className = 'follow-btn followed';
      btn.innerHTML = '<span class="follow-heart">♥</span> 已追番';
      updateAnimeAgentContext({ isFavorited: true });
    }
  } catch(e) {}
}

async function toggleFollow(animeId, animeTitle, animeImage) {
  const btn = document.getElementById('followBtn');
  if (!btn) return;

  const isFollowed = btn.classList.contains('followed');

  try {
    if (isFollowed) {
      const r = await animeApi('DELETE', '/api/user/favorites/' + encodeURIComponent(animeId));
      if (r.success) {
        btn.className = 'follow-btn not-followed';
        btn.innerHTML = '<span class="follow-heart">♡</span> 追番';
        updateAnimeAgentContext({ isFavorited: false });
        showToast('已取消追番');
      }
    } else {
      const r = await animeApi('POST', '/api/user/favorites', {
        anilist_id: currentAnimeAnilistId,
        anime_id: animeId,
        anime_title: animeTitle,
        anime_image: animeImage,
        anime_msg: currentMsg,
        anime_n: parseInt(currentN) || 1,
        oi_index: parseInt(currentN) || 1
      });
      if (r.success) {
        btn.className = 'follow-btn followed';
        btn.innerHTML = '<span class="follow-heart">♥</span> 已追番';
        updateAnimeAgentContext({ isFavorited: true });
        showToast('✅ 追番成功！');
      }
    }
  } catch(e) {
    showToast('操作失败，请重试');
  }
}

// ==================== Watch History ====================
let historySaveTimer = null;
let lastHistorySave = { animeId: '', ep: '', progress: 0 };

function getCurrentAnimeId() {
  if (currentAnimeAnilistId > 0) return 'anilist_' + currentAnimeAnilistId;
  return 'oiapi_' + currentMsg.replace(/\//g, '_') + '_' + currentN;
}

let historyWriteQueue = Promise.resolve();
function saveWatchHistory({ force = false } = {}) {
  const identity = window.PlaybackSessions?.playing;
  const token = getAnimeToken();
  if (!identity || !token || identity.token !== token) return;

  const video = document.getElementById('videoPlayer');
  if (!video) return;

  const animeId = identity.animeId;
  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;

  const currentTime = video.currentTime;
  const progress = duration > 0 ? Math.round((currentTime / duration) * 100) : 0;
  // Always store numeric episode number (1-based) for reliable resume matching
  const currentEpNum = identity.episode;
  const episodeTitle = '第' + currentEpNum + '集';

  // Debounce saves: only save when progress changes significantly (>5%) or episode changes
  if (!force && animeId === lastHistorySave.animeId &&
      currentEpNum === lastHistorySave.ep &&
      Math.abs(progress - lastHistorySave.progress) < 5) return;


  const record = {
    anilist_id: identity.anilistId,
    anime_id: animeId,
    anime_title: identity.title,
    anime_image: identity.image,
    anime_msg: identity.msg,
    anime_n: identity.n,
    episode_number: currentEpNum,
    episode_title: episodeTitle,
    progress: progress,
    position_seconds: currentTime,
    duration_seconds: duration,
    video_url: video.src || ''
  };
  // Preserve snapshot order; a slow old save cannot overwrite the latest episode.
  historyWriteQueue = historyWriteQueue.catch(() => {}).then(() => {
    if (getAnimeToken() !== token) return {};
    return animeApi('POST', '/api/user/history', record);
  }).then(result => {
    if (result.success && getAnimeToken() === token && window.PlaybackSessions?.playing === identity) {
      lastHistorySave = { animeId, ep: currentEpNum, progress };
    }
  }).catch(() => {});
}

function startHistoryTracking() {
  const video = document.getElementById('videoPlayer');
  if (!video || video.dataset.historyTracking === '1') return;
  video.dataset.historyTracking = '1';

  // Save history periodically (every 15 seconds while playing)
  video.addEventListener('timeupdate', () => {
    updateAnimeAgentContext();
    if (video.paused) return;
    if (historySaveTimer) return;
    historySaveTimer = setTimeout(() => {
      saveWatchHistory();
      historySaveTimer = null;
    }, 15000);
  });

  // Save on pause
  video.addEventListener('pause', () => {
    saveWatchHistory({ force: true });
  });

  // Save on episode change (when playing new episode)
  video.addEventListener('ended', () => {
    saveWatchHistory({ force: true });
  });
}

// Resume from history if ?ep= and ?progress= params present
// 只有历史记录页会同时传 ep + progress，其他页面误传 ep 时不应触发恢复
async function resumeFromHistory() {
  const token = getAnimeToken();
  if (!token) return;

  const params = new URLSearchParams(location.search);
  const epParam = params.get('ep');
  const progressParam = params.get('progress');

  const positionParam = params.get('position');
  if (!epParam || (progressParam === null && positionParam === null)) return; // 只有同时有 ep 和 progress 才认为是历史记录恢复

  // Store resume params for when video loads
  window._resumeEp = epParam;
  window._resumeExactEpisode = positionParam !== null;
  window._resumePosition = positionParam === null ? null : Math.max(0, Number(positionParam) || 0);
  window._resumeProgress = parseFloat(progressParam) || 0;
}

function showToast(msg) {
  window.SiteUtils.toast(msg);
}

// Install once on the existing element, including native-control playback.
startHistoryTracking();
window.addEventListener('pagehide', () => saveWatchHistory({ force: true }));
resumeFromHistory();
