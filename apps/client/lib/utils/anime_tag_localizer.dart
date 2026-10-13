const Map<String, String> _animeTagZh = {
  'Action': '动作',
  'Adventure': '冒险',
  'Comedy': '喜剧',
  'Drama': '剧情',
  'Ecchi': '卖肉',
  'Fantasy': '奇幻',
  'Horror': '恐怖',
  'Mahou Shoujo': '魔法少女',
  'Mecha': '机甲',
  'Music': '音乐',
  'Mystery': '悬疑',
  'Psychological': '心理',
  'Romance': '恋爱',
  'Sci-Fi': '科幻',
  'Sci Fi': '科幻',
  'SciFi': '科幻',
  'Slice of Life': '日常',
  'Sports': '运动',
  'Supernatural': '超自然',
  'Thriller': '惊悚',
};

String localizeAnimeTag(String tag) {
  final trimmed = tag.trim();
  if (trimmed.isEmpty) return trimmed;

  final direct = _animeTagZh[trimmed];
  if (direct != null) return direct;

  final lower = trimmed.toLowerCase();
  for (final entry in _animeTagZh.entries) {
    if (entry.key.toLowerCase() == lower) {
      return entry.value;
    }
  }

  return trimmed;
}
