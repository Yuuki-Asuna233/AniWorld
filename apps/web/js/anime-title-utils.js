// ===== Franchise Filtering Helpers =====
function extractBaseTitle(title) {
  if (!title) return '';
  return title
    .replace(/\s*第[一二三四五六七八九十\d]+[季期部]/g, '')
    .replace(/\s*Season\s*\d+/gi, '')
    .replace(/\s*Part\s*\d+/gi, '')
    .replace(/\s*Final\s*Season/gi, '')
    .replace(/\s*[～~]\s*.*/g, '')
    .replace(/[:：].*/g, '')
    .trim();
}

function isSameFranchise(titleA, titleB) {
  const baseA = extractBaseTitle(titleA).toLowerCase();
  const baseB = extractBaseTitle(titleB).toLowerCase();
  if (!baseA || !baseB) return false;
  if (baseA === baseB) return true;
  if (baseA.length >= 4 && baseB.includes(baseA)) return true;
  if (baseB.length >= 4 && baseA.includes(baseB)) return true;

  // Chinese series detection: if both titles are Chinese and share
  // a common prefix (>=4 chars), treat as same franchise.
  // e.g. "青春猪头少年不会梦到兔女郎学姐" + "青春猪头少年不会梦到怀梦美少女"
  const ca = (titleA || '').match(/[\u4e00-\u9fff]+/g)?.join('') || '';
  const cb = (titleB || '').match(/[\u4e00-\u9fff]+/g)?.join('') || '';
  if (ca.length >= 4 && cb.length >= 4) {
    let commonLen = 0;
    for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
      if (ca[i] === cb[i]) commonLen++;
      else break;
    }
    if (commonLen >= 4) return true;
  }

  return false;
}

// Client-side Chinese title fallback
function getChineseTitle(romaji, english, native, fallback) {
  if (typeof ANIME_TITLES !== 'undefined' && ANIME_TITLES.findChinese) {
    const result = ANIME_TITLES.findChinese(romaji, english, native, fallback);
    if (result) return result;
  }
  return fallback || romaji || english || native || '未知';
}
