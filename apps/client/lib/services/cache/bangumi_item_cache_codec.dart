import 'package:kazumi/modules/bangumi/bangumi_item.dart';

class BangumiItemCacheCodec {
  const BangumiItemCacheCodec();

  BangumiItem? decode(dynamic raw) {
    try {
      if (raw is Map) {
        return BangumiItem.fromJson(Map<String, dynamic>.from(raw));
      }
    } catch (_) {}
    return null;
  }

  Map<String, dynamic> encode(BangumiItem item) {
    final ratingCount = <String, int>{};
    for (var index = 0; index < 10; index++) {
      ratingCount['${index + 1}'] =
          index < item.votesCount.length ? item.votesCount[index] : 0;
    }
    return {
      'id': item.id,
      'type': item.type,
      'name': item.name,
      'name_cn': item.nameCn,
      'summary': item.summary,
      'date': item.airDate,
      'images': item.images,
      'tags': item.tags.map((tag) => tag.toJson()).toList(),
      'infobox': item.alias.isEmpty
          ? const []
          : [
              {'key': '别名', 'value': item.alias},
            ],
      'rating': {
        'rank': item.rank,
        'score': item.ratingScore,
        'total': item.votes,
        'count': ratingCount,
      },
      'info': item.info,
      'status': item.animeStatus,
      'eps': item.episodes,
      'aired_eps': item.airedEpisodes,
    };
  }
}
