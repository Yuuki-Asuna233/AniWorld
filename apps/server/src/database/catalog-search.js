// Directory search is separate from provider search: every condition is applied
// to the full local catalogue before COUNT / LIMIT, without a truncated pool.
const TAG_ALIASES = {
  动作: 'Action', 冒险: 'Adventure', 喜剧: 'Comedy', 搞笑: 'Comedy',
  剧情: 'Drama', 奇幻: 'Fantasy', 恐怖: 'Horror', 机甲: 'Mecha', 机战: 'Mecha',
  音乐: 'Music', 悬疑: 'Mystery', 推理: 'Mystery', 心理: 'Psychological',
  恋爱: 'Romance', 爱情: 'Romance', 科幻: 'Sci-Fi', 日常: 'Slice of Life',
  运动: 'Sports', 体育: 'Sports', 超自然: 'Supernatural', 惊悚: 'Thriller',
  百合: 'Yuri', 治愈: 'Iyashikei', 后宫: 'Harem', 卖肉: 'Ecchi', 校园: 'School'
};
const CONTENT_NAMES = { Yuri: '百合', Iyashikei: '治愈', Harem: '后宫', School: '校园' };
const escapeLike = value => String(value).replace(/[\\%_]/g, '\\$&');

function createCatalogSearchRepository({ getDb }) {
  function rows(sql, params) {
    const result = getDb().exec(sql, params)[0];
    return result ? result.values.map(values => Object.fromEntries(result.columns.map((name, i) => [name, values[i]]))) : [];
  }

  function searchCatalog(filters) {
    const { keyword, id, tags, sort, season, year, dateStart, dateEnd,
      scoreMin, scoreMax, excludeIds, page, perPage } = filters;
    const where = ["country_of_origin = 'JP'", "oi_msg != ''",
      "(title_chinese != '' OR title_romaji != '' OR title_native != '')"];
    const params = [];
    if (id) { where.push('anilist_id = ?'); params.push(id); }
    if (keyword) {
      where.push("(title_chinese LIKE ? ESCAPE '\\' OR title_romaji LIKE ? ESCAPE '\\' OR title_native LIKE ? ESCAPE '\\' OR oi_msg LIKE ? ESCAPE '\\')");
      params.push(...Array(4).fill(`%${escapeLike(keyword)}%`));
    }
    for (const tag of tags) {
      const canonical = TAG_ALIASES[tag] || tag;
      const alternatives = [...new Set([tag, canonical, CONTENT_NAMES[canonical]].filter(Boolean))];
      where.push(`(${alternatives.map(() => "(genres LIKE ? ESCAPE '\\' OR content_tags LIKE ? ESCAPE '\\')").join(' OR ')})`);
      for (const name of alternatives) {
        const pattern = `%${escapeLike(JSON.stringify(name))}%`;
        params.push(pattern, pattern);
      }
    }
    if (season) { where.push('season = ? AND season_year = ?'); params.push(season, year); }
    if (dateStart || dateEnd) {
      // A missing month/day is not an exact air date and cannot match a range.
      where.push('start_date_key % 100 BETWEEN 1 AND 31');
      where.push('CAST(start_date_key / 100 AS INTEGER) % 100 BETWEEN 1 AND 12');
      if (dateStart) { where.push('start_date_key >= ?'); params.push(dateStart); }
      if (dateEnd) { where.push('start_date_key <= ?'); params.push(dateEnd); }
    }
    if (scoreMin != null || scoreMax != null) where.push('average_score > 0');
    if (scoreMin != null) { where.push('average_score >= ?'); params.push(scoreMin * 10); }
    if (scoreMax != null) { where.push('average_score <= ?'); params.push(scoreMax * 10); }
    if (excludeIds.length) {
      where.push(`anilist_id NOT IN (${excludeIds.map(() => '?').join(',')})`);
      params.push(...excludeIds);
    }
    const predicate = where.join(' AND ');
    const total = Number(rows(`SELECT COUNT(*) AS total FROM anime_meta WHERE ${predicate}`, params)[0].total);
    const sortParams = [];
    let order = 'popularity DESC, average_score DESC';
    if (sort === 'score') order = 'average_score DESC, popularity DESC';
    if (sort === 'latest') order = 'start_date_key DESC, popularity DESC';
    if (sort === 'match' && keyword) {
      order = `CASE WHEN title_chinese = ? OR title_romaji = ? OR title_native = ? OR oi_msg = ? THEN 0
        WHEN title_chinese LIKE ? ESCAPE '\\' OR title_romaji LIKE ? ESCAPE '\\' OR title_native LIKE ? ESCAPE '\\' OR oi_msg LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
        popularity DESC, average_score DESC`;
      sortParams.push(...Array(4).fill(keyword), ...Array(4).fill(`${escapeLike(keyword)}%`));
    }
    const offset = (page - 1) * perPage;
    const results = rows(`SELECT * FROM anime_meta WHERE ${predicate} ORDER BY ${order}, anilist_id ASC LIMIT ? OFFSET ?`,
      [...params, ...sortParams, perPage, offset]);
    return { results, total, page, hasMore: offset + results.length < total };
  }
  return { searchCatalog };
}

module.exports = { createCatalogSearchRepository };
