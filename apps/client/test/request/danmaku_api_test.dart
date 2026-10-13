import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/modules/danmaku/danmaku_episode_response.dart';
import 'package:kazumi/modules/danmaku/danmaku_search_response.dart';
import 'package:kazumi/request/apis/danmaku_api.dart';

DanmakuAnime anime(int id, String title) {
  return DanmakuAnime(
    animeId: id,
    animeTitle: title,
    type: 'tvseries',
    typeDescription: 'TV动画',
    imageUrl: '',
    startDate: DateTime(2024),
    episodeCount: 12,
    rating: 0,
    isFavorited: false,
  );
}

DanmakuEpisodeResponse episodes(List<DanmakuEpisode> items) {
  return DanmakuEpisodeResponse(
    bangumiId: 1,
    episodes: items,
    errorCode: 0,
    success: true,
    errorMessage: '',
  );
}

void main() {
  group('selectDanmakuAnime', () {
    test('matches the requested season and rejects another franchise', () {
      final result = selectDanmakuAnime(
        'Re：从零开始的异世界生活 第三季',
        [
          anime(100, '进击的巨人 第三季 Part.2'),
          anime(200, 'Re：从零开始的异世界生活 第二季'),
          anime(300, 'Re:从零开始的异世界生活 第3季'),
        ],
      );

      expect(result?.animeId, 300);
    });

    test('does not silently select a different season', () {
      final result = selectDanmakuAnime(
        '进击的巨人 第三季',
        [
          anime(100, '进击的巨人 第二季'),
          anime(200, '进击的巨人 最终季'),
        ],
      );

      expect(result, isNull);
    });

    test('returns null for a low-confidence title', () {
      final result = selectDanmakuAnime(
        '葬送的芙莉莲',
        [anime(100, '不死不幸'), anime(200, '药屋少女的呢喃')],
      );

      expect(result, isNull);
    });
  });

  group('selectDanmakuEpisodeId', () {
    test('uses the actual episode ID from the API response', () {
      final result = selectDanmakuEpisodeId(
        episodes([
          DanmakuEpisode(episodeId: 91001, episodeTitle: '第1话'),
          DanmakuEpisode(episodeId: 91002, episodeTitle: '第2话'),
          DanmakuEpisode(episodeId: 91003, episodeTitle: '第3话'),
        ]),
        2,
      );

      expect(result, 91002);
    });

    test('does not mistake a resolution number for an episode number', () {
      final result = selectDanmakuEpisodeId(
        episodes([
          DanmakuEpisode(episodeId: 92001, episodeTitle: '[1080P] 第1话'),
          DanmakuEpisode(episodeId: 92002, episodeTitle: '[1080P] 第2话'),
        ]),
        2,
      );

      expect(result, 92002);
    });
  });
}
