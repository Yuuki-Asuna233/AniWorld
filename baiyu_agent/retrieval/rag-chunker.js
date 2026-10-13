const { createHash } = require('crypto');

const GENRE_LABELS = {
  Action: '动作', Adventure: '冒险', Comedy: '喜剧 搞笑', Drama: '剧情',
  Ecchi: '福利', Fantasy: '奇幻', Horror: '恐怖', Mecha: '机甲 机战',
  Music: '音乐', Mystery: '悬疑 推理', Psychological: '心理', Romance: '恋爱 爱情',
  'Sci-Fi': '科幻', 'Slice of Life': '日常 治愈', Sports: '运动 体育',
  Supernatural: '超自然', Thriller: '惊悚', Yuri: '百合', Iyashikei: '治愈',
  Harem: '后宫'
};

function cleanText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (_) {
    return String(value).split(',').map(item => item.trim()).filter(Boolean);
  }
}

function contentHash(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function shortHash(text) {
  return contentHash(text).slice(0, 20);
}

function splitLongText(value, { minChars = 300, maxChars = 500, overlap = 50 } = {}) {
  const text = cleanText(value);
  if (!text) return [];
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const candidate = text.slice(start + minChars, end);
      const boundary = Math.max(
        candidate.lastIndexOf('\n'), candidate.lastIndexOf('。'), candidate.lastIndexOf('！'),
        candidate.lastIndexOf('？'), candidate.lastIndexOf('；'), candidate.lastIndexOf('. ')
      );
      if (boundary >= 0) end = start + minChars + boundary + 1;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

function bilingualList(values) {
  return safeArray(values).map(value => {
    const label = GENRE_LABELS[value];
    return label ? `${value}（${label}）` : String(value);
  });
}

function chunkRecord({
  id, anilistId = 0, chunkType, chunkText, sourceType, sourceUrl = '',
  sourceTitle = '', publishedAt = '', trustScore = 0, sourceUpdatedAt = 0
}) {
  const text = cleanText(chunkText);
  return {
    id,
    anilistId: Number(anilistId) || 0,
    chunkType,
    chunkText: text,
    sourceType,
    sourceUrl,
    sourceTitle,
    publishedAt,
    trustScore: Number(trustScore) || 0,
    contentHash: contentHash(text),
    sourceUpdatedAt: Number(sourceUpdatedAt) || 0
  };
}

function titleOf(meta = {}) {
  return cleanText(meta.title_chinese || meta.title || meta.romajiTitle || meta.title_romaji || meta.nativeTitle || meta.title_native);
}

function buildAnimeMetaChunks(meta = {}) {
  const id = Number(meta.anilist_id || meta.anilistId) || 0;
  if (!id) return [];
  const title = titleOf(meta) || `AniList ${id}`;
  const romaji = cleanText(meta.title_romaji || meta.romajiTitle);
  const native = cleanText(meta.title_native || meta.nativeTitle);
  const genres = bilingualList(meta.genres);
  const tags = bilingualList(meta.content_tags || meta.contentTags);
  const sourceUrl = `https://anilist.co/anime/${id}`;
  const updatedAt = Number(meta.last_updated || meta.lastUpdated) || 0;
  const base = [
    `作品：${title}`,
    romaji ? `罗马字标题：${romaji}` : '',
    native ? `日文标题：${native}` : '',
    Number(meta.season_year || meta.year) ? `放送年份：${Number(meta.season_year || meta.year)}` : '',
    meta.season ? `季度：${meta.season}` : '',
    meta.format ? `形式：${meta.format}` : '',
    meta.status ? `状态：${meta.status}` : '',
    Number(meta.episodes) ? `总集数：${Number(meta.episodes)}` : '',
    Number(meta.average_score || meta.score) ? `AniList评分：${Number(meta.average_score || meta.score)}` : '',
    genres.length ? `题材：${genres.join('、')}` : '',
    tags.length ? `标签：${tags.join('、')}` : ''
  ].filter(Boolean).join('；');
  const chunks = [chunkRecord({
    id: `anime:${id}:metadata:0`, anilistId: id, chunkType: 'metadata',
    chunkText: base, sourceType: 'anime_meta', sourceUrl, sourceTitle: title,
    trustScore: 95, sourceUpdatedAt: updatedAt
  })];
  if (genres.length || tags.length) {
    chunks.push(chunkRecord({
      id: `anime:${id}:tags:0`, anilistId: id, chunkType: 'tags',
      chunkText: `《${title}》的题材与标签：${[...genres, ...tags].join('、')}。`,
      sourceType: 'anime_meta', sourceUrl, sourceTitle: title,
      trustScore: 95, sourceUpdatedAt: updatedAt
    }));
  }
  return chunks;
}

function buildAnimeDetailChunks(detail = {}) {
  const id = Number(detail.anilistId || detail.anilist_id) || 0;
  if (!id) return [];
  const title = titleOf(detail) || `AniList ${id}`;
  const sourceUrl = cleanText(detail.siteUrl) || `https://anilist.co/anime/${id}`;
  const now = Math.floor(Date.now() / 1000);
  const chunks = [];
  splitLongText(detail.description || detail.synopsis).forEach((text, index) => {
    chunks.push(chunkRecord({
      id: `anime:${id}:synopsis:${index}`, anilistId: id, chunkType: 'synopsis',
      chunkText: `《${title}》简介：${text}`, sourceType: 'anilist_detail',
      sourceUrl, sourceTitle: title, trustScore: 90, sourceUpdatedAt: now
    }));
  });
  const studios = safeArray(detail.studios);
  const tags = (safeArray(detail.tags)).map(tag => typeof tag === 'string' ? tag : tag?.name).filter(Boolean);
  if (studios.length || tags.length || detail.sourceMaterial) {
    chunks.push(chunkRecord({
      id: `anime:${id}:production:0`, anilistId: id, chunkType: 'production',
      chunkText: [
        `《${title}》制作资料`, studios.length ? `动画制作：${studios.join('、')}` : '',
        detail.sourceMaterial ? `原作类型：${detail.sourceMaterial}` : '',
        tags.length ? `标签：${bilingualList(tags).join('、')}` : ''
      ].filter(Boolean).join('；'),
      sourceType: 'anilist_detail', sourceUrl, sourceTitle: title,
      trustScore: 90, sourceUpdatedAt: now
    }));
  }
  const staff = safeArray(detail.staff).map(item => `${item?.name || ''}${item?.role ? `（${item.role}）` : ''}`).filter(Boolean);
  if (staff.length) {
    chunks.push(chunkRecord({
      id: `anime:${id}:staff:0`, anilistId: id, chunkType: 'staff',
      chunkText: `《${title}》主要制作人员：${staff.join('、')}。`,
      sourceType: 'anilist_detail', sourceUrl, sourceTitle: title,
      trustScore: 90, sourceUpdatedAt: now
    }));
  }
  const characters = safeArray(detail.characters).map(item => {
    const actor = item?.voiceActor ? `，声优 ${item.voiceActor}` : '';
    return `${item?.name || ''}${item?.role ? `（${item.role}${actor}）` : actor}`;
  }).filter(Boolean);
  if (characters.length) {
    chunks.push(chunkRecord({
      id: `anime:${id}:characters:0`, anilistId: id, chunkType: 'characters',
      chunkText: `《${title}》主要角色：${characters.join('、')}。`,
      sourceType: 'anilist_detail', sourceUrl, sourceTitle: title,
      trustScore: 90, sourceUpdatedAt: now
    }));
  }
  return chunks;
}

function buildWebChunks(results = []) {
  const now = Math.floor(Date.now() / 1000);
  const chunks = [];
  for (const result of results) {
    const url = cleanText(result.url);
    const title = cleanText(result.title);
    if (!url || !title) continue;
    const body = cleanText(result.content || result.raw_content);
    const pieces = splitLongText(body, { minChars: 350, maxChars: 600, overlap: 50 });
    (pieces.length ? pieces : [title]).forEach((text, index) => {
      chunks.push(chunkRecord({
        id: `web:${shortHash(url)}:${index}`,
        chunkType: 'web_article',
        chunkText: `${title}${result.publishedDate ? `（${result.publishedDate}）` : ''}：${text}`,
        sourceType: 'web', sourceUrl: url, sourceTitle: title,
        publishedAt: result.publishedDate || '', trustScore: Number(result.trustScore) || 45,
        sourceUpdatedAt: now
      }));
    });
  }
  return chunks;
}

module.exports = {
  GENRE_LABELS,
  cleanText,
  contentHash,
  splitLongText,
  buildAnimeMetaChunks,
  buildAnimeDetailChunks,
  buildWebChunks
};
