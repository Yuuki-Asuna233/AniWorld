const { OI_BASE } = require('./oi-helpers');
const { nextWeeklyClock } = require('../utils/date');

const checkedAt = new Map();
const CHECK_TTL = 30 * 60 * 1000;
const MAX_PER_RUN = 10;
const WEEK_SEC = 7 * 24 * 60 * 60;

const DAY_CHARS = '\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u65e5\u5929';
const FINISHED_RE = /(?<!未)(?<!没)(?<!没有)(?<!沒有)完[结結]|全集|\d+\s*全|全\s*\d+\s*集/u;
const AIRING_RE = new RegExp(`\\d+\\s*\\||(?:\u5468|\u661f\u671f)[${DAY_CHARS}]\\s*\\d{1,2}`);

function extractEpisodeCount(detail) {
  const playlistCount = Array.isArray(detail?.playlist) ? detail.playlist.length : 0;
  const ji = String(detail?.ji || '').trim();
  const patterns = [
    /(\d+)\s*\|/,
    new RegExp('(?:\u7b2c|\u66f4\u65b0\u81f3|\u66f4\u81f3)\\s*(\\d+)\\s*(?:\u96c6|\u8bdd|\u8a71)?'),
    new RegExp('(\\d+)\\s*(?:\u96c6|\u8bdd|\u8a71)\\s*(?:\u66f4|\u66f4\u65b0|\u5df2\u66f4)?'),
    new RegExp('(\\d+)\\s*\u5168'),
    new RegExp('\u5168\\s*(\\d+)\\s*\u96c6'),
    new RegExp('\u5171\\s*(\\d+)\\s*\u96c6')
  ];

  let jiCount = 0;
  for (const pattern of patterns) {
    const match = ji.match(pattern);
    if (match) {
      jiCount = parseInt(match[1], 10) || 0;
      break;
    }
  }

  return Math.max(playlistCount, jiCount);
}

function getOiAiringState(detail) {
  const ji = String(detail?.ji || '').trim();
  const currentEpisode = extractEpisodeCount(detail);
  const ended = FINISHED_RE.test(ji);
  const ongoing = AIRING_RE.test(ji) || /正在更新|连载中|連載中|每周|每週/.test(ji);
  const finished = ended && !ongoing;
  const airing = ongoing || (!ended && /更新至|更新到|连载|連載/.test(ji));
  return { finished, airing, currentEpisode, nextAiringAt: parseNextAiringAt(ji) };
}

function parseNextAiringAt(ji) {
  const match = String(ji || '').match(new RegExp(`(?:\u5468|\u661f\u671f)?([${DAY_CHARS}])\\s*(\\d{1,2})[:\uff1a](\\d{2})`));
  if (!match) return 0;

  const dayMap = {
    '\u65e5': 0,
    '\u5929': 0,
    '\u4e00': 1,
    '\u4e8c': 2,
    '\u4e09': 3,
    '\u56db': 4,
    '\u4e94': 5,
    '\u516d': 6
  };
  const targetDay = dayMap[match[1]];
  let hour = parseInt(match[2], 10);
  const minute = parseInt(match[3], 10);
  if (targetDay === undefined || Number.isNaN(hour) || Number.isNaN(minute)) return 0;

  return nextWeeklyClock(targetDay, hour, minute);
}

async function fetchOiDetail(meta, httpFetch) {
  if (!meta?.oi_msg || !meta?.oi_index) return null;
  const url = `${OI_BASE}?msg=${encodeURIComponent(meta.oi_msg)}&n=${meta.oi_index}`;
  const r = await httpFetch(url, { timeout: 8000 });
  if (r.status === 200 && r.data?.code === 200 && r.data?.data) return r.data.data;
  return null;
}

function shouldCheck(meta, nowMs) {
  if (!meta?.anilist_id) return false;
  if (!meta.next_airing_episode && !meta.next_airing_at && meta.status !== 'RELEASING') return false;
  const key = String(meta.anilist_id);
  const last = checkedAt.get(key) || 0;
  if (nowMs - last < CHECK_TTL) return false;
  return true;
}

async function reconcileAiringWithOi(database, httpFetch, metas) {
  const nowMs = Date.now();
  const candidates = (metas || [])
    .filter(m => shouldCheck(m, nowMs))
    .slice(0, MAX_PER_RUN);
  if (candidates.length === 0) return { checked: 0, updated: 0 };

  let updated = 0;
  for (const meta of candidates) {
    checkedAt.set(String(meta.anilist_id), Date.now());
    try {
      const detail = await fetchOiDetail(meta, httpFetch);
      const oiState = getOiAiringState(detail);
      if (oiState.currentEpisode <= 0 && !oiState.finished) continue;

      const nextEpisode = Number(meta.next_airing_episode) || 0;
      const dbEpisodes = Number(meta.episodes) || 0;
      const state = {};

      if (oiState.finished) {
        state.episodes = Math.max(dbEpisodes, oiState.currentEpisode || 0);
        state.status = 'FINISHED';
        state.next_airing_episode = 0;
        state.next_airing_at = 0;
      } else if (oiState.airing && oiState.currentEpisode > 0) {
        // OI's count is the number of episodes released so far, not the
        // announced total. Never promote airing progress to a total count.
        // Clear stale totals that are already lower than AniList's next
        // episode (for example total=12 while episode 13 is scheduled).
        if (dbEpisodes > 0 && nextEpisode > dbEpisodes) state.episodes = 0;
        state.status = 'RELEASING';
        let nextAiringAt = Number(meta.next_airing_at) || 0;
        const nowSec = Math.floor(Date.now() / 1000);
        if (nextAiringAt > 0) {
          while (nextAiringAt <= nowSec) nextAiringAt += WEEK_SEC;
        } else if (oiState.nextAiringAt > 0) {
          nextAiringAt = oiState.nextAiringAt;
        }
        state.next_airing_episode = Math.max(nextEpisode, oiState.currentEpisode + 1);
        state.next_airing_at = nextAiringAt;
      } else {
        continue;
      }

      const result = database.updateAnimeAiringState(meta.anilist_id, state);
      if (result?.success) updated += 1;
    } catch (e) {
      // OIAPI is best-effort here. Keep the page responsive if a check fails.
    }
  }

  return { checked: candidates.length, updated };
}

module.exports = {
  extractEpisodeCount,
  getOiAiringState,
  reconcileAiringWithOi
};
