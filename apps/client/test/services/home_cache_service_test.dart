import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/modules/bangumi/bangumi_tag.dart';
import 'package:kazumi/services/cache/home_cache_service.dart';

BangumiItem item(int id, String title) {
  return BangumiItem(
    id: id,
    type: 2,
    name: 'Anime $id',
    nameCn: title,
    summary: 'Summary',
    airDate: '2026-07-04',
    airWeekday: 6,
    rank: 10,
    images: {
      'large': 'https://example.com/$id.jpg',
      'common': '',
      'medium': '',
      'small': '',
      'grid': '',
    },
    tags: [BangumiTag(name: '动画', count: 1, totalCount: 1)],
    alias: ['Alias $id'],
    ratingScore: 8.5,
    votes: 1234,
    votesCount: List<int>.generate(10, (index) => index),
    info: 'Info',
    animeStatus: 'RELEASING',
    episodes: 12,
    airedEpisodes: 3,
  );
}

void main() {
  late Directory temporaryDirectory;
  late DateTime now;

  setUp(() async {
    temporaryDirectory = await Directory.systemTemp.createTemp(
      'aniworld-home-cache-test-',
    );
    now = DateTime.utc(2026, 7, 4);
  });

  tearDown(() async {
    if (await temporaryDirectory.exists()) {
      await temporaryDirectory.delete(recursive: true);
    }
  });

  HomeCacheService service() => HomeCacheService(
        temporaryDirectoryProvider: () async => temporaryDirectory,
        now: () => now,
      );

  test('persists and restores home sections for the same server', () async {
    final writer = service();
    final snapshot = HomeCacheSnapshot(
      recommend: [item(1, '推荐番剧')],
      today: [item(2, '今日更新')],
      newSeason: [item(3, '新番')],
      hot: [item(4, '热门')],
      classic: [item(5, '经典')],
      movies: [item(6, '剧场版')],
    );

    await writer.save(
      server: 'HTTP://EXAMPLE.COM:3000/',
      snapshot: snapshot,
    );
    final restored = await service().load(
      server: 'http://example.com:3000',
    );

    expect(restored, isNotNull);
    expect(restored!.today.single.nameCn, '今日更新');
    expect(restored.hot.single.id, 4);
    expect(restored.movies.single.id, 6);
    expect(restored.movies.single.releaseProgressText, '2026·更新至3');
    expect(restored.hot.single.ratingScore, 8.5);
    expect(restored.hot.single.alias, ['Alias 4']);
  });

  test('does not reuse cache after switching servers', () async {
    final cache = service();
    await cache.save(
      server: 'http://server-a:3000',
      snapshot: HomeCacheSnapshot(
        recommend: [item(1, '推荐番剧')],
        today: const [],
        newSeason: const [],
        hot: const [],
        classic: const [],
        movies: const [],
      ),
    );

    expect(await cache.load(server: 'http://server-b:3000'), isNull);
  });

  test('expires cache after seven days', () async {
    final cache = service();
    await cache.save(
      server: 'http://example.com:3000',
      snapshot: HomeCacheSnapshot(
        recommend: [item(1, '推荐番剧')],
        today: const [],
        newSeason: const [],
        hot: const [],
        classic: const [],
        movies: const [],
      ),
    );
    now = now.add(const Duration(days: 8));

    expect(await cache.load(server: 'http://example.com:3000'), isNull);
  });
}
