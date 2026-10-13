// Chinese text & title utilities

function containsChinese(str) {
  if (!str) return false;
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(str);
}

function containsJapaneseKana(text) {
  return /[\u3040-\u309f\u30a0-\u30ff]/.test(text || '');
}

function isPureJapaneseOrRomaji(str) {
  if (!str) return false;
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(str)) return true;
  if (!/[\u4e00-\u9fff\u3400-\u4dbf]/.test(str)) return true;
  return false;
}

function findChineseInSynonyms(synonyms) {
  if (!synonyms || !Array.isArray(synonyms)) return null;
  for (const syn of synonyms) {
    if (containsChinese(syn) && !containsJapaneseKana(syn)) return syn;
  }
  return null;
}

function toChineseNum(numStr) {
  const n = parseInt(numStr);
  const cn = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
    '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
    '二十一', '二十二', '二十三', '二十四'];
  if (n >= 1 && n <= 24) return cn[n];
  return numStr;
}

function chineseNumToArabic(cn) {
  const map = {
    '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
    '十一': 11, '十二': 12, '十三': 13, '十四': 14, '十五': 15, '十六': 16, '十七': 17,
    '十八': 18, '十九': 19, '二十': 20, '二十一': 21, '二十二': 22, '二十三': 23, '二十四': 24
  };
  if (map[cn] !== undefined) return map[cn];
  if (cn.startsWith('十') && cn.length === 2) return 10 + (map[cn[1]] || 0);
  return parseInt(cn) || 0;
}

function cleanOiTitle(name) {
  if (!name) return name;
  const fixes = [
    { from: /女神宿舍的宿管君\s*第二季/g, to: '女神宿舍的宿管君' }
  ];
  for (const f of fixes) {
    if (f.from.test(name)) return name.replace(f.from, f.to);
  }
  return name;
}

function filterChineseResults(results, allowUnmapped = false) {
  if (!results || !Array.isArray(results)) return [];
  return results.filter(r => {
    // OIAPI 搜索结果无条件显示
    if (r.source === 'oiapi') return true;
    // 标题含中文即显示（不再检查假名、nativeTitle 重复等限制）
    if (r.title && containsChinese(r.title)) return true;
    // allowUnmapped 模式：正在播出的也显示（日历页用）
    if (allowUnmapped && r.status === 'RELEASING') return true;
    return false;
  });
}

function extractSeasonFromTitle(romaji, english, native) {
  const text = (romaji || '') + ' ' + (english || '') + ' ' + (native || '');
  const m = text.match(/(\d+)(?:st|nd|rd|th)\s*Season/i);
  if (m) return '第' + toChineseNum(m[1]) + '季';
  const m2 = text.match(/Season\s*(\d+)/i);
  if (m2) return '第' + toChineseNum(m2[1]) + '季';
  const m3 = text.match(/(\d+)期/);
  if (m3) return '第' + toChineseNum(m3[1]) + '期';
  if (/Final\s*Season/i.test(text)) return '最终季';
  const m4 = text.match(/Part\s*(\d+)/i);
  if (m4) return '第' + toChineseNum(m4[1]) + '部分';
  const m5 = text.match(/第\s*([一二三四五六七八九十\d]+)\s*(季|期|部分?)/);
  if (m5) return '第' + m5[1] + m5[2];
  return '';
}

function extractBaseTitle(title) {
  if (!title) return '';
  return title
    .replace(/\s*第\s*[一二三四五六七八九十\d]+\s*[季期部].*$/, '')
    .replace(/\s+[一二三四五六七八九十\d]+\s*[季期部].*$/, '')
    .replace(/\s+最终[季期].*$/, '')
    .replace(/\s+Final\s*Season.*$/i, '')
    .replace(/\s+Part\s*\d+.*$/i, '')
    .replace(/[\s(（]*第?\s*[一二三四五六七八九十\d]+\s*[季期部][\s)）]*.*$/, '')
    .trim();
}

function cleanTitle(title) {
  if (!title) return title;
  let t = String(title).trim();
  t = t.replace(/[。！？、~…·•★☆■□○●◎◆◇◈◉◊]+$/, '');
  const seasonPattern = /[\s]*(第[一二三四五六七八九十\d]+(?:季|期|部分?)|Final\s*Season|Part\s*\d+)[\s]*/gi;
  const seasonMatches = t.match(seasonPattern);
  if (seasonMatches && seasonMatches.length >= 2) {
    const uniqueSeasons = [...new Set(seasonMatches.map(s => s.trim().toLowerCase()))];
    if (uniqueSeasons.length >= 2) {
      const firstSeason = seasonMatches[0];
      t = t.replace(new RegExp(seasonMatches.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s]*[\\S\\s]*?'), 'i'), firstSeason).trim();
    }
  }
  t = t.replace(/\s{2,}/g, ' ').trim();
  return t;
}

function normalizeSeasonNumber(name) {
  return name
    .replace(/:/g, '：')
    .replace(/第(\d+)季/g, (match, num) => {
      const cn = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
      const n = parseInt(num);
      if (n <= 10) return '第' + cn[n] + '季';
      if (n === 11) return '第十一季';
      if (n === 12) return '第十二季';
      return match;
    });
}

module.exports = {
  containsChinese,
  containsJapaneseKana,
  isPureJapaneseOrRomaji,
  findChineseInSynonyms,
  toChineseNum,
  chineseNumToArabic,
  cleanOiTitle,
  filterChineseResults,
  extractSeasonFromTitle,
  extractBaseTitle,
  cleanTitle,
  normalizeSeasonNumber
};
