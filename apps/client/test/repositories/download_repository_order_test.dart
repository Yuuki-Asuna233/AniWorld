import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hive_ce/hive.dart';
import 'package:kazumi/modules/download/download_module.dart';
import 'package:kazumi/repositories/download_repository.dart';
import 'package:kazumi/services/storage/storage.dart';

void main() {
  late Directory directory;

  setUp(() async {
    directory =
        await Directory.systemTemp.createTemp('aniworld-download-test-');
    Hive.init(directory.path);
    if (!Hive.isAdapterRegistered(7)) {
      Hive.registerAdapter(DownloadRecordAdapter());
    }
    if (!Hive.isAdapterRegistered(8)) {
      Hive.registerAdapter(DownloadEpisodeAdapter());
    }
    GStorage.downloads = await Hive.openBox<DownloadRecord>('downloads');
  });

  tearDown(() async {
    await Hive.close();
    if (await directory.exists()) await directory.delete(recursive: true);
  });

  test('completed state wins over concurrent progress persistence', () async {
    final repository = DownloadRepository();
    final episode = DownloadEpisode(
      1,
      '第01集',
      0,
      DownloadStatus.downloading,
      0,
      1,
      0,
      '',
      '/downloads/1',
      'https://example/video.mp4',
      null,
      '',
      0,
      'aniworld://oi-play?msg=test&n=1&j=1',
    );
    await repository.putRecord(
      DownloadRecord(1, 'test', '', 'AniWorld', {1: episode}, DateTime(2026)),
    );

    final writes = <Future<void>>[];
    for (var i = 1; i <= 100; i++) {
      episode.progressPercent = i / 101;
      episode.totalBytes = i * 1024;
      writes.add(repository.updateEpisode('AniWorld_1', 1, episode));
    }
    episode.status = DownloadStatus.completed;
    episode.progressPercent = 1;
    episode.downloadedSegments = 1;
    episode.localM3u8Path = '/downloads/1/video.mp4';
    episode.totalBytes = 102400;
    writes.add(repository.updateEpisode('AniWorld_1', 1, episode));

    await Future.wait(writes);
    final persisted = GStorage.downloads.get('AniWorld_1')!.episodes[1]!;
    expect(persisted.status, DownloadStatus.completed);
    expect(persisted.localM3u8Path, '/downloads/1/video.mp4');
    expect(persisted.progressPercent, 1);
  });
}
