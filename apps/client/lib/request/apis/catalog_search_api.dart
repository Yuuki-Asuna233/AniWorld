import 'package:dio/dio.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';
import 'package:kazumi/request/core/dio_factory.dart';
import 'package:kazumi/utils/search_parser.dart';

class CatalogSearchResult {
  final List<BangumiItem> items;
  final int page;
  final bool hasMore;

  const CatalogSearchResult(this.items, this.page, this.hasMore);
}

class CatalogSearchInputException implements Exception {
  const CatalogSearchInputException(this.message);
  final String message;
}

/// Exact filters belong to the local directory, not provider keyword search.
class CatalogSearchApi {
  static Future<CatalogSearchResult> search(SearchFilterState filters,
      {required int page, required Set<int> excludeIds}) async {
    final Response response;
    try {
      response =
          await DioFactory.selfBackendDio.post('/api/catalog/search', data: {
        'keyword': filters.keyword,
        if (filters.id.isNotEmpty) 'id': int.parse(filters.id),
        'tags': filters.tags,
        'sort': filters.sort,
        'season': filters.season,
        if (filters.dateRange != null) ...{
          'dateStart': filters.dateRange!.start,
          'dateEnd': filters.dateRange!.end,
        },
        if (filters.scoreRange?.min != null)
          'scoreMin': filters.scoreRange!.min,
        if (filters.scoreRange?.max != null)
          'scoreMax': filters.scoreRange!.max,
        'excludeIds': excludeIds.where((id) => id > 0).toList(),
        'page': page,
        'perPage': 24,
      });
    } on DioException catch (error) {
      final data = error.response?.data;
      if (error.response?.statusCode == 400 &&
          data is Map &&
          data['error'] is String) {
        throw CatalogSearchInputException(data['error'] as String);
      }
      rethrow;
    }
    final data = response.data;
    if (data is! Map ||
        data['results'] is! List ||
        data['page'] != page ||
        data['hasMore'] is! bool) {
      throw const FormatException('目录搜索响应格式异常');
    }
    final raw = data['results'] as List;
    if (raw.any((item) =>
        item is! Map ||
        item['anilistId'] is! int ||
        (item['anilistId'] as int) <= 0 ||
        (item['anilistId'] as int) > 2147483647 ||
        item['title'] is! String ||
        (item['title'] as String).trim().isEmpty)) {
      throw const FormatException('目录搜索结果格式异常');
    }
    final items = raw
        .map((item) =>
            AniWorldApi.oiToBangumi(Map<String, dynamic>.from(item as Map)))
        .toList();
    return CatalogSearchResult(items, page, data['hasMore'] as bool);
  }
}
