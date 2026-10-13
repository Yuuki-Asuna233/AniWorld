import 'dart:convert';

import 'package:kazumi/utils/date_time.dart';

const Object _unchanged = Object();

class SearchDateRange {
  final String start;
  final String end;

  const SearchDateRange({
    required this.start,
    required this.end,
  });

  bool get isValid => start.isNotEmpty && end.isNotEmpty;

  @override
  bool operator ==(Object other) {
    return other is SearchDateRange && other.start == start && other.end == end;
  }

  @override
  int get hashCode => Object.hash(start, end);
}

class SearchIntRange {
  final int? min;
  final int? max;

  const SearchIntRange({
    this.min,
    this.max,
  });

  bool get isValid => min != null || max != null;

  String toToken() => '${min ?? ''}..${max ?? ''}';

  @override
  bool operator ==(Object other) {
    return other is SearchIntRange && other.min == min && other.max == max;
  }

  @override
  int get hashCode => Object.hash(min, max);
}

class SearchDoubleRange {
  final double? min;
  final double? max;

  const SearchDoubleRange({
    this.min,
    this.max,
  });

  bool get isValid => min != null || max != null;

  String toToken() => '${_formatDouble(min)}..${_formatDouble(max)}';

  static String _formatDouble(double? value) {
    if (value == null) return '';
    final fixed = value.toString();
    return fixed.endsWith('.0') ? fixed.substring(0, fixed.length - 2) : fixed;
  }

  @override
  bool operator ==(Object other) {
    return other is SearchDoubleRange && other.min == min && other.max == max;
  }

  @override
  int get hashCode => Object.hash(min, max);
}

class SearchFilterState {
  final String id;
  final String keyword;
  final List<String> tags;
  final String sort;
  final bool explicitSort;
  final String season;
  final SearchDateRange? dateRange;
  final SearchIntRange? rankRange;
  final SearchDoubleRange? scoreRange;
  final List<int> weekdays;

  const SearchFilterState({
    this.id = '',
    this.keyword = '',
    this.tags = const [],
    this.sort = 'heat',
    this.explicitSort = false,
    this.season = '',
    this.dateRange,
    this.rankRange,
    this.scoreRange,
    this.weekdays = const [],
  });

  bool get isIdSearch => id.isNotEmpty;

  bool get hasAdvancedFilters =>
      tags.isNotEmpty ||
      explicitSort ||
      sort != 'heat' ||
      season.isNotEmpty ||
      dateRange != null ||
      rankRange?.isValid == true ||
      scoreRange?.isValid == true ||
      weekdays.isNotEmpty;

  SearchDateRange? get effectiveDateRange {
    if (dateRange != null) return dateRange;
    if (season.isEmpty) return null;
    return SearchParser.seasonToDateRange(season);
  }

  SearchFilterState copyWith({
    String? id,
    String? keyword,
    List<String>? tags,
    String? sort,
    bool? explicitSort,
    Object? season = _unchanged,
    Object? dateRange = _unchanged,
    Object? rankRange = _unchanged,
    Object? scoreRange = _unchanged,
    List<int>? weekdays,
  }) {
    return SearchFilterState(
      id: id ?? this.id,
      keyword: keyword ?? this.keyword,
      tags: tags ?? this.tags,
      sort: sort ?? this.sort,
      explicitSort: explicitSort ?? (sort != null || this.explicitSort),
      season: identical(season, _unchanged) ? this.season : season as String,
      dateRange: identical(dateRange, _unchanged)
          ? this.dateRange
          : dateRange as SearchDateRange?,
      rankRange: identical(rankRange, _unchanged)
          ? this.rankRange
          : rankRange as SearchIntRange?,
      scoreRange: identical(scoreRange, _unchanged)
          ? this.scoreRange
          : scoreRange as SearchDoubleRange?,
      weekdays: weekdays ?? this.weekdays,
    );
  }
}

class SearchParser {
  final String query;

  static const String _fieldNames =
      'id|tag|sort|season|date|rank|score|weekday|nsfw';

  final RegExp _dateRegExp = RegExp(
    r'date:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})',
    caseSensitive: false,
  );
  final RegExp _rankRegExp = RegExp(
    r'rank:(\d*)\.\.(\d*)',
    caseSensitive: false,
  );
  final RegExp _scoreRegExp = RegExp(
    r'score:(\d+(?:\.\d+)?)?\.\.(\d+(?:\.\d+)?)?',
    caseSensitive: false,
  );

  SearchParser(this.query);

  /// Do not silently strip an unsupported or malformed handwritten token.
  String? get validationError {
    final seen = <String>{};
    int tagCount = 0;
    for (final match in _tokenRegExp().allMatches(query)) {
      final token = match.group(0)!.trim();
      final separator = token.indexOf(':');
      final field = token.substring(0, separator).toLowerCase();
      final value = token.substring(separator + 1);
      if (['rank', 'weekday', 'nsfw'].contains(field) ||
          (field == 'sort' && value.toLowerCase() == 'rank')) {
        return '暂不支持排名、放送星期或成人分类筛选，目录缺少可靠元数据';
      }
      if (field != 'tag' && !seen.add(field)) return '筛选条件重复：$field';
      if (field == 'tag' && ++tagCount > 20) return '最多选择20个标签';
      final tag = field == 'tag' ? _decodeTag(value) : null;
      final valid = switch (field) {
        'id' => RegExp(r'^\d+$').hasMatch(value) &&
            (int.tryParse(value) ?? 0) > 0 &&
            (int.tryParse(value) ?? 0) <= 2147483647,
        'tag' => tag != null && tag.trim().isNotEmpty && tag.length <= 80,
        'sort' =>
          ['heat', 'score', 'match', 'latest'].contains(value.toLowerCase()),
        'season' => RegExp(r'^(19|20|21)\d{2}Q[1-4]$', caseSensitive: false)
            .hasMatch(value),
        'date' => _dateRegExp.firstMatch(token)?.group(0) == token,
        'score' => _scoreRegExp.firstMatch(token)?.group(0) == token &&
            parseScoreRange()?.isValid == true,
        _ => false,
      };
      if (!valid) return '搜索条件格式不正确：$token';
    }
    if (seen.contains('season') && seen.contains('date')) {
      return '季度与自定义日期请只选择一种';
    }
    if (parseKeywords().length > 254) return '关键词不能超过254个字符';
    final range = parseDateRange();
    if (range != null) {
      final start = DateTime.tryParse(range.start),
          end = DateTime.tryParse(range.end);
      if (start == null ||
          end == null ||
          formatDateTime(start) != range.start ||
          formatDateTime(end) != range.end ||
          start.isAfter(end)) {
        return '日期范围无效，开始日期不能晚于结束日期';
      }
    }
    final scores = parseScoreRange();
    if (scores != null &&
        ((scores.min != null && (scores.min! < 0 || scores.min! > 10)) ||
            (scores.max != null && (scores.max! < 0 || scores.max! > 10)) ||
            (scores.min != null &&
                scores.max != null &&
                scores.min! > scores.max!))) {
      return '评分范围须在0到10之间，最低分不能高于最高分';
    }
    return null;
  }

  String? parseId() {
    return _firstValue('id');
  }

  List<String> parseTags() {
    return _values('tag')
        .map((value) => _decodeTag(value)?.trim() ?? '')
        .where((e) => e.isNotEmpty)
        .toSet()
        .toList();
  }

  String? parseSort() {
    return _firstValue('sort')?.toLowerCase();
  }

  String? parseSeason() {
    final value = _firstValue('season');
    return value != null &&
            RegExp(r'^\d{4}Q[1-4]$', caseSensitive: false).hasMatch(value)
        ? value.toUpperCase()
        : null;
  }

  SearchDateRange? parseDateRange() {
    final match = _dateRegExp.firstMatch('date:${_firstValue('date') ?? ''}');
    if (match == null) return null;
    return SearchDateRange(start: match.group(1)!, end: match.group(2)!);
  }

  SearchIntRange? parseRankRange() {
    final match = _rankRegExp.firstMatch('rank:${_firstValue('rank') ?? ''}');
    if (match == null) return null;
    final min = int.tryParse(match.group(1) ?? '');
    final max = int.tryParse(match.group(2) ?? '');
    final range = SearchIntRange(min: min, max: max);
    return range.isValid ? range : null;
  }

  SearchDoubleRange? parseScoreRange() {
    final match =
        _scoreRegExp.firstMatch('score:${_firstValue('score') ?? ''}');
    if (match == null) return null;
    final min = double.tryParse(match.group(1) ?? '');
    final max = double.tryParse(match.group(2) ?? '');
    final range = SearchDoubleRange(min: min, max: max);
    return range.isValid ? range : null;
  }

  List<int> parseWeekdays() {
    final value = _firstValue('weekday');
    if (value == null || value.isEmpty) return [];
    return value
        .split(',')
        .map((e) => int.tryParse(e))
        .whereType<int>()
        .where((e) => e >= 1 && e <= 7)
        .toSet()
        .toList()
      ..sort();
  }

  String parseKeywords() {
    return query
        .replaceAll(_tokenRegExp(), ' ')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
  }

  bool hasSortSyntax() {
    return _firstValue('sort') != null;
  }

  String removeSort() {
    return query
        .replaceAllMapped(
            _tokenRegExp(),
            (match) => match.group(0)!.trim().toLowerCase().startsWith('sort:')
                ? ''
                : match.group(0)!)
        .trim();
  }

  String updateSort(String sortValue) {
    final state = toFilterState().copyWith(sort: sortValue);
    return fromFilterState(state);
  }

  SearchFilterState toFilterState() {
    return SearchFilterState(
      id: parseId() ?? '',
      keyword: parseKeywords(),
      tags: parseTags(),
      sort: parseSort() ?? 'heat',
      explicitSort: hasSortSyntax(),
      season: parseSeason() ?? '',
      dateRange: parseDateRange(),
      rankRange: parseRankRange(),
      scoreRange: parseScoreRange(),
      weekdays: parseWeekdays(),
    );
  }

  static String fromFilterState(SearchFilterState state) {
    final tokens = <String>[];
    if (state.id.isNotEmpty) tokens.add('id:${state.id}');
    final keyword = state.keyword.trim();
    if (keyword.isNotEmpty) tokens.add(keyword);
    for (final tag in state.tags) {
      final normalized = tag.trim();
      if (normalized.isNotEmpty) {
        tokens.add(
            'tag:${RegExp(r'[\s:"\\]').hasMatch(normalized) ? jsonEncode(normalized) : normalized}');
      }
    }
    if (state.sort.isNotEmpty && (state.sort != 'heat' || state.explicitSort)) {
      tokens.add('sort:${state.sort}');
    }
    if (state.season.isNotEmpty) {
      tokens.add('season:${state.season}');
    } else if (state.dateRange?.isValid == true) {
      tokens.add('date:${state.dateRange!.start}..${state.dateRange!.end}');
    }
    if (state.rankRange?.isValid == true) {
      tokens.add('rank:${state.rankRange!.toToken()}');
    }
    if (state.scoreRange?.isValid == true) {
      tokens.add('score:${state.scoreRange!.toToken()}');
    }
    if (state.weekdays.isNotEmpty) {
      final weekdays = state.weekdays.toSet().toList()..sort();
      tokens.add('weekday:${weekdays.join(',')}');
    }
    return tokens.join(' ').trim();
  }

  static SearchDateRange? seasonToDateRange(String season) {
    final match =
        RegExp(r'^(\d{4})Q([1-4])$', caseSensitive: false).firstMatch(season);
    if (match == null) return null;
    final year = int.parse(match.group(1)!);
    final quarter = int.parse(match.group(2)!);
    final startMonth = (quarter - 1) * 3 + 1;
    final start = DateTime(year, startMonth, 1);
    final end = DateTime(year, startMonth + 3, 0);
    return SearchDateRange(
      start: formatDateTime(start),
      end: formatDateTime(end),
    );
  }

  static RegExp _tokenRegExp() {
    return RegExp(
      r'(?:^|\s)?(?:' +
          _fieldNames +
          r'):(?:"(?:\\.|[^"\\])*"|[^\s]*?)(?=(?:\s|$)|(?:' +
          _fieldNames +
          r'):)',
      caseSensitive: false,
    );
  }

  static String? _decodeTag(String value) {
    if (!value.startsWith('"')) return value;
    try {
      final decoded = jsonDecode(value);
      return decoded is String ? decoded : null;
    } catch (_) {
      return null;
    }
  }

  Iterable<String> _values(String field) sync* {
    for (final match in _tokenRegExp().allMatches(query)) {
      final token = match.group(0)!.trim();
      final separator = token.indexOf(':');
      if (token.substring(0, separator).toLowerCase() == field) {
        yield token.substring(separator + 1);
      }
    }
  }

  String? _firstValue(String field) {
    for (final value in _values(field)) {
      return value;
    }
    return null;
  }
}
