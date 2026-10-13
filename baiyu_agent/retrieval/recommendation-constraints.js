const GENRE_NAMES = Object.freeze({ 动作: 'Action', 冒险: 'Adventure', 喜剧: 'Comedy', 搞笑: 'Comedy',
  剧情: 'Drama', 奇幻: 'Fantasy', 恐怖: 'Horror', 机甲: 'Mecha', 音乐: 'Music', 悬疑: 'Mystery',
  推理: 'Mystery', 心理: 'Psychological', 恋爱: 'Romance', 爱情: 'Romance', 科幻: 'Sci-Fi',
  日常: 'Slice of Life', 运动: 'Sports', 体育: 'Sports', 超自然: 'Supernatural', 惊悚: 'Thriller',
  治愈: 'Iyashikei', 百合: 'Yuri', 后宫: 'Harem', 卖肉: 'Ecchi', 校园: 'School' });

function genres(values = []) {
  return [...new Set(values.map(value => GENRE_NAMES[value] || String(value).trim()).filter(Boolean))];
}

// The planning model interprets current wording and effective memory together.
// This module only normalizes typed parameters; it never reinterprets prose.
function recommendationConstraints(input = {}) {
  const allGenres = genres([...(input.genres || []), ...(input.allGenres || [])]);
  const preferredGenres = genres(input.preferredGenres);
  const anyGenreGroups = (input.anyGenreGroups || []).map(genres);
  const alternatives = genres(input.anyGenres);
  if (alternatives.length) anyGenreGroups.push(alternatives);
  const excludeTags = genres(input.excludeTags);
  const allowedGroups = anyGenreGroups.map(group => group.filter(value => !excludeTags.includes(value)));
  const excludedStatuses = [...new Set(input.excludedStatuses || [])];
  const excludedYears = [...new Set(input.excludedYears || [])];
  const excludedSeasons = input.excludedSeasons || [];
  const status = input.status || '', year = input.year || 0, season = input.season || '';
  const seasonYear = input.seasonYear || 0;
  const scoreMode = input.scoreMode || (input.scoreMin != null || input.scoreMax != null ? 'range' : 'none');
  if (allGenres.some(value => excludeTags.includes(value)) || allowedGroups.some(group => !group.length)
    || excludedStatuses.includes(status) || (year && excludedYears.includes(year))
    || (season && (!seasonYear || (year && year !== seasonYear)))
    || excludedSeasons.some(item => item.season === season && item.seasonYear === seasonYear)) {
    throw new Error('推荐约束存在冲突，请先澄清，不能静默放宽条件。');
  }
  return { allGenres, anyGenreGroups: allowedGroups, anyGenres: genres(allowedGroups.flat()), preferredGenres,
    genres: genres([...allGenres, ...allowedGroups.flat(), ...preferredGenres]),
    excludeTags, excludedStatuses, excludedYears, excludedSeasons, status, year, season, seasonYear,
    scoreMode,
    scoreMin: scoreMode === 'none' ? 0 : input.scoreMin ?? 0,
    scoreMax: scoreMode === 'none' ? null : input.scoreMax ?? null,
    allowWatched: input.allowWatched === true, contextAnilistId: input.contextAnilistId || 0 };
}

module.exports = { recommendationConstraints, canonicalGenres: genres };
