const { dbMetaToResult } = require('../utils/db-helpers');

// Public local-directory search contract: tags use ALL semantics, dates include
// both bounds, score is AniList / 10, seasons match year + season metadata.
// Every filter applies before pagination. Missing metadata cannot match a range;
// rank / weekday / adult filters are deliberately rejected, never approximated.

function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }
function text(value, name, max = 254) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) invalid(`${name}格式不正确`);
  return value.trim();
}
function integer(value, name, fallback, max) {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) invalid(`${name}格式不正确`);
  return value;
}
function dateKey(value, name) {
  const raw = text(value, name, 10);
  if (!raw) return 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) invalid(`${name}格式不正确`);
  const date = new Date(`${raw}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw) invalid(`${name}格式不正确`);
  return Number(raw.replace(/-/g, ''));
}
function score(value, name) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) invalid(`${name}须在0到10之间`);
  return value;
}
function parseCatalogSearch(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('搜索条件格式不正确');
  const supported = new Set(['keyword', 'id', 'tags', 'sort', 'season', 'dateStart', 'dateEnd', 'scoreMin', 'scoreMax', 'excludeIds', 'page', 'perPage']);
  if (Object.keys(body).some(key => !supported.has(key))) invalid('不支持该筛选条件；排名、放送星期和成人分类暂无可靠元数据');
  const keyword = text(body.keyword, '关键词');
  const id = integer(body.id, 'AniList ID', 0, 2147483647);
  const tags = body.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 20 || tags.some(tag => !text(tag, '标签', 80))) invalid('标签格式不正确');
  const sort = text(body.sort, '排序', 20) || 'heat';
  if (sort === 'rank') invalid('暂不支持排名排序，目录缺少可靠排名元数据');
  if (!['heat', 'score', 'match', 'latest'].includes(sort)) invalid('不支持该排序方式');
  const seasonText = text(body.season, '季度', 6).toUpperCase();
  const seasonMatch = seasonText.match(/^(\d{4})Q([1-4])$/);
  if (seasonText && (!seasonMatch || Number(seasonMatch[1]) < 1900 || Number(seasonMatch[1]) > 2199)) invalid('季度格式不正确');
  const dateStart = dateKey(body.dateStart, '开始日期'), dateEnd = dateKey(body.dateEnd, '结束日期');
  if (seasonText && (dateStart || dateEnd)) invalid('季度与自定义日期请只选择一种');
  if (dateStart && dateEnd && dateStart > dateEnd) invalid('开始日期不能晚于结束日期');
  const scoreMin = score(body.scoreMin, '最低评分'), scoreMax = score(body.scoreMax, '最高评分');
  if (scoreMin != null && scoreMax != null && scoreMin > scoreMax) invalid('最低评分不能高于最高评分');
  const excludeIds = body.excludeIds ?? [];
  if (!Array.isArray(excludeIds) || excludeIds.length > 10000 || excludeIds.some(id => !Number.isSafeInteger(id) || id < 1)) invalid('排除作品列表格式不正确');
  return { keyword, id, tags: [...new Set(tags.map(tag => tag.trim()))], sort,
    season: seasonMatch ? ['WINTER', 'SPRING', 'SUMMER', 'FALL'][Number(seasonMatch[2]) - 1] : '',
    year: seasonMatch ? Number(seasonMatch[1]) : 0, dateStart, dateEnd, scoreMin, scoreMax,
    excludeIds: [...new Set(excludeIds)], page: integer(body.page, '页码', 1, 100000),
    perPage: integer(body.perPage, '每页数量', 24, 60) };
}

function mountCatalogSearchRoutes(app, { database }) {
  app.post('/api/catalog/search', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = database.searchCatalog(parseCatalogSearch(req.body));
      res.json({ ...result, results: result.results.map(meta => ({
        ...dbMetaToResult(meta), anilistId: meta.anilist_id,
        ratingSource: 'anilist', ratingScore: Number(meta.average_score || 0) / 10
      })) });
    } catch (error) {
      if (error.status === 400) return res.status(400).json({ error: error.message });
      console.error('[catalog-search] Search failed:', error.message);
      res.status(503).json({ error: '目录搜索暂时不可用，请稍后重试' });
    }
  });
}

module.exports = { mountCatalogSearchRoutes };
