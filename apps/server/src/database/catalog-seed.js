// Portable anime_meta data only. Account state and live airing clocks are not
// part of this format; background refresh owns the latter.
const CATALOG_FIELDS = Object.freeze([
  'anilist_id', 'title_romaji', 'title_native', 'title_chinese', 'cover_image',
  'average_score', 'popularity', 'episodes', 'status', 'format', 'genres',
  'season', 'season_year', 'start_date', 'oi_msg', 'oi_index',
  'country_of_origin', 'content_tags'
]);
const FIELD_NAMES = new Set(CATALOG_FIELDS);
const INTEGER_FIELDS = new Set(['anilist_id', 'popularity', 'episodes', 'season_year', 'oi_index']);
const LIST_FIELDS = new Set(['genres', 'content_tags']);

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('目录记录必须是对象');
  for (const field of Object.keys(record)) {
    if (!FIELD_NAMES.has(field)) throw new Error(`目录包含不支持的字段：${field}`);
  }
  const result = {};
  for (const field of CATALOG_FIELDS) {
    let value = record[field];
    if (field === 'average_score') {
      value ??= 0;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error('评分必须介于 0 和 100');
    } else if (INTEGER_FIELDS.has(field)) {
      value = field === 'oi_index' && (value == null || value === 0) ? 1 : (value ?? 0);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`目录字段 ${field} 必须是非负整数`);
      if ((field === 'anilist_id' || field === 'oi_index') && value < 1) throw new Error(`目录字段 ${field} 必须大于 0`);
    } else if (LIST_FIELDS.has(field)) {
      // Older catalogue rows used comma-separated genres instead of JSON.
      const text = typeof value === 'string' ? value.trim() : '';
      const list = typeof value === 'string'
        ? (text.startsWith('[') ? JSON.parse(text) : text.split(',').map(item => item.trim()).filter(Boolean))
        : (value ?? []);
      if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) throw new Error(`目录字段 ${field} 必须是文本数组`);
      value = JSON.stringify(list);
    } else if (field === 'start_date' && value && typeof value === 'object') {
      value = JSON.stringify(value);
    } else {
      value ??= '';
      if (typeof value !== 'string' || value.length > 4096) throw new Error(`目录字段 ${field} 不是有效文本`);
      value = value.trim();
    }
    result[field] = value;
  }
  if (!result.title_chinese && !result.title_romaji && !result.title_native) throw new Error('目录记录缺少番剧名称');
  return result;
}

function readCatalogSeed(document) {
  if (document?.format !== 'aniworld-anime-meta' || document.version !== 1) throw new Error('不支持的番剧目录格式或版本');
  if (!Array.isArray(document.records) || !document.records.length || document.records.length > 100000) throw new Error('番剧目录为空或超过导入上限');
  if (document.recordCount !== document.records.length) throw new Error('目录记录数与文件声明不一致');
  const seen = new Set();
  return document.records.map(record => {
    const normalized = normalizeRecord(record);
    if (seen.has(normalized.anilist_id)) throw new Error(`目录 ID 重复：${normalized.anilist_id}`);
    seen.add(normalized.anilist_id);
    return normalized;
  });
}

function isMissing(value) {
  return value == null || value === 0 || (typeof value === 'string' && (!value.trim() || value.trim() === '[]'));
}

function fillMissingCatalogFields(current, incoming, protectedFields) {
  const merged = { ...current };
  for (const field of CATALOG_FIELDS) {
    // The index belongs to its mapping. Never replace an existing mapping's
    // index merely because its numeric value looks like a default.
    if (field === 'anilist_id' || field === 'oi_index' || protectedFields.has(field)) continue;
    if (field === 'oi_msg' && protectedFields.has('oi_index')) continue;
    if (isMissing(current[field]) && !isMissing(incoming[field])) merged[field] = incoming[field];
  }
  if (isMissing(current.oi_msg) && !isMissing(merged.oi_msg) && !protectedFields.has('oi_index')) merged.oi_index = incoming.oi_index;
  return merged;
}

module.exports = { CATALOG_FIELDS, normalizeRecord, readCatalogSeed, fillMissingCatalogFields };
