#!/usr/bin/env node
/**
 * sync-db.js — 独立的番剧元数据同步脚本
 *
 * 用法：
 *   node sync-db.js              : 同步当季 + 下一季（自动内联 OIAPI 获取中文名并同时写入）
 *   node sync-db.js --clear      : 清空番剧目录后同步近期季度；只在明确要重建目录时使用
 *   node sync-db.js --full --start-year 2010 --end-year 2026 : 首次推荐，覆盖指定年份的四季；每季最多250条候选
 *   node sync-db.js --oi-only    : 只解析缺失的 oi_msg（不重新拉 AniList 数据）
 *   node sync-db.js --anilist-only : 只同步 AniList 数据，不解析 oi_msg
 *   node sync-db.js --no-inline-oi : 跳过内联 OIAPI 解析（仅存 AniList 元数据）
 *   node sync-db.js --batch        : 旧分批模式，范围固定为2010→2026春季；不覆盖之后的季度
 *   node sync-db.js --anilist-only --start-year 2014 --end-year 2017  : 指定年份范围
 *
 * 设计原则：
 *   - 与 server.js 完全解耦，不依赖 Express
 *   - OIAPI 请求使用短超时（2 秒），快速失败不卡住
 *   - 启动前先检测 OIAPI 是否可达，不可达自动跳过 oi_msg 解析
 *   - 支持 Ctrl+C 安全退出并保存进度
 */

const https = require('https');
const http = require('http');
const { HttpsProxyAgent } = require('https-proxy-agent');
const path = require('path');
const { loadEnvFile } = require('../../apps/server/src/utils/env');
loadEnvFile(path.resolve(__dirname, '..', '..', '.env'));

const database = require('../../apps/server/database');
const { findChinese, findAlias } = require('../../apps/server/anime-titles');

// ==================== Constants ====================
const OI_BASE = 'https://oiapi.net/api/Anime';
const OI_TIMEOUT = 8000;         // OIAPI 请求超时（毫秒）— 国内需代理，延迟较高
const OI_BATCH_DELAY = 500;      // OIAPI 请求间隔
const ANILIST_PAGE_DELAY = 500;  // AniList 分页间隔
const ANILIST_SEASON_DELAY = 3000;  // 季度间延迟（防限流）
const PROXY_URL = '';  // 不使用代理
const REQUEST_TIMEOUT = 15000;   // 默认 HTTP 超时

const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
const SYNC_START_YEAR = 2010;

// ==================== State ====================
let isCancelled = false;
let totalSynced = 0;
let totalOiResolved = 0;
let IS_VERBOSE = false;

// ---- In-memory caches (session only) ----
const OI_SEARCH_CACHE = {};  // OIAPI search term -> result

function getOiSearchCache(term) {
  const now = Date.now();
  const entry = OI_SEARCH_CACHE[term];
  if (entry && now - entry.ts < 30 * 60 * 1000) return entry.data;
  return undefined;
}

function setOiSearchCache(term, data) {
  OI_SEARCH_CACHE[term] = { ts: Date.now(), data };
}

// ==================== HTTP Fetch ====================
function httpFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https:');
    const lib = isHttps ? https : http;
    const timeout = opts.timeout || REQUEST_TIMEOUT;
    const method = (opts.method || 'GET').toUpperCase();
    const defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      ...opts.headers
    };

    const agent = (PROXY_URL && isHttps)
      ? new HttpsProxyAgent(PROXY_URL)
      : undefined;

    const handleResponse = (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    };

    let req;
    if (method === 'GET' && !opts.body) {
      req = lib.get(url, { headers: defaultHeaders, timeout, agent }, handleResponse);
    } else {
      const parsed = new URL(url);
      req = lib.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: defaultHeaders,
        timeout,
        agent
      }, handleResponse);
    }

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ==================== AniList Query ====================
const ANILIST_BASE = process.env.ANILIST_BASE || 'https://graphql.anilist.co';

async function anilistQuery(query, variables = {}) {
  const r = await httpFetch(ANILIST_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Origin': 'https://anilist.co',
      'Referer': 'https://anilist.co/'
    },
    body: JSON.stringify({ query, variables })
  });
  if (r.status === 200 && r.data?.data) return r.data.data;
  return null;
}

// ==================== Season Helpers ====================
function getCurrentSeasonInfo() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  let current, next;
  if (month <= 3)      { current = 'WINTER'; next = 'SPRING'; }
  else if (month <= 6) { current = 'SPRING'; next = 'SUMMER'; }
  else if (month <= 9) { current = 'SUMMER'; next = 'FALL'; }
  else                 { current = 'FALL'; next = 'WINTER'; }
  const nextYear = (current === 'FALL' && next === 'WINTER') ? year + 1 : year;
  return [
    { season: current, seasonYear: year },
    { season: next, seasonYear: nextYear }
  ];
}

function getSeasonList(fullSync, startYear, endYear, endSeasonIdx) {
  if (!fullSync) return getCurrentSeasonInfo();

  const seasons = [];
  const [curr, next] = getCurrentSeasonInfo();

  const sYear = startYear || SYNC_START_YEAR;

  let eYear, lastSeasonIdx;
  if (endYear) {
    // User-specified end: if endSeasonIdx given use it, otherwise include all 4 seasons
    eYear = endYear;
    lastSeasonIdx = (endSeasonIdx !== undefined) ? endSeasonIdx : 3;
  } else {
    // Default: up to current next season boundary
    eYear = Math.max(next.seasonYear, new Date().getFullYear());
    lastSeasonIdx = SEASONS.indexOf(next.season);
  }

  for (let year = sYear; year <= eYear; year++) {
    for (let i = 0; i < SEASONS.length; i++) {
      if (year === eYear && i > lastSeasonIdx) break;
      seasons.push({ season: SEASONS[i], seasonYear: year });
    }
  }
  return seasons;
}

// ==================== Number Utilities ====================
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
    '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,
    '十一':11,'十二':12,'十三':13,'十四':14,'十五':15,'十六':16,'十七':17,
    '十八':18,'十九':19,'二十':20,'二十一':21,'二十二':22,'二十三':23,'二十四':24
  };
  if (map[cn] !== undefined) return map[cn];
  if (cn.startsWith('十') && cn.length === 2) return 10 + (map[cn[1]] || 0);
  return parseInt(cn) || 0;
}

// ==================== Title Helpers ====================
function containsChinese(str) {
  if (!str) return false;
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(str);
}

function containsJapaneseKana(text) {
  return /[\u3040-\u309f\u30a0-\u30ff]/.test(text || '');
}

function cleanTitle(title) {
  if (!title) return title;
  let t = String(title).trim();
  t = t.replace(/[。！？、~…·•★☆■□○●◎◆◇◈◉◊]+$/, '');
  return t;
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

function normalizeSeasonNumber(name) {
  return name
    .replace(/:/g, '：')
    .replace(/第(\d+)季/g, (match, num) => {
      const cn = ['零','一','二','三','四','五','六','七','八','九','十'];
      return '第' + cn[num] + '季';
    });
}

function extractKanjiChunks(text) {
  if (!text) return [];
  const chunks = text.split(/[^\u4e00-\u9fff\u3400-\u4dbf]+/g).filter(c => c.length >= 2);
  return [...new Set(chunks)].sort((a, b) => b.length - a.length);
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

// ==================== OIAPI Search ====================
function selectBestOiResult(list, searchTerm, preferredSeason, anilistYear = 0) {
  if (!list || list.length === 0) return 0;
  if (list.length === 1) return 0;

  function extractSeasonNum(str) {
    if (!str) return 0;
    const cnMatch = str.match(/第([一二三四五六七八九十]+)季/);
    if (cnMatch) return chineseNumToArabic(cnMatch[1]);
    const arMatch = str.match(/第(\d+)季/);
    if (arMatch) return parseInt(arMatch[1]);
    return 0;
  }

  const isMovieSearch = searchTerm && /剧场版|电影|无限城|总集篇|特别篇|OVA|OAD|SP|番外|外传|精选|合集/.test(searchTerm);
  const seasonMatch = searchTerm && searchTerm.match(/第[一二三四五六七八九十\d]+季|最终季|\d+期/);
  const seasonFromSearch = preferredSeason || (seasonMatch ? seasonMatch[0] : '');

  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < list.length; i++) {
    const n = (list[i].name || '').trim();
    const y = parseInt(list[i].year) || 0;
    let score = 0;

    if (!isMovieSearch) {
      if (/剧场版|电影|总集篇|特别篇|OVA|OAD|SP|番外|外传|精选|合集/.test(n)) score -= 100;
    } else {
      if (searchTerm && n.includes(searchTerm)) score += 40;
      if (/剧场版|电影/.test(n)) score += 20;
    }
    // Year proximity scoring — reward closeness to AniList year instead of arbitrary old/new bias
    if (anilistYear > 0 && y > 0) {
      const yearDiff = Math.abs(y - anilistYear);
      if (yearDiff === 0) score += 80;
      else if (yearDiff === 1) score += 50;
      else if (yearDiff <= 3) score += 20;
      else if (yearDiff <= 5) score += 0;
      else score -= 60;
    } else {
      // Fallback: mild preference for newer titles when AniList year unknown
      if (y > 0 && y < 2018) score -= 20;
      if (y >= 2024) score += 10;
    }
    if (searchTerm && n.includes(searchTerm)) score += 40;
    if (seasonFromSearch) {
      const sn = extractSeasonNum(n);
      const ss = extractSeasonNum(seasonFromSearch);
      if (sn === ss && sn !== 0) score += 100;
    }
    if (y > 0) score += Math.min(y - 2000, 30);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}

async function searchOiDynamic(terms, timeout = OI_TIMEOUT, anilistYear = 0, maxResults = 1) {
  const tried = new Set();
  const mappedTerms = [...terms];
  for (const t of terms) {
    if (t && /[\u4e00-\u9fff]/.test(t)) {
      const alias = findAlias(t);
      if (alias && !terms.includes(alias)) mappedTerms.push(alias);
    }
  }

  for (const t of mappedTerms) {
    if (!t || t.length < 2 || tried.has(t)) continue;
    const normalizedT = normalizeSeasonNumber(t);
    if (tried.has(normalizedT)) continue;

    const variants = [normalizedT];
    const noSeason = normalizedT.replace(/\s*(第[一二三四五六七八九十\d]+季|Season\s*\d+|Final\s*Season|\d+期).*/i, '').trim();
    if (noSeason !== normalizedT && noSeason.length >= 2 && !tried.has(noSeason)) {
      variants.push(noSeason);
    }
    const mainPart = normalizedT.split(/[：:–—\-～~【\[\(\)（）]/)[0].trim();
    if (mainPart && mainPart !== normalizedT && mainPart.length >= 2 && !tried.has(mainPart)) {
      variants.push(mainPart);
    }
    const kanjiChunks = extractKanjiChunks(t);
    for (const kc of kanjiChunks.slice(0, 2)) {
      if (kc.length >= 2 && !tried.has(kc)) variants.push(kc);
    }

    for (const v of variants) {
      if (tried.has(v)) continue;
      tried.add(v);

      const cached = getOiSearchCache(v);
      if (cached !== undefined) {
        if (cached) {
          if (maxResults > 1) return [cached];
          return cached;
        }
        continue;
      }

      try {
        const url = `${OI_BASE}?msg=${encodeURIComponent(v)}`;
        const r = await httpFetch(url, { timeout });
        if (r.status === 200 && r.data?.code === 200) {
          const list = Array.isArray(r.data.data) ? r.data.data : [];
          if (list.length > 0) {
            const seasonMatch = t.match(/第[一二三四五六七八九十\d]+季|最终季|\d+期/);
            const bestIdx = selectBestOiResult(list, v, seasonMatch ? seasonMatch[0] : '', anilistYear);
            const bestItem = list[bestIdx];

            // Build results: best first, then rest sorted by year proximity for fallback
            const allResults = [{
              title: cleanOiTitle(bestItem.name || t),
              image: bestItem.image || '',
              year: bestItem.year || '',
              oiMsg: cleanOiTitle(bestItem.name || t),
              oiIndex: bestIdx + 1
            }];

            // Append remaining results sorted by closeness to anilistYear
            const rest = list
              .map((item, idx) => ({ item, idx }))
              .filter(x => x.idx !== bestIdx)
              .sort((a, b) => {
                const ya = parseInt(a.item.year) || 0;
                const yb = parseInt(b.item.year) || 0;
                if (anilistYear > 0) {
                  return Math.abs(ya - anilistYear) - Math.abs(yb - anilistYear);
                }
                return yb - ya; // newer first as fallback when year unknown
              });

            for (const { item, idx } of rest) {
              allResults.push({
                title: cleanOiTitle(item.name || t),
                image: item.image || '',
                year: item.year || '',
                oiMsg: cleanOiTitle(item.name || t),
                oiIndex: idx + 1
              });
            }

            const bestResult = allResults[0];
            setOiSearchCache(v, bestResult);

            if (maxResults > 1) return allResults.slice(0, maxResults);
            return bestResult;
          }
        }
        setOiSearchCache(v, null);
      } catch (e) { /* timeout or network error — skip */ }
    }
  }
  return null;
}

async function searchOiWithSubstrings(term, timeout = OI_TIMEOUT, anilistYear = 0) {
  if (!term || term.length < 2) return null;
  let result = await searchOiDynamic([term], timeout, anilistYear);
  if (result) return result;
  // Try shorter prefixes
  for (let len = Math.min(term.length, 14); len >= 2; len--) {
    const sub = term.slice(0, len);
    if (sub === term) continue;
    result = await searchOiDynamic([sub], timeout, anilistYear);
    if (result) return result;
  }
  return null;
}

async function unifiedOiSearch(m, options = {}) {
  const timeout = options.timeout || OI_TIMEOUT;
  const seasonInfo = extractSeasonFromTitle(m.title?.romaji, m.title?.english, m.title?.native);
  const anilistYear = m.seasonYear || (m.startDate?.year ?? 0);

  // --- Anti-mismatch validators ---
  function extractSeasonNumber(title) {
    if (!title) return 0;
    const seasonStr = extractSeasonFromTitle(title, title, title);
    if (!seasonStr) {
      // Also check English patterns: "Season 2", "2nd Season"
      const em = title.match(/Season\s*(\d+)/i) || title.match(/(\d+)(?:st|nd|rd|th)\s*Season/i);
      if (em) return parseInt(em[1]);
      return 0;
    }
    const m = seasonStr.match(/第([一二三四五六七八九十\d]+)/);
    if (m) return chineseNumToArabic(m[1]);
    if (/最终季/i.test(seasonStr)) return 99;
    return 0;
  }

  function validateOiBridge(oiResult) {
    const oiTitle = oiResult.title || '';
    const oiYear = parseInt(oiResult.year) || 0;
    const anilistYearLocal = m.seasonYear || (m.startDate?.year ?? 0);
    const anilistFormat = m.format || '';
    const anilistEpisodes = m.episodes || 0;

    // Year proximity: >5 years apart is almost certainly wrong
    if (anilistYearLocal > 0 && oiYear > 0 && Math.abs(anilistYearLocal - oiYear) > 5) {
      if (IS_VERBOSE) console.log(`  [verbose] #${m.id} reject: year_diff(${anilistYearLocal}≠${oiYear}) "${oiTitle.slice(0,20)}"`);
      return { ok: false, reason: `year_diff(${anilistYearLocal}≠${oiYear})` };
    }

    // Format: TV matched to movie result → reject
    const oiLooksMovie = /剧场版|电影|劇場版|总集篇|総集編|特別総集編/i.test(oiTitle);
    if (oiLooksMovie && anilistFormat !== 'MOVIE') {
      if (anilistEpisodes > 50) {
        if (IS_VERBOSE) console.log(`  [verbose] #${m.id} reject: long_tv→movie "${oiTitle.slice(0,20)}"`);
        return { ok: false, reason: 'long_tv→movie' };
      }
      if (/^(TV|TV_SHORT|ONA)$/.test(anilistFormat)) {
        if (IS_VERBOSE) console.log(`  [verbose] #${m.id} reject: tv→movie "${oiTitle.slice(0,20)}"`);
        return { ok: false, reason: 'tv→movie' };
      }
    }

    // Season number: mismatch when both sides have explicit numbers
    const anilistSeasonInfo = extractSeasonFromTitle(m.title?.romaji, m.title?.english, m.title?.native);
    if (anilistSeasonInfo) {
      const anilistSN = extractSeasonNumber(anilistSeasonInfo);
      const oiSN = extractSeasonNumber(oiTitle);
      if (anilistSN > 1 && oiSN > 0 && anilistSN !== oiSN) {
        if (IS_VERBOSE) console.log(`  [verbose] #${m.id} reject: season_${anilistSN}≠${oiSN} "${oiTitle.slice(0,20)}"`);
        return { ok: false, reason: `season_${anilistSN}≠${oiSN}` };
      }
    }

    return { ok: true };
  }

  function checkFalseBridge(title) {
    const oiNameLooksMovie = /剧场版|电影|总集篇|伴我同行/.test(title || '');
    const isLongRunningTV = /^(TV|TV_SHORT|ONA)$/.test(m.format || '') && Number.isFinite(m.episodes) && m.episodes > 50;
    if (isLongRunningTV && oiNameLooksMovie) return true;
    return false;
  }

  function applySeasonInfo(title, seasonInfo, oiYear) {
    if (!seasonInfo || title.includes(seasonInfo)) return title;
    const existingSeason = extractSeasonFromTitle(title, title, title);
    if (existingSeason && existingSeason !== seasonInfo) return title;
    if (m.status === 'NOT_YET_RELEASED' && anilistYear > 0 && oiYear > 0 && oiYear < anilistYear - 1) {
      return null;
    }
    return cleanTitle(title + ' ' + seasonInfo);
  }

  // Strategy 1: Synonyms with Chinese
  if (m.synonyms && Array.isArray(m.synonyms)) {
    for (const syn of m.synonyms) {
      if (syn && containsChinese(syn) && !containsJapaneseKana(syn)) {
        const result = await searchOiWithSubstrings(syn, timeout, anilistYear);
        if (result) {
          let title = applySeasonInfo(cleanTitle(result.title), seasonInfo, result.year);
          if (title === null) continue;
          if (checkFalseBridge(title)) continue;
          const v3 = validateOiBridge({ ...result, title });
          if (!v3.ok) { /* mismatch — try next synonym */ continue; }
          return { ...result, title };
        }
      }
    }
  }

  // Strategy 2: Mapping table alias
  const alias = findAlias(m.title?.native || m.title?.romaji || m.title?.english || '');
  if (alias) {
    const result = await searchOiDynamic([alias], timeout, anilistYear);
    if (result) {
      let title = applySeasonInfo(cleanTitle(result.title), seasonInfo, result.year);
      if (title === null) return null;
      if (checkFalseBridge(title)) return null;
      const v2 = validateOiBridge({ ...result, title });
      if (!v2.ok) { /* mapping mismatch — fall through to Strategy 3 */ }
      else return { ...result, title };
    }
  }

  // Strategy 3: Native/romaji/english with multi-result fallback
  const terms = [m.title?.native, m.title?.romaji, m.title?.english].filter(Boolean);
  const results = await searchOiDynamic(terms, timeout, anilistYear, 3); // top 3
  if (results && results.length > 0) {
    // Try each result in scored order until one passes validation
    const isArray = Array.isArray(results);
    const tryList = isArray ? results : [results];
    for (let fi = 0; fi < tryList.length; fi++) {
      const oiR = tryList[fi];
      let title = cleanTitle(oiR.title);
      if (containsJapaneseKana(title)) {
        const mapped = findChinese(m.title?.romaji, m.title?.english, m.title?.native, title);
        if (mapped && !containsJapaneseKana(mapped)) title = mapped;
      }
      title = applySeasonInfo(title, seasonInfo, oiR.year);
      if (title === null) continue;
      if (checkFalseBridge(title)) continue;
      const v1 = validateOiBridge({ ...oiR, title });
      if (v1.ok) {
        if (fi > 0 && IS_VERBOSE) console.log(`  [verbose] #${m.id} 兜底命中 idx=${oiR.oiIndex}: "${title.slice(0,25)}"`);
        return { ...oiR, title };
      }
    }
    if (IS_VERBOSE && tryList.length > 1) {
      console.log(`  [verbose] #${m.id} 策略3 ${tryList.length}个候选全被拒绝`);
    }
  }

  return null;
}

// ==================== Core Sync Functions ====================

async function syncAnimeMetaFromAniList(fullSync = false, startYear, endYear, noInlineOi = false, endSeasonIdx) {
  const seasonsToSync = getSeasonList(fullSync, startYear, endYear, endSeasonIdx);
  let totalInserted = 0;

  console.log(`\n[sync] === AniList 元数据同步 ===`);
  console.log(`[sync] 模式: ${fullSync ? '全量' : '近期'}, 目标: ${seasonsToSync.length} 个季度`);
  console.log(`[sync] 季度范围: ${startYear || SYNC_START_YEAR}-${endYear || '当前'}`);
  console.log(`[sync] 季度: ${seasonsToSync.map(s => s.season + ' ' + s.seasonYear).join(', ')}`);

  for (const { season, seasonYear } of seasonsToSync) {
    if (isCancelled) { console.log('[sync] 已取消'); break; }

    let page = 1;
    let hasNext = true;
    const maxPages = fullSync ? 5 : 3; // 全量模式每季度最多5页(250条)

    while (hasNext && page <= maxPages) {
      if (isCancelled) break;

      try {
        process.stdout.write(`  [sync] ${season} ${seasonYear} 第${page}页... `);

        // filter: TV/剧场版/OVA/ONA only, exclude adult content, JP origin
        const data = await anilistQuery(`
          query {
            Page(page: ${page}, perPage: 50) {
              pageInfo { hasNextPage }
              media(season: ${season}, seasonYear: ${seasonYear}, type: ANIME, format_in: [TV, TV_SHORT, MOVIE, ONA, OVA], sort: POPULARITY_DESC, isAdult: false) {
                id format status countryOfOrigin isAdult
                title { romaji english native }
                synonyms
                coverImage { large }
                averageScore popularity episodes genres
                season seasonYear
                startDate { year month day }
                nextAiringEpisode { episode airingAt }
              }
            }
          }
        `);

        if (!data?.Page?.media?.length) {
          console.log('无数据');
          break;
        }

        const ALLOWED_FORMATS = new Set(['TV', 'TV_SHORT', 'MOVIE', 'ONA', 'OVA']);
        const ADULT_GENRES = new Set(['Hentai', 'Ecchi']);
        const mediaList = data.Page.media.filter(m => {
          if (m.countryOfOrigin !== 'JP') return false;
          if (m.isAdult) return false;
          if (!ALLOWED_FORMATS.has(m.format)) return false;
          // Double-check: exclude if genres contain adult tags
          const genreList = m.genres || [];
          if (genreList.some(g => ADULT_GENRES.has(g))) return false;
          return true;
        });
        const metaList = mediaList.map(m => ({
          anilist_id: m.id,
          title_romaji: m.title?.romaji || '',
          title_native: m.title?.native || '',
          title_chinese: '',
          cover_image: m.coverImage?.large || '',
          average_score: m.averageScore || 0,
          popularity: m.popularity || 0,
          episodes: m.episodes || 0,
          status: m.status || '',
          format: m.format || '',
          genres: JSON.stringify(m.genres || []),
          season: m.season || season,
          season_year: m.seasonYear || seasonYear,
          start_date: m.startDate ? JSON.stringify(m.startDate) : '',
          next_airing_episode: m.nextAiringEpisode?.episode || 0,
          next_airing_at: m.nextAiringEpisode?.airingAt || 0,
          oi_msg: '',
          oi_index: 0,
          country_of_origin: m.countryOfOrigin || 'JP'
        }));

        // Inline OIAPI — get both title_chinese + oi_msg from single API call, no mismatch
        let oiResolved = 0;
        if (!noInlineOi) {
          for (let i = 0; i < mediaList.length; i++) {
            try {
              const oiResult = await unifiedOiSearch(mediaList[i], { timeout: OI_TIMEOUT });
              if (oiResult && oiResult.title) {
                metaList[i].title_chinese = oiResult.title;
                metaList[i].oi_msg = oiResult.oiMsg || oiResult.title;
                metaList[i].oi_index = oiResult.oiIndex || 1;
                oiResolved++;
              }
            } catch (e) {
              // OIAPI unreachable — leave empty for this anime
            }
            if (i < mediaList.length - 1) await delay(OI_BATCH_DELAY);
          }
        }

        const result = database.upsertAnimeMetaBatch(metaList);
        if (result.success) totalInserted += result.count;

        const oiSuffix = !noInlineOi ? `, OI: ${oiResolved}` : '';
        console.log(`OK (${metaList.length} 条${oiSuffix})`);

        hasNext = data.Page.pageInfo?.hasNextPage || false;
        page++;
        if (hasNext) await delay(ANILIST_PAGE_DELAY);

      } catch (e) {
        console.log(`失败: ${e.message}`);
        break;
      }
    }

    // 季度间延迟，防止 API 限流
    const idx = seasonsToSync.findIndex(s => s.season === season && s.seasonYear === seasonYear);
    if (idx < seasonsToSync.length - 1) {
      await delay(ANILIST_SEASON_DELAY);
    }
  }

  console.log(`[sync] === 同步完成: ${totalInserted} 条 ===\n`);
  return totalInserted;
}

async function resolveMissingOiMsgs(limit = 50, batchDelay = OI_BATCH_DELAY) {
  if (isCancelled) return 0;

  // Query anime without oi_msg — no longer requires title_chinese != '' since Chinese titles now come from OIAPI
  const missing = database.getAnimeMetaMissingOi(limit);
  if (missing.length === 0) {
    console.log('[oi-resolve] 所有番剧都有 oi_msg，无需解析');
    return 0;
  }

  console.log(`\n[oi-resolve] === OI 播放源 + 中文标题解析 ===`);
  console.log(`[oi-resolve] 待解析: ${missing.length} 部, 超时: ${OI_TIMEOUT}ms/请求`);

  let resolved = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < missing.length; i++) {
    if (isCancelled) { console.log('[oi-resolve] 已取消'); break; }

    const m = missing[i];
    const progress = `[${i + 1}/${missing.length}]`;
    process.stdout.write(`  ${progress} #${m.anilist_id} "${(m.title_romaji || '?').slice(0, 30)}" `);

    try {
      const mediaObj = {
        id: m.anilist_id,
        title: { romaji: m.title_romaji, english: m.title_romaji, native: m.title_native },
        synonyms: [],  // Chinese titles now come FROM OIAPI, not fed INTO it
        format: m.format,
        status: m.status,
        seasonYear: m.season_year,
        startDate: m.start_date ? JSON.parse(m.start_date) : null
      };

      const oiResult = await Promise.race([
        unifiedOiSearch(mediaObj, { timeout: OI_TIMEOUT }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('oi_timeout')), OI_TIMEOUT + 1000))
      ]);

      if (oiResult && (oiResult.title || oiResult.oiMsg)) {
        const title = oiResult.title || oiResult.oiMsg;
        const result = database.updateAnimeTitleAndOiMsg(
          m.anilist_id, title, oiResult.oiMsg || title, oiResult.oiIndex || 1
        );
        if (result.skipped) {
          skipped++;
          console.log('– 自动标题修改已禁用（跳过）');
        } else if (result.error || !result.success) {
          failed++;
          console.log(`✗ ${result.error || '未写入'}`);
        } else {
          resolved++;
          console.log(`✓ "${title.slice(0, 25)}"`);
        }
      } else {
        skipped++;
        console.log('– 无结果（跳过）');
      }
    } catch (e) {
      failed++;
      console.log(`✗ ${e.message}`);
    }

    if (i < missing.length - 1) await delay(batchDelay);
  }

  console.log(`[oi-resolve] === 完成: 解析 ${resolved} / 跳过 ${skipped} / 失败 ${failed} ===\n`);
  totalOiResolved += resolved;
  return resolved;
}

// ==================== OIAPI Health Check ====================
async function checkOiApiReachable() {
  try {
    const testUrl = `${OI_BASE}?msg=${encodeURIComponent('测试')}`;
    const r = await Promise.race([
      httpFetch(testUrl, { timeout: 3000 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3500))
    ]);
    return r.status === 200;
  } catch {
    return false;
  }
}

// ==================== Utility ====================
function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function printStats() {
  const count = database.getAnimeMetaCount();
  const withChinese = database.getAnimeMetaWithOiMsg ? 'N/A' : count;
  console.log(`\n[stats] 数据库统计:`);
  console.log(`  番剧总数: ${count}`);
  console.log(`  本次同步: ${totalSynced} 条`);
  console.log(`  本次 oi_msg 解析: ${totalOiResolved} 条`);
}

// ==================== Main Entry ====================
async function main() {
  const args = process.argv.slice(2);
  const fullSync = args.includes('--full');
  const oiOnly = args.includes('--oi-only');
  const anilistOnly = args.includes('--anilist-only');
  const noInlineOi = args.includes('--no-inline-oi');
  const verbose = args.includes('--verbose');
  if (verbose) IS_VERBOSE = true;

  // Parse --start-year and --end-year
  const startYearIdx = args.indexOf('--start-year');
  const endYearIdx = args.indexOf('--end-year');
  const startYear = startYearIdx >= 0 ? parseInt(args[startYearIdx + 1]) : 0;
  const endYear = endYearIdx >= 0 ? parseInt(args[endYearIdx + 1]) : 0;

  console.log('═══════════════════════════════════════');
  console.log('  Anime Site — 数据库同步工具');
  console.log(`  HTTPS 代理: ${PROXY_URL}`);
  if (startYear || endYear) {
    console.log(`  年份范围: ${startYear || SYNC_START_YEAR}-${endYear || '当前'}`);
  }
  console.log('═══════════════════════════════════════');

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    console.log('\n\n[!] 收到中断信号，正在保存并退出...');
    isCancelled = true;
  });

  // Step 1: Initialize DB
  console.log('\n[init] 初始化数据库...');
  await database.initDatabase();

  // Step 1.5: Clear DB if requested (before reading count)
  if (args.includes('--clear')) {
    console.log('[clear] 清空 anime_meta 表...');
    database.clearAnimeMeta();
    console.log('[clear] ✓ anime_meta 已清空，将从零开始同步');
  }

  const beforeCount = database.getAnimeMetaCount();
  console.log(`[init] 当前数据库已有 ${beforeCount} 条番剧记录`);

  // Step 1.6: --batch mode — auto-split into 3-year chunks (2010 → 2026 Spring)
  const useBatch = args.includes('--batch');
  if (useBatch) {
    if (oiOnly) console.log('[batch] --batch 与 --oi-only 冲突，忽略 --oi-only');
    if (fullSync) console.log('[batch] --batch 已隐含全量模式');

    const BATCH_SIZE = 3;
    const batches = [];
    for (let y = SYNC_START_YEAR; y <= 2026; y += BATCH_SIZE) {
      batches.push({ start: y, end: Math.min(y + BATCH_SIZE - 1, 2026) });
    }

    const totalBatches = batches.length;
    totalSynced = 0;

    for (let i = 0; i < totalBatches; i++) {
      if (isCancelled) break;

      const { start, end } = batches[i];
      const isLast = (i === totalBatches - 1 && end === 2026);

      console.log(`\n[batch] ═══ 批次 ${i + 1}/${totalBatches}: ${start}-${end}${isLast ? ' (仅冬/春季)' : ''} ═══`);

      // 2026 only has WINTER (idx=0) + SPRING (idx=1), no SUMMER/FALL yet
      const endSeason = isLast ? 1 : undefined;

      const inserted = await syncAnimeMetaFromAniList(true, start, end, anilistOnly || noInlineOi, endSeason);
      totalSynced += inserted;

      if (i < totalBatches - 1 && !isCancelled) {
        console.log(`[batch] 等待 ${ANILIST_SEASON_DELAY / 1000}s 后继续下一批...`);
        await delay(ANILIST_SEASON_DELAY);
      }
    }

    console.log(`\n[batch] ═══ 全部批次完成: ${totalSynced} 条 ═══`);

    // Fallback: pick up any missed oi_msg entries
    if (!anilistOnly && !noInlineOi) {
      while (!isCancelled) {
        const resolved = await resolveMissingOiMsgs(100, OI_BATCH_DELAY);
        if (resolved === 0) break;
      }
    }

    printStats();
    database.saveToFile(); process.exit(0);
  }

  if (oiOnly) {
    // Only resolve oi_msg
    console.log('[mode] oi-only: 只解析 oi_msg');
    while (!isCancelled) {
      const resolved = await resolveMissingOiMsgs(100, OI_BATCH_DELAY);
      if (resolved === 0) break;
    }
    printStats();
    database.saveToFile(); process.exit(0);
  }

  // Step 2: Sync AniList data
  if (!isCancelled) {
    await syncAnimeMetaFromAniList(fullSync || !!startYear, startYear || 0, endYear || 0, anilistOnly || noInlineOi);
  }

  if (anilistOnly) {
    console.log('[mode] anilist-only: 跳过 oi_msg 解析');
    const afterCount = database.getAnimeMetaCount();
    totalSynced = afterCount - beforeCount;
    printStats();
    database.saveToFile(); process.exit(0);
  }

  // Step 3: OIAPI health check
  console.log('[check] 检测 OIAPI 连通性...');
  const oiReachable = await checkOiApiReachable();
  if (!oiReachable) {
    console.log('[check] ⚠ OIAPI 不可达 — 跳过 oi_msg 解析');
    console.log('[check]   可通过代理/VPN 后运行 `node sync-db.js --oi-only` 补充解析');
    const afterCount = database.getAnimeMetaCount();
    totalSynced = afterCount - beforeCount;
    printStats();
    database.saveToFile(); process.exit(0);
  }
  console.log('[check] ✓ OIAPI 可达');

  // Step 4: Resolve oi_msg
  while (!isCancelled) {
    const resolved = await resolveMissingOiMsgs(100, OI_BATCH_DELAY);
    if (resolved === 0) break;
  }

  const afterCount = database.getAnimeMetaCount();
  totalSynced = afterCount - beforeCount;
  printStats();
  console.log('\n[完成] 同步结束！\n');
  database.saveToFile(); process.exit(0);
}

main().catch(err => {
  console.error('\n[FATAL]', err);
  database.saveToFile(); process.exit(1);
});
