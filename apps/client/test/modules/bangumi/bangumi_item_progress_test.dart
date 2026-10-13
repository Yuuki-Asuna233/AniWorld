import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';

BangumiItem item({
  required String status,
  required int episodes,
  required int airedEpisodes,
}) {
  return BangumiItem(
    id: 1,
    type: 2,
    name: 'Anime',
    nameCn: '动漫',
    summary: '',
    airDate: '2026-07-04',
    airWeekday: 6,
    rank: 0,
    images: const {},
    tags: const [],
    alias: const [],
    ratingScore: 0,
    votes: 0,
    votesCount: const [],
    info: '',
    animeStatus: status,
    episodes: episodes,
    airedEpisodes: airedEpisodes,
  );
}

void main() {
  test('formats finished anime with total episode count', () {
    expect(
      item(status: 'FINISHED', episodes: 12, airedEpisodes: 12)
          .releaseProgressText,
      '2026·12全',
    );
  });

  test('formats releasing anime with current aired episode', () {
    expect(
      item(status: 'RELEASING', episodes: 12, airedEpisodes: 3)
          .releaseProgressText,
      '2026·更新至3',
    );
  });

  test('falls back to the year when status is unavailable', () {
    expect(
      item(status: '', episodes: 0, airedEpisodes: 0).releaseProgressText,
      '2026',
    );
  });
}
