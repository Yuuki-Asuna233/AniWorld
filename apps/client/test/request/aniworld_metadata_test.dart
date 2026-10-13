import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/pages/search/search_result_identity.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';

void main() {
  test('uses AniList for air date, score and popularity', () {
    final item = AniWorldApi.oiToBangumi({
      'anilistId': 1,
      'title': '婚姻剧毒',
      'airDate': '2026-04-07',
      'ratingSource': 'anilist',
      'aniScore': 75,
      'aniPopularity': 73137,
      'ratingScore': 75,
      'ratingTotal': 73137,
    });

    expect(item.airDate, '2026-04-07');
    expect(item.ratingScore, 7.5);
    expect(item.votes, 73137);
    expect(item.votesCount, isEmpty);
    expect(item.info, contains('"ratingSource":"anilist"'));
  });

  test('keeps distinct cours that share one AniList ID', () {
    final loss = AniWorldApi.oiToBangumi({
      'anilistId': 189046,
      'title': 'Re：从零开始的异世界生活 第四季 丧失篇',
    });
    final recapture = AniWorldApi.oiToBangumi({
      'anilistId': 189046,
      'title': 'Re：从零开始的异世界生活 第四季 夺还篇',
    });

    final results = deduplicateSearchResults([recapture, loss]);

    expect(results, hasLength(2));
    expect(results.map((item) => item.nameCn), contains(loss.nameCn));
    expect(results.map((item) => item.nameCn), contains(recapture.nameCn));
    expect(loss.heroTag, isNot(recapture.heroTag));
  });

  test('labels AniList popularity without treating it as rating voters', () {
    final item = AniWorldApi.oiToBangumi({
      'anilistId': 1,
      'title': 'Fallback',
      'aniScore': 75,
      'aniPopularity': 73137,
    });

    expect(item.ratingScore, 7.5);
    expect(item.votes, 73137);
    expect(item.info, contains('"ratingSource":"anilist"'));
  });

  test('keeps released progress separate from an unknown total', () {
    final item = AniWorldApi.oiToBangumi({
      'anilistId': 171110,
      'title': '小书痴的下克上 领主的养女',
      'episodes': '?',
      'releasedEpisodes': 12,
      'nextAiringEpisode': 13,
    });

    expect(item.info, contains('"episodes":"?"'));
    expect(item.info, contains('"releasedEpisodes":12'));
    expect(item.info, contains('"nextAiringEpisode":13'));
    expect(item.animeStatus, 'RELEASING');
    expect(item.episodes, 0);
    expect(item.airedEpisodes, 12);
    expect(item.releaseProgressText, isEmpty);
  });

  test('maps finished search metadata to the card progress label', () {
    final item = AniWorldApi.oiToBangumi({
      'anilistId': 154587,
      'title': '葬送的芙莉莲',
      'seasonYear': 2023,
      'startDate': {'year': 2023, 'month': 9, 'day': 29},
      'status': 'FINISHED',
      'episodes': 28,
      'releasedEpisodes': 28,
    });

    expect(item.animeStatus, 'FINISHED');
    expect(item.episodes, 28);
    expect(item.airedEpisodes, 28);
    expect(item.releaseProgressText, '2023·28全');
  });

  test('maps releasing search metadata to the current episode label', () {
    final item = AniWorldApi.oiToBangumi({
      'anilistId': 209907,
      'title': '葬送的芙莉莲 第二季',
      'seasonYear': 2026,
      'status': 'RELEASING',
      'episodes': 10,
      'nextAiring': {'episode': 4, 'time': 1780000000},
    });

    expect(item.animeStatus, 'RELEASING');
    expect(item.episodes, 10);
    expect(item.airedEpisodes, 3);
    expect(item.releaseProgressText, '2026·更新至3');
  });
}
