import 'package:kazumi/services/storage/storage.dart';
import 'package:kazumi/modules/download/download_module.dart';
import 'package:kazumi/services/logging/logger.dart';

abstract class IDownloadRepository {
  List<DownloadRecord> getAllRecords();
  DownloadRecord? getRecord(String key);
  Future<void> putRecord(DownloadRecord record);
  Future<void> deleteRecord(String key);
  Future<void> updateEpisode(
      String recordKey, int episodeNumber, DownloadEpisode episode);
  Future<void> deleteEpisode(String recordKey, int episodeNumber);
  bool getForceAdBlocker();

  /// 获取指定番剧的下载记录
  ///
  /// [bangumiId] 番剧 ID
  /// [pluginName] 插件名称
  DownloadRecord? getRecordByBangumiId(int bangumiId, String pluginName);

  /// 获取指定集数的下载信息
  ///
  /// [bangumiId] 番剧 ID
  /// [pluginName] 插件名称
  /// [episodeNumber] 集数编号
  DownloadEpisode? getEpisode(
      int bangumiId, String pluginName, int episodeNumber);

  /// 获取已完成下载的集数列表
  ///
  /// [bangumiId] 番剧 ID
  /// [pluginName] 插件名称
  /// 返回所有已完成下载的集数
  List<DownloadEpisode> getCompletedEpisodes(int bangumiId, String pluginName);

  /// 通过集数页面 URL 查找下载记录
  ///
  /// [bangumiId] 番剧 ID
  /// [pluginName] 插件名称
  /// [episodePageUrl] 集数页面 URL
  /// 当 URL 为空时返回 null（兼容旧数据）
  DownloadEpisode? getEpisodeByUrl(
      int bangumiId, String pluginName, String episodePageUrl);
}

class DownloadRepository implements IDownloadRepository {
  final _downloadsBox = GStorage.downloads;

  @override
  List<DownloadRecord> getAllRecords() {
    final List<DownloadRecord> result = [];
    try {
      for (final key in _downloadsBox.keys) {
        try {
          final record = _downloadsBox.get(key);
          if (record != null) {
            // Merge in-memory progress into the record
            final cachedEpisodes = _progressCache[key as String];
            if (cachedEpisodes != null) {
              for (final entry in cachedEpisodes.entries) {
                record.episodes[entry.key] = entry.value;
              }
            }
            result.add(record);
          }
        } catch (e) {
          // 单条记录读取失败，跳过该记录并记录日志
          KazumiLogger().w(
              'DownloadRepository: failed to read record key=$key, skipping',
              error: e);
        }
      }
    } catch (e) {
      KazumiLogger().w('DownloadRepository: get all records failed', error: e);
    }
    return result;
  }

  @override
  DownloadRecord? getRecord(String key) {
    try {
      final record = _downloadsBox.get(key);
      if (record != null) {
        // Merge in-memory progress into the record
        final cachedEpisodes = _progressCache[key];
        if (cachedEpisodes != null) {
          for (final entry in cachedEpisodes.entries) {
            record.episodes[entry.key] = entry.value;
          }
        }
      }
      return record;
    } catch (e) {
      KazumiLogger()
          .w('DownloadRepository: get record failed. key=$key', error: e);
      return null;
    }
  }

  @override
  Future<void> putRecord(DownloadRecord record) async {
    try {
      await _downloadsBox.put(record.key, record);
      await _downloadsBox.flush();
    } catch (e, stackTrace) {
      KazumiLogger().e(
        'DownloadRepository: put record failed. key=${record.key}',
        error: e,
        stackTrace: stackTrace,
      );
      rethrow;
    }
  }

  @override
  Future<void> deleteRecord(String key) async {
    try {
      final pendingWrites = _episodeWriteQueues.entries
          .where((entry) => entry.key.startsWith('${key}_'))
          .map((entry) => entry.value.catchError((_) {}))
          .toList();
      _progressCache.remove(key);
      _lastPersistedStatus.removeWhere((k, v) => k.startsWith('${key}_'));
      if (pendingWrites.isNotEmpty) await Future.wait(pendingWrites);
      _episodeWriteQueues.removeWhere((k, v) => k.startsWith('${key}_'));
      await _downloadsBox.delete(key);
      await _downloadsBox.flush();
    } catch (e, stackTrace) {
      KazumiLogger().e(
        'DownloadRepository: delete record failed. key=$key',
        error: e,
        stackTrace: stackTrace,
      );
      rethrow;
    }
  }

  /// Track last persisted status to avoid unnecessary writes
  final Map<String, int> _lastPersistedStatus = {};

  /// Track last persist timestamp (ms) for throttled progress writes
  final Map<String, int> _lastPersistTime = {};

  /// In-memory cache for progress updates (not persisted until status changes)
  final Map<String, Map<int, DownloadEpisode>> _progressCache = {};
  final Map<String, Future<void>> _episodeWriteQueues = {};

  DownloadEpisode _snapshotEpisode(DownloadEpisode episode) => DownloadEpisode(
        episode.episodeNumber,
        episode.episodeName,
        episode.road,
        episode.status,
        episode.progressPercent,
        episode.totalSegments,
        episode.downloadedSegments,
        episode.localM3u8Path,
        episode.downloadDirectory,
        episode.networkM3u8Url,
        episode.completedAt,
        episode.errorMessage,
        episode.totalBytes,
        episode.episodePageUrl,
        danmakuData: episode.danmakuData,
        danDanBangumiID: episode.danDanBangumiID,
      );

  @override
  Future<void> updateEpisode(
      String recordKey, int episodeNumber, DownloadEpisode episode) async {
    try {
      final snapshot = _snapshotEpisode(episode);
      _progressCache.putIfAbsent(recordKey, () => {});
      _progressCache[recordKey]![episodeNumber] = snapshot;

      // Persist to Hive on status change (mandatory) and also periodically
      // while downloading, so progress is never lost on a crash. A completed
      // download is always persisted immediately so it stays playable.
      final statusKey = '${recordKey}_$episodeNumber';
      final lastStatus = _lastPersistedStatus[statusKey];
      final statusChanged = lastStatus != snapshot.status;
      final nowMs = DateTime.now().millisecondsSinceEpoch;
      final lastPersist = _lastPersistTime[statusKey] ?? 0;
      final timedOut = nowMs - lastPersist > 2000;
      final shouldPersist = statusChanged ||
          snapshot.status == DownloadStatus.completed ||
          timedOut;

      if (shouldPersist) {
        _lastPersistedStatus[statusKey] = snapshot.status;
        _lastPersistTime[statusKey] = nowMs;
        final previous = _episodeWriteQueues[statusKey] ?? Future.value();
        final write = previous.catchError((_) {}).then((_) async {
          final latest = _progressCache[recordKey]?[episodeNumber];
          if (latest == null || latest.status != snapshot.status) return;
          final record = _downloadsBox.get(recordKey);
          if (record == null) return;
          record.episodes[episodeNumber] = _snapshotEpisode(latest);
          await _downloadsBox.put(recordKey, record);
          await _downloadsBox.flush();
        });
        _episodeWriteQueues[statusKey] = write;
        try {
          await write;
        } finally {
          if (identical(_episodeWriteQueues[statusKey], write)) {
            _episodeWriteQueues.remove(statusKey);
          }
        }
      }
    } catch (e, stackTrace) {
      KazumiLogger().e(
        'DownloadRepository: update episode failed. key=$recordKey, ep=$episodeNumber',
        error: e,
        stackTrace: stackTrace,
      );
      rethrow;
    }
  }

  /// Get episode with in-memory progress if available
  DownloadEpisode? getEpisodeWithProgress(String recordKey, int episodeNumber) {
    // Check in-memory cache first
    final cached = _progressCache[recordKey]?[episodeNumber];
    if (cached != null) return cached;

    // Fall back to Hive
    final record = getRecord(recordKey);
    return record?.episodes[episodeNumber];
  }

  @override
  bool getForceAdBlocker() {
    return GStorage.getSetting(SettingsKeys.forceAdBlocker);
  }

  @override
  Future<void> deleteEpisode(String recordKey, int episodeNumber) async {
    try {
      final statusKey = '${recordKey}_$episodeNumber';
      final pendingWrite = _episodeWriteQueues[statusKey];
      _progressCache[recordKey]?.remove(episodeNumber);
      _lastPersistedStatus.remove(statusKey);
      if (pendingWrite != null) await pendingWrite.catchError((_) {});
      _episodeWriteQueues.remove(statusKey);
      final record = _downloadsBox.get(recordKey);
      if (record == null) return;
      record.episodes.remove(episodeNumber);
      if (record.episodes.isEmpty) {
        await _downloadsBox.delete(recordKey);
        _progressCache.remove(recordKey);
        _lastPersistedStatus
            .removeWhere((k, v) => k.startsWith('${recordKey}_'));
        _episodeWriteQueues
            .removeWhere((k, v) => k.startsWith('${recordKey}_'));
      } else {
        await _downloadsBox.put(recordKey, record);
      }
      await _downloadsBox.flush();
    } catch (e, stackTrace) {
      KazumiLogger().e(
        'DownloadRepository: delete episode failed. key=$recordKey, ep=$episodeNumber',
        error: e,
        stackTrace: stackTrace,
      );
      rethrow;
    }
  }

  @override
  DownloadRecord? getRecordByBangumiId(int bangumiId, String pluginName) {
    final key = '${pluginName}_$bangumiId';
    return getRecord(key);
  }

  @override
  DownloadEpisode? getEpisode(
      int bangumiId, String pluginName, int episodeNumber) {
    final record = getRecordByBangumiId(bangumiId, pluginName);
    return record?.episodes[episodeNumber];
  }

  @override
  List<DownloadEpisode> getCompletedEpisodes(int bangumiId, String pluginName) {
    final record = getRecordByBangumiId(bangumiId, pluginName);
    if (record == null) return [];

    return record.episodes.values
        .where((e) => e.status == DownloadStatus.completed)
        .toList()
      ..sort((a, b) => a.episodeNumber.compareTo(b.episodeNumber));
  }

  @override
  DownloadEpisode? getEpisodeByUrl(
      int bangumiId, String pluginName, String episodePageUrl) {
    if (episodePageUrl.isEmpty) return null;
    final record = getRecordByBangumiId(bangumiId, pluginName);
    if (record == null) return null;
    for (final episode in record.episodes.values) {
      if (episode.episodePageUrl == episodePageUrl) {
        return episode;
      }
    }
    return null;
  }
}
