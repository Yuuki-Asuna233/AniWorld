import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/pages/download/download_controller.dart';
import 'package:kazumi/modules/download/download_module.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';
import 'package:kazumi/services/download/download_manager.dart';

void main() {
  test('AniWorld retries always refresh short-lived source URLs', () {
    expect(
      shouldRefreshDownloadSource(
        'AniWorld',
        'aniworld://oi-play?msg=test&n=1&j=3',
      ),
      isTrue,
    );
  });

  test('stable plugin URLs may be resumed directly', () {
    expect(
      shouldRefreshDownloadSource('ExamplePlugin', 'https://example/ep/3'),
      isFalse,
    );
    expect(shouldRefreshDownloadSource('AniWorld', ''), isFalse);
  });

  test('existing completed episode is protected even when AniWorld URL changes',
      () {
    final episode = DownloadEpisode(
      3,
      '第03集',
      0,
      DownloadStatus.completed,
      1,
      1,
      1,
      '/local/video.mp4',
      '/local',
      'https://old.example/video.mp4',
      DateTime(2026),
      '',
      100,
      'aniworld://oi-play?msg=old&n=1&j=3',
    );
    final record =
        DownloadRecord(1, 'test', '', 'AniWorld', {3: episode}, DateTime(2026));

    expect(hasExistingDownloadEpisode(record, 3), isTrue);
    expect(hasExistingDownloadEpisode(record, 4), isFalse);
  });

  test('AniWorld MP4 bypasses the M3U8 text probe', () {
    expect(
      isAniWorldDirectDownload(
        'video/mp4',
        'https://cdn.example/video/episode.mp4',
      ),
      isTrue,
    );
    expect(
      isAniWorldDirectDownload(
        'application/vnd.apple.mpegurl',
        'https://cdn.example/video/episode.m3u8',
      ),
      isFalse,
    );
  });

  test('AniWorld rejects image URLs returned as playback URLs', () {
    expect(
      isPlausibleAniWorldPlaybackUrl(
        'https://cdn.example/cover~tplv-test-image.image?token=1',
      ),
      isFalse,
    );
    expect(
      isPlausibleAniWorldPlaybackUrl(
        'https://cdn.example/video/tos/episode/?token=1',
      ),
      isTrue,
    );
  });

  test('direct downloader rejects non-media response content types', () {
    expect(isPlausibleDirectMediaContentType('image/webp'), isFalse);
    expect(
        isPlausibleDirectMediaContentType('text/html; charset=utf-8'), isFalse);
    expect(isPlausibleDirectMediaContentType('video/mp4'), isTrue);
    expect(
        isPlausibleDirectMediaContentType('application/octet-stream'), isTrue);
  });
}
