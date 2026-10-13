import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/modules/collect/collect_type.dart';
import 'package:kazumi/modules/notifications/update_notification.dart';

BangumiItem _item({
  int id = 1,
  String status = 'RELEASING',
  int airedEpisodes = 3,
}) {
  return BangumiItem(
    id: id,
    type: 2,
    name: 'Test Anime',
    nameCn: '测试番剧',
    summary: 'summary',
    airDate: '2026-07-01',
    airWeekday: 3,
    rank: 10,
    images: const {'large': 'https://example.com/cover.jpg'},
    tags: const [],
    alias: const [],
    ratingScore: 8.2,
    votes: 100,
    votesCount: const [],
    info: '{}',
    animeStatus: status,
    episodes: 12,
    airedEpisodes: airedEpisodes,
  );
}

void main() {
  test('only watching and plan-to-watch collections receive reminders', () {
    expect(isTrackedForUpdateReminder(CollectType.watching.value), isTrue);
    expect(isTrackedForUpdateReminder(CollectType.planToWatch.value), isTrue);
    expect(isTrackedForUpdateReminder(CollectType.onHold.value), isFalse);
    expect(isTrackedForUpdateReminder(CollectType.watched.value), isFalse);
    expect(isTrackedForUpdateReminder(CollectType.abandoned.value), isFalse);
  });

  test('finished anime is not considered currently releasing', () {
    expect(isCurrentlyReleasing(_item()), isTrue);
    expect(
      isCurrentlyReleasing(_item(status: 'FINISHED')),
      isFalse,
    );
  });

  test('unread updates for the same anime merge into one batch', () {
    final first = mergeUpdateNotification(
      existing: null,
      bangumiItem: _item(airedEpisodes: 4),
      previousEpisode: 3,
      latestEpisode: 4,
      updatedAtMs: 1000,
    );
    final merged = mergeUpdateNotification(
      existing: first,
      bangumiItem: _item(airedEpisodes: 6),
      previousEpisode: 4,
      latestEpisode: 6,
      updatedAtMs: 2000,
    );

    expect(merged.firstEpisode, 4);
    expect(merged.latestEpisode, 6);
    expect(merged.updateCount, 3);
    expect(merged.statusText, '连续更新3集 · 已更新至第6集');
  });

  test('a new update after reading starts a fresh batch', () {
    final read = mergeUpdateNotification(
      existing: null,
      bangumiItem: _item(airedEpisodes: 4),
      previousEpisode: 3,
      latestEpisode: 4,
      updatedAtMs: 1000,
    ).copyWith(isRead: true);
    final next = mergeUpdateNotification(
      existing: read,
      bangumiItem: _item(airedEpisodes: 5),
      previousEpisode: 4,
      latestEpisode: 5,
      updatedAtMs: 2000,
    );

    expect(next.firstEpisode, 5);
    expect(next.latestEpisode, 5);
    expect(next.updateCount, 1);
    expect(next.statusText, '已更新至第5集');
  });

  test('notification round trips and uses the required greeting', () {
    final notification = UpdateNotificationItem(
      bangumiItem: _item(),
      firstEpisode: 3,
      latestEpisode: 3,
      updateCount: 1,
      updatedAtMs: 1234,
      isRead: false,
    );
    final decoded = UpdateNotificationItem.fromJson(notification.toJson());

    expect(decoded.animeId, 1);
    expect(decoded.bangumiItem.animeStatus, 'RELEASING');
    expect(decoded.bangumiItem.airedEpisodes, 3);
    expect(
      decoded.messageFor('小明'),
      'hi~小明，您追的番[测试番剧]又双叒叕更新了，请查收~~',
    );
    expect(
      decoded.messageFor(''),
      'hi~动漫迷，您追的番[测试番剧]又双叒叕更新了，请查收~~',
    );
  });
}
