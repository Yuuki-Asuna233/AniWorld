import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/modules/bangumi/bangumi_tag.dart';
import 'package:kazumi/modules/collect/collect_type.dart';

class TrackedAnimeBaseline {
  const TrackedAnimeBaseline({
    required this.animeId,
    required this.lastEpisode,
    required this.status,
  });

  final int animeId;
  final int lastEpisode;
  final String status;

  Map<String, dynamic> toJson() => {
        'animeId': animeId,
        'lastEpisode': lastEpisode,
        'status': status,
      };

  factory TrackedAnimeBaseline.fromJson(Map<String, dynamic> json) {
    return TrackedAnimeBaseline(
      animeId: _asInt(json['animeId']),
      lastEpisode: _asInt(json['lastEpisode']),
      status: '${json['status'] ?? ''}',
    );
  }
}

class UpdateNotificationItem {
  const UpdateNotificationItem({
    required this.bangumiItem,
    required this.firstEpisode,
    required this.latestEpisode,
    required this.updateCount,
    required this.updatedAtMs,
    required this.isRead,
  });

  final BangumiItem bangumiItem;
  final int firstEpisode;
  final int latestEpisode;
  final int updateCount;
  final int updatedAtMs;
  final bool isRead;

  int get animeId => bangumiItem.id;

  String get title =>
      bangumiItem.nameCn.isNotEmpty ? bangumiItem.nameCn : bangumiItem.name;

  String messageFor(String username) {
    final displayName = username.trim().isEmpty ? '动漫迷' : username.trim();
    return 'hi~$displayName，您追的番[$title]又双叒叕更新了，请查收~~';
  }

  String get statusText => updateCount > 1
      ? '连续更新$updateCount集 · 已更新至第$latestEpisode集'
      : '已更新至第$latestEpisode集';

  UpdateNotificationItem copyWith({
    BangumiItem? bangumiItem,
    int? firstEpisode,
    int? latestEpisode,
    int? updateCount,
    int? updatedAtMs,
    bool? isRead,
  }) {
    return UpdateNotificationItem(
      bangumiItem: bangumiItem ?? this.bangumiItem,
      firstEpisode: firstEpisode ?? this.firstEpisode,
      latestEpisode: latestEpisode ?? this.latestEpisode,
      updateCount: updateCount ?? this.updateCount,
      updatedAtMs: updatedAtMs ?? this.updatedAtMs,
      isRead: isRead ?? this.isRead,
    );
  }

  Map<String, dynamic> toJson() => {
        'bangumiItem': _bangumiItemToJson(bangumiItem),
        'firstEpisode': firstEpisode,
        'latestEpisode': latestEpisode,
        'updateCount': updateCount,
        'updatedAtMs': updatedAtMs,
        'isRead': isRead,
      };

  factory UpdateNotificationItem.fromJson(Map<String, dynamic> json) {
    return UpdateNotificationItem(
      bangumiItem: _bangumiItemFromJson(
        Map<String, dynamic>.from(json['bangumiItem'] as Map),
      ),
      firstEpisode: _asInt(json['firstEpisode']),
      latestEpisode: _asInt(json['latestEpisode']),
      updateCount: _asInt(json['updateCount']).clamp(1, 9999),
      updatedAtMs: _asInt(json['updatedAtMs']),
      isRead: json['isRead'] == true,
    );
  }
}

bool isTrackedForUpdateReminder(int collectType) {
  return collectType == CollectType.watching.value ||
      collectType == CollectType.planToWatch.value;
}

bool isCurrentlyReleasing(BangumiItem item) {
  return item.animeStatus.trim().toUpperCase() == 'RELEASING';
}

UpdateNotificationItem mergeUpdateNotification({
  required UpdateNotificationItem? existing,
  required BangumiItem bangumiItem,
  required int previousEpisode,
  required int latestEpisode,
  required int updatedAtMs,
}) {
  final delta = (latestEpisode - previousEpisode).clamp(1, 9999);
  final shouldContinueUnreadBatch = existing != null && !existing.isRead;
  final updateCount = shouldContinueUnreadBatch
      ? (existing.updateCount + delta).clamp(1, 9999)
      : delta;
  final firstEpisode = shouldContinueUnreadBatch
      ? existing.firstEpisode
      : latestEpisode - delta + 1;
  return UpdateNotificationItem(
    bangumiItem: bangumiItem,
    firstEpisode: firstEpisode,
    latestEpisode: latestEpisode,
    updateCount: updateCount,
    updatedAtMs: updatedAtMs,
    isRead: false,
  );
}

int _asInt(dynamic value) {
  return value is num ? value.toInt() : int.tryParse('$value') ?? 0;
}

Map<String, dynamic> _bangumiItemToJson(BangumiItem item) => {
      'id': item.id,
      'type': item.type,
      'name': item.name,
      'nameCn': item.nameCn,
      'summary': item.summary,
      'airDate': item.airDate,
      'airWeekday': item.airWeekday,
      'rank': item.rank,
      'images': item.images,
      'tags': item.tags.map((tag) => tag.toJson()).toList(),
      'alias': item.alias,
      'ratingScore': item.ratingScore,
      'votes': item.votes,
      'votesCount': item.votesCount,
      'info': item.info,
      'animeStatus': item.animeStatus,
      'episodes': item.episodes,
      'airedEpisodes': item.airedEpisodes,
    };

BangumiItem _bangumiItemFromJson(Map<String, dynamic> json) {
  return BangumiItem(
    id: _asInt(json['id']),
    type: _asInt(json['type']),
    name: '${json['name'] ?? ''}',
    nameCn: '${json['nameCn'] ?? ''}',
    summary: '${json['summary'] ?? ''}',
    airDate: '${json['airDate'] ?? ''}',
    airWeekday: _asInt(json['airWeekday']),
    rank: _asInt(json['rank']),
    images: Map<String, String>.from((json['images'] as Map?) ?? const {}),
    tags: ((json['tags'] as List?) ?? const [])
        .whereType<Map>()
        .map((tag) => BangumiTag.fromJson(Map<String, dynamic>.from(tag)))
        .toList(),
    alias: ((json['alias'] as List?) ?? const [])
        .map((alias) => alias.toString())
        .toList(),
    ratingScore: (json['ratingScore'] as num?)?.toDouble() ?? 0,
    votes: _asInt(json['votes']),
    votesCount:
        ((json['votesCount'] as List?) ?? const []).map(_asInt).toList(),
    info: '${json['info'] ?? ''}',
    animeStatus: '${json['animeStatus'] ?? ''}',
    episodes: _asInt(json['episodes']),
    airedEpisodes: _asInt(json['airedEpisodes']),
  );
}
