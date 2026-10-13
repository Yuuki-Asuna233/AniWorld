import 'dart:async';
import 'dart:io';
import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:kazumi/modules/download/download_module.dart';
import 'package:kazumi/request/clients/download_http_client.dart';
import 'package:kazumi/request/core/network_exception.dart';
import 'package:kazumi/utils/m3u8_parser.dart';
import 'package:kazumi/utils/m3u8_ad_filter.dart';
import 'package:kazumi/utils/format.dart' as fmt;
import 'package:kazumi/services/logging/logger.dart';
import 'package:kazumi/services/storage/storage.dart';
import 'package:path_provider/path_provider.dart';
import 'package:kazumi/services/download/segment_download.dart';
import 'package:kazumi/services/download/hls_download_manifest.dart';

class _NotM3u8Exception implements Exception {
  final String message;
  _NotM3u8Exception(this.message);
  @override
  String toString() => message;
}

class _InsufficientStorageException implements Exception {
  final int availableBytes;
  final int requiredBytes;
  _InsufficientStorageException(this.availableBytes, this.requiredBytes);
  @override
  String toString() => '存储空间不足';
}

class _IncompleteDownloadException implements Exception {
  final String message;
  const _IncompleteDownloadException(this.message);
  @override
  String toString() => message;
}

class _InvalidMediaResponseException implements Exception {
  final String contentType;
  const _InvalidMediaResponseException(this.contentType);
  @override
  String toString() => 'Invalid media response: $contentType';
}

class DownloadSourceCandidate {
  final String directUrl;
  final String fallbackUrl;
  const DownloadSourceCandidate(this.directUrl, this.fallbackUrl);
}

/// Result of attempting to recover a local download from disk on startup.
enum DownloadRestoreResult {
  /// A fully playable file (video.mp4 or playlist.m3u8) was found.
  completed,

  /// Some segments exist but the download is incomplete; resumable.
  partial,

  /// No usable local files were found.
  none,
}

typedef DownloadSourceRefresher = Future<DownloadSourceCandidate> Function();

bool isDirectDownloadComplete(int actualBytes, int expectedBytes) =>
    actualBytes > 0 && (expectedBytes <= 0 || actualBytes == expectedBytes);

bool isPlausibleDirectMediaContentType(String? contentType) {
  final normalized = (contentType ?? '').toLowerCase().split(';').first.trim();
  if (normalized.isEmpty) return true;
  return !normalized.startsWith('image/') &&
      normalized != 'text/html' &&
      normalized != 'application/json' &&
      normalized != 'application/xml' &&
      normalized != 'text/xml';
}

bool shouldContinueBoundedRange({
  required int actualBytes,
  required int totalBytes,
  required int expectedRangeEnd,
  required int previousBytes,
}) =>
    totalBytes > 0 &&
    actualBytes < totalBytes &&
    expectedRangeEnd > 0 &&
    actualBytes == expectedRangeEnd &&
    actualBytes > previousBytes;

class DownloadTask {
  final String recordKey;
  final int episodeNumber;
  CancelToken cancelToken;
  bool isPaused;
  bool isRunning = false;
  bool isRemoved = false;
  final Completer<void> completion = Completer<void>();

  DownloadTask({
    required this.recordKey,
    required this.episodeNumber,
    CancelToken? cancelToken,
    this.isPaused = false,
  }) : cancelToken = cancelToken ?? CancelToken();
}

typedef ProgressCallback = void Function(
    String recordKey, int episodeNumber, DownloadEpisode episode, double speed);

// 普通 TS 分片与 fMP4（BYTERANGE）分片（.mp4）。
final _m3u8SegmentFileNamePattern = RegExp(r'^seg_\d+\.(ts|mp4)$');

Future<int> calculateM3u8VideoBytes(String episodeDir) async {
  final dir = Directory(episodeDir);
  if (!await dir.exists()) return 0;

  var totalBytes = 0;
  await for (final entity in dir.list(followLinks: false)) {
    if (entity is! File) continue;
    final name = entity.uri.pathSegments.isNotEmpty
        ? Uri.decodeComponent(entity.uri.pathSegments.last)
        : entity.path.split(Platform.pathSeparator).last;
    if (!_m3u8SegmentFileNamePattern.hasMatch(name)) continue;

    try {
      totalBytes += await entity.length();
    } on FileSystemException {
      // Ignore transient filesystem failures while reporting display size.
    }
  }
  return totalBytes;
}

class DownloadRequest {
  final String recordKey;
  final int bangumiId;
  final String pluginName;
  final int episodeNumber;
  final String m3u8Url;
  final String fallbackUrl;
  final DownloadSourceRefresher? sourceRefresher;
  final bool directFile;
  final Map<String, String> httpHeaders;
  final bool adBlockerEnabled;
  final DownloadEpisode episode;

  const DownloadRequest({
    required this.recordKey,
    required this.bangumiId,
    required this.pluginName,
    required this.episodeNumber,
    required this.m3u8Url,
    this.fallbackUrl = '',
    this.sourceRefresher,
    this.directFile = false,
    required this.httpHeaders,
    required this.adBlockerEnabled,
    required this.episode,
  });
}

abstract class IDownloadManager {
  ProgressCallback? onProgress;

  bool isDownloading(String recordKey, int episodeNumber);
  Future<void> enqueue(DownloadRequest request);
  Future<void> enqueuePriority(DownloadRequest request);
  void pause(String recordKey, int episodeNumber);
  Future<void> resume(DownloadRequest request);
  Future<void> cancel(String recordKey, int episodeNumber);
  String? getLocalVideoPath(DownloadEpisode? episode);
  Future<DownloadRestoreResult> restoreExistingLocalDownload(
    int bangumiId,
    String pluginName,
    int episodeNumber,
    DownloadEpisode episode,
  );
  Future<void> deleteEpisodeFiles(
      int bangumiId, String pluginName, int episodeNumber);
  Future<void> deleteRecordFiles(int bangumiId, String pluginName);
  double getSpeed(String recordKey, int episodeNumber);
}

class _SpeedTracker {
  int _lastBytes = 0;
  DateTime _lastTime = DateTime.now();
  double currentSpeed = 0.0; // bytes/sec

  void update(int totalBytes) {
    final now = DateTime.now();
    final elapsed = now.difference(_lastTime).inMilliseconds;
    if (elapsed > 500) {
      final bytesDownloaded = totalBytes - _lastBytes;
      currentSpeed = bytesDownloaded / (elapsed / 1000);
      _lastBytes = totalBytes;
      _lastTime = now;
    }
  }

  void reset() {
    _lastBytes = 0;
    _lastTime = DateTime.now();
    currentSpeed = 0.0;
  }
}

class DownloadManager implements IDownloadManager {
  DownloadManager() {
    _loadSettings();
  }

  final DownloadHttpClient _http = DownloadHttpClient.instance;

  final Map<String, DownloadTask> _activeTasks = {};
  final List<DownloadRequest> _queue = [];
  final Map<String, _SpeedTracker> _speedTrackers = {};
  int maxParallelEpisodes = 2;
  int maxParallelSegments = 3;
  int _runningCount = 0;

  @override
  ProgressCallback? onProgress;

  static const _minRequiredSpace = 100 * 1024 * 1024; // 100MB minimum
  static const _storageChannel = MethodChannel('com.predidit.kazumi/storage');

  void _loadSettings() {
    final int pe =
        (GStorage.getSetting(SettingsKeys.downloadParallelEpisodes) as int? ??
            2);
    final int ps =
        (GStorage.getSetting(SettingsKeys.downloadParallelSegments) as int? ??
            3);
    // Clamp to at least 1. A value of 0 would make the download semaphore /
    // queue never advance, permanently stalling new downloads at 0%.
    maxParallelEpisodes = pe.clamp(1, 16);
    maxParallelSegments = ps.clamp(1, 16);
  }

  /// Returns available bytes, or -1 if unable to determine
  Future<int> _getAvailableStorage(String path) async {
    try {
      final result = await _storageChannel.invokeMethod<int>(
        'getAvailableStorage',
        {'path': path},
      );
      return result ?? -1;
    } on MissingPluginException {
      return -1;
    } catch (e) {
      KazumiLogger().w('DownloadManager: failed to get storage info', error: e);
      return -1;
    }
  }

  Future<void> _checkStorageSpace(String downloadDir,
      {int requiredBytes = 0}) async {
    final available = await _getAvailableStorage(downloadDir);
    if (available == -1) return; // Skip check if unable to determine

    final required = requiredBytes > 0 ? requiredBytes : _minRequiredSpace;
    if (available < required) {
      throw _InsufficientStorageException(available, required);
    }
  }

  String _getStorageErrorMessage(FileSystemException e) {
    // POSIX error code 28 = ENOSPC (No space left on device)
    if (e.osError?.errorCode == 28) {
      return '存储空间不足，请清理后重试';
    }
    // POSIX error code 13 = EACCES (Permission denied)
    if (e.osError?.errorCode == 13) {
      return '存储权限被拒绝';
    }
    // POSIX error code 30 = EROFS (Read-only file system)
    if (e.osError?.errorCode == 30) {
      return '存储为只读，无法写入';
    }
    return '存储错误: ${e.message}';
  }

  @override
  double getSpeed(String recordKey, int episodeNumber) {
    final key = _taskKey(recordKey, episodeNumber);
    return _speedTrackers[key]?.currentSpeed ?? 0.0;
  }

  String _taskKey(String recordKey, int episodeNumber) =>
      '${recordKey}_$episodeNumber';

  @override
  bool isDownloading(String recordKey, int episodeNumber) =>
      _activeTasks.containsKey(_taskKey(recordKey, episodeNumber));

  Future<String> get _downloadBaseDir async {
    final configured =
        GStorage.getSetting<String>(SettingsKeys.downloadDirectory).trim();
    if (configured.isNotEmpty) return configured;
    final appSupport = await getApplicationSupportDirectory();
    return '${appSupport.path}/downloads';
  }

  String getEpisodeDir(String downloadBase, int bangumiId, String pluginName,
      int episodeNumber) {
    return '$downloadBase/${bangumiId}_$pluginName/$episodeNumber';
  }

  @override
  Future<void> enqueue(DownloadRequest request) async {
    final key = _taskKey(request.recordKey, request.episodeNumber);
    final existing = _activeTasks[key];
    if (existing != null) {
      if (existing.isRemoved) return;
      if (!existing.isPaused && !existing.cancelToken.isCancelled) return;
      await existing.completion.future;
      // Another resume may already have installed the replacement.
      if (existing.isRemoved || _activeTasks.containsKey(key)) return;
    }
    final task = DownloadTask(
        recordKey: request.recordKey, episodeNumber: request.episodeNumber);
    _activeTasks[key] = task;
    if (_runningCount < maxParallelEpisodes) {
      _startTask(task, request);
    } else {
      request.episode.status = DownloadStatus.pending;
      _queue.add(request);
    }
  }

  @override
  Future<void> enqueuePriority(DownloadRequest request) async {
    final key = _taskKey(request.recordKey, request.episodeNumber);
    final existing = _activeTasks[key];
    if (existing != null) {
      if (existing.isRemoved) return;
      if (existing.isRunning) {
        if (!existing.cancelToken.isCancelled) return;
        await existing.completion.future;
        if (existing.isRemoved || _activeTasks.containsKey(key)) return;
      } else {
        _retireQueued(existing);
      }
    }
    final task = DownloadTask(
        recordKey: request.recordKey, episodeNumber: request.episodeNumber);
    _activeTasks[key] = task;
    _startTask(task, request);
  }

  void _startTask(DownloadTask task, DownloadRequest request) {
    task.isRunning = true;
    _runningCount++;
    unawaited(_runEpisodeDownload(
      task: task,
      bangumiId: request.bangumiId,
      pluginName: request.pluginName,
      m3u8Url: request.m3u8Url,
      fallbackUrl: request.fallbackUrl,
      sourceRefresher: request.sourceRefresher,
      directFile: request.directFile,
      httpHeaders: request.httpHeaders,
      adBlockerEnabled: request.adBlockerEnabled,
      episode: request.episode,
    ));
  }

  void _retireQueued(DownloadTask task) {
    final key = _taskKey(task.recordKey, task.episodeNumber);
    _queue.removeWhere(
        (request) => _taskKey(request.recordKey, request.episodeNumber) == key);
    if (identical(_activeTasks[key], task)) _activeTasks.remove(key);
    if (!task.completion.isCompleted) task.completion.complete();
  }

  @override
  void pause(String recordKey, int episodeNumber) {
    final task = _activeTasks[_taskKey(recordKey, episodeNumber)];
    if (task == null) return;
    task.isPaused = true;
    task.cancelToken.cancel('paused');
    if (!task.isRunning) _retireQueued(task);
  }

  @override
  Future<void> resume(DownloadRequest request) async {
    pause(request.recordKey, request.episodeNumber);
    await enqueue(request);
  }

  @override
  Future<void> cancel(String recordKey, int episodeNumber) async {
    final task = _activeTasks[_taskKey(recordKey, episodeNumber)];
    if (task == null) return;
    task.isRemoved = true;
    task.cancelToken.cancel('cancelled');
    if (!task.isRunning) _retireQueued(task);
    await task.completion.future;
  }

  void _processQueue() {
    while (_runningCount < maxParallelEpisodes && _queue.isNotEmpty) {
      final request = _queue.removeAt(0);
      final task =
          _activeTasks[_taskKey(request.recordKey, request.episodeNumber)];
      if (task == null) continue;
      if (task.isPaused || task.cancelToken.isCancelled) {
        _retireQueued(task);
        continue;
      }
      _startTask(task, request);
    }
  }

  Future<void> _runEpisodeDownload({
    required DownloadTask task,
    required int bangumiId,
    required String pluginName,
    required String m3u8Url,
    String fallbackUrl = '',
    DownloadSourceRefresher? sourceRefresher,
    bool directFile = false,
    required Map<String, String> httpHeaders,
    required bool adBlockerEnabled,
    required DownloadEpisode episode,
  }) async {
    final key = _taskKey(task.recordKey, task.episodeNumber);
    try {
      episode.status = DownloadStatus.downloading;
      episode.networkM3u8Url = m3u8Url;
      _notifyProgress(task.recordKey, task.episodeNumber, episode);

      if (directFile) {
        await _runDirectFileDownload(
          task: task,
          bangumiId: bangumiId,
          pluginName: pluginName,
          videoUrl: m3u8Url,
          fallbackVideoUrl: fallbackUrl,
          sourceRefresher: sourceRefresher,
          httpHeaders: httpHeaders,
          episode: episode,
        );
        return;
      }

      String activeUrl = m3u8Url;
      String m3u8Content;
      try {
        m3u8Content =
            await _fetchM3u8(activeUrl, httpHeaders, task.cancelToken);
      } on NetworkException catch (e) {
        if (fallbackUrl.isEmpty || fallbackUrl == activeUrl) rethrow;
        KazumiLogger().w(
          'DownloadManager: direct source failed (${e.statusCode}), trying server fallback',
        );
        activeUrl = fallbackUrl;
        episode.networkM3u8Url = activeUrl;
        try {
          m3u8Content =
              await _fetchM3u8(activeUrl, httpHeaders, task.cancelToken);
        } on _NotM3u8Exception {
          await _runDirectFileDownload(
            task: task,
            bangumiId: bangumiId,
            pluginName: pluginName,
            videoUrl: activeUrl,
            fallbackVideoUrl: '',
            sourceRefresher: sourceRefresher,
            httpHeaders: httpHeaders,
            episode: episode,
          );
          return;
        }
      } on _NotM3u8Exception {
        KazumiLogger().i(
          'DownloadManager: URL is not M3U8, falling back to direct file download '
          'for episode ${task.episodeNumber}',
        );
        await _runDirectFileDownload(
          task: task,
          bangumiId: bangumiId,
          pluginName: pluginName,
          videoUrl: activeUrl,
          fallbackVideoUrl: fallbackUrl == activeUrl ? '' : fallbackUrl,
          sourceRefresher: sourceRefresher,
          httpHeaders: httpHeaders,
          episode: episode,
        );
        return;
      }

      final type = M3u8Parser.detectType(m3u8Content);
      String mediaM3u8Content = m3u8Content;
      String mediaM3u8Url = activeUrl;

      if (type == M3u8Type.master) {
        final master = M3u8Parser.parseMasterPlaylist(m3u8Content, activeUrl);
        final bestVariant = master.bestVariant;
        mediaM3u8Url = bestVariant.uri;
        mediaM3u8Content =
            await _fetchM3u8(mediaM3u8Url, httpHeaders, task.cancelToken);
      }

      final playlist =
          M3u8Parser.parseMediaPlaylist(mediaM3u8Content, mediaM3u8Url);

      // 展开嵌套 m3u8 片段（部分源将实际内容嵌套在 m3u8 引用中）
      final resolvedSegments = await M3u8Parser.resolveNestedSegments(
        playlist.segments,
        (url) => _fetchM3u8(url, httpHeaders, task.cancelToken),
      );
      final resolvedPlaylist = M3u8MediaPlaylist(
        segments: resolvedSegments,
        targetDuration: playlist.targetDuration,
        isVod: playlist.isVod,
      );

      if (!resolvedPlaylist.isVod) {
        episode.status = DownloadStatus.failed;
        episode.errorMessage = '不支持下载直播流 (无有效分片)';
        _notifyProgress(task.recordKey, task.episodeNumber, episode);
        return;
      }

      if (resolvedPlaylist.segments.isEmpty) {
        episode.status = DownloadStatus.failed;
        episode.errorMessage = 'M3U8 中未找到可下载的分片';
        _notifyProgress(task.recordKey, task.episodeNumber, episode);
        return;
      }

      List<M3u8Segment> segments = resolvedPlaylist.segments;
      // fMP4 初始化片段（OI 的 fMP4-in-PNG BYTERANGE 源需要）。
      final initSegment = playlist.initSegment;
      if (adBlockerEnabled) {
        segments = M3u8AdFilter.filterAds(segments);
      }

      final base = await _downloadBaseDir;
      final episodeDir =
          getEpisodeDir(base, bangumiId, pluginName, task.episodeNumber);
      await Directory(episodeDir).create(recursive: true);
      // fMP4（BYTERANGE）源：清理上一次失败遗留的整张 PNG(.ts) 片段，
      // 避免恢复下载时把它们误判为已完成的正常分片。
      if (initSegment != null) {
        final dirObj = Directory(episodeDir);
        if (await dirObj.exists()) {
          await for (final entity in dirObj.list()) {
            if (entity.path.endsWith('.ts')) {
              try {
                await entity.delete();
              } catch (_) {}
            }
          }
        }
      }
      episode.downloadDirectory = episodeDir;
      await _checkStorageSpace(base);
      final keys = M3u8Parser.extractUniqueKeys(
        M3u8MediaPlaylist(
          segments: segments,
          targetDuration: resolvedPlaylist.targetDuration,
          isVod: true,
          initSegment: initSegment,
        ),
      );
      final keyUriToLocal = <String, String>{};
      for (int i = 0; i < keys.length; i++) {
        final keyFile = 'key_$i.key';
        final keyPath = '$episodeDir/$keyFile';
        await _downloadFile(
            keys[i].uri, keyPath, httpHeaders, task.cancelToken);
        keyUriToLocal[keys[i].uri] = keyFile;
      }

      final manifest = await HlsDownloadManifest.prepare(
          episodeDir, segments, initSegment, keyUriToLocal, adBlockerEnabled);

      // 下载 fMP4 初始化片段（EXT-X-MAP）。
      if (initSegment != null) {
        final initPath = '$episodeDir/init.mp4';
        if (!manifest.canReuse('init.mp4')) {
          await _downloadSegmentWithRetry(
            initSegment.uri,
            initPath,
            httpHeaders,
            task.cancelToken,
            byteRange: initSegment.byteRange,
          );
        }
      }

      if (initSegment != null) await manifest.record('init.mp4');
      episode.totalSegments = segments.length;
      episode.downloadedSegments = 0;
      _notifyProgress(task.recordKey, task.episodeNumber, episode);
      final episodeDirObj = Directory(episodeDir);
      if (await episodeDirObj.exists()) {
        await for (final entity in episodeDirObj.list()) {
          if (entity.path.endsWith('.tmp')) {
            try {
              await entity.delete();
            } catch (_) {}
          }
        }
      }

      final existingSegments = <int>{};
      var existingBytes = 0;
      for (int i = 0; i < segments.length; i++) {
        final ext = segments[i].byteRange != null ? 'mp4' : 'ts';
        final segFile =
            File('$episodeDir/seg_${i.toString().padLeft(5, '0')}.$ext');
        if (manifest
                .canReuse(HlsDownloadManifest.segmentName(i, segments[i])) &&
            await segFile.exists()) {
          final segmentBytes = await segFile.length();
          if (segmentBytes <= 0) continue;
          existingSegments.add(i);
          episode.downloadedSegments++;
          existingBytes += segmentBytes;
        }
      }
      episode.totalBytes = existingBytes;
      episode.progressPercent = episode.totalSegments > 0
          ? episode.downloadedSegments / episode.totalSegments
          : 0.0;
      _notifyProgress(task.recordKey, task.episodeNumber, episode);

      final pendingIndices = <int>[];
      for (int i = 0; i < segments.length; i++) {
        if (!existingSegments.contains(i)) {
          pendingIndices.add(i);
        }
      }

      var sessionBytes = 0;
      int failedCount = 0;
      int nextIndex = 0;

      _speedTrackers[key] = _SpeedTracker();

      Future<void> worker() async {
        while (!task.isPaused &&
            !task.cancelToken.isCancelled &&
            nextIndex < pendingIndices.length) {
          final idx = pendingIndices[nextIndex++];
          try {
            final bytes = await _downloadSegmentWithRetry(
              segments[idx].uri,
              '$episodeDir/seg_${idx.toString().padLeft(5, '0')}.${segments[idx].byteRange != null ? 'mp4' : 'ts'}',
              httpHeaders,
              task.cancelToken,
              byteRange: segments[idx].byteRange,
            );
            if (task.isPaused ||
                task.cancelToken.isCancelled ||
                !identical(_activeTasks[key], task)) {
              return;
            }
            await manifest
                .record(HlsDownloadManifest.segmentName(idx, segments[idx]));
            if (task.isPaused ||
                task.cancelToken.isCancelled ||
                !identical(_activeTasks[key], task)) {
              return;
            }
            sessionBytes += bytes;
            episode.downloadedSegments++;
            episode.totalBytes = existingBytes + sessionBytes;
            episode.progressPercent =
                episode.downloadedSegments / episode.totalSegments;
            _speedTrackers[key]?.update(sessionBytes);
            _notifyProgress(task.recordKey, task.episodeNumber, episode);
          } catch (_) {
            failedCount++;
          }
        }
      }

      // Cancellation also waits for every started network/file operation.
      try {
        await Future.wait(List.generate(
            maxParallelSegments.clamp(0, pendingIndices.length),
            (_) => worker()));
      } finally {
        await manifest.save();
      }

      if (task.isPaused || task.cancelToken.isCancelled) {
        if (task.isPaused) {
          episode.status = DownloadStatus.paused;
        }
        _notifyProgress(task.recordKey, task.episodeNumber, episode);
        return;
      }

      if (failedCount > 0) {
        episode.status = DownloadStatus.failed;
        episode.errorMessage = '$failedCount 个分片下载失败';
        _notifyProgress(task.recordKey, task.episodeNumber, episode);
        return;
      }

      final targetDuration = adBlockerEnabled
          ? M3u8AdFilter.calculateTargetDuration(segments)
          : resolvedPlaylist.targetDuration;
      final localM3u8 = M3u8Parser.buildLocalM3u8(
        segments,
        targetDuration: targetDuration,
        keyUriToLocal: keyUriToLocal,
        initSegment: initSegment,
      );
      final m3u8Path = '$episodeDir/playlist.m3u8';
      await File(m3u8Path).writeAsString(localM3u8);
      final finalVideoBytes = manifest.files.entries
          .where((entry) => entry.key.startsWith('seg_'))
          .fold<int>(0, (total, entry) => total + entry.value);

      episode.status = DownloadStatus.completed;
      episode.localM3u8Path = m3u8Path;
      episode.progressPercent = 1.0;
      episode.completedAt = DateTime.now();
      episode.totalBytes =
          finalVideoBytes > 0 ? finalVideoBytes : existingBytes + sessionBytes;
      _notifyProgress(task.recordKey, task.episodeNumber, episode);

      KazumiLogger().i(
        'DownloadManager: episode ${task.episodeNumber} completed. '
        '${segments.length} segments, ${(episode.totalBytes / 1024 / 1024).toStringAsFixed(1)} MB',
      );
    } on _InsufficientStorageException catch (e) {
      episode.status = DownloadStatus.failed;
      episode.errorMessage =
          '存储空间不足 (可用: ${fmt.formatBytes(e.availableBytes)})';
      _notifyProgress(task.recordKey, task.episodeNumber, episode);
      KazumiLogger().w('DownloadManager: insufficient storage space', error: e);
    } on FileSystemException catch (e) {
      episode.status = DownloadStatus.failed;
      episode.errorMessage = _getStorageErrorMessage(e);
      _notifyProgress(task.recordKey, task.episodeNumber, episode);
      KazumiLogger().e('DownloadManager: file system error', error: e);
    } on NetworkException catch (e) {
      if (e.type == NetworkExceptionType.cancel) {
        if (task.isPaused) {
          episode.status = DownloadStatus.paused;
        }
      } else {
        episode.status = DownloadStatus.failed;
        episode.errorMessage = e.message;
      }
      _notifyProgress(task.recordKey, task.episodeNumber, episode);
    } catch (e) {
      if (task.cancelToken.isCancelled) {
        if (task.isPaused) episode.status = DownloadStatus.paused;
        _notifyProgress(task.recordKey, task.episodeNumber, episode);
        return;
      }
      episode.status = DownloadStatus.failed;
      episode.errorMessage = e.toString();
      _notifyProgress(task.recordKey, task.episodeNumber, episode);
      KazumiLogger().e('DownloadManager: episode download failed', error: e);
    } finally {
      _onTaskComplete(task);
    }
  }

  Future<void> _runDirectFileDownload({
    required DownloadTask task,
    required int bangumiId,
    required String pluginName,
    required String videoUrl,
    required String fallbackVideoUrl,
    required DownloadSourceRefresher? sourceRefresher,
    required Map<String, String> httpHeaders,
    required DownloadEpisode episode,
  }) async {
    final key = _taskKey(task.recordKey, task.episodeNumber);
    try {
      final base = await _downloadBaseDir;
      final episodeDir =
          getEpisodeDir(base, bangumiId, pluginName, task.episodeNumber);
      await Directory(episodeDir).create(recursive: true);
      episode.downloadDirectory = episodeDir;
      await _checkStorageSpace(base);

      final filePath = '$episodeDir/video.mp4';
      final tmpPath = '$filePath.tmp';
      final tmpFile = File(tmpPath);
      episode.totalSegments = 1;
      episode.downloadedSegments = 0;
      _notifyProgress(task.recordKey, task.episodeNumber, episode);
      _speedTrackers[key] = _SpeedTracker();

      var currentUrl = videoUrl;
      var currentFallback = fallbackVideoUrl;
      var retryCount = 0;
      const maxRetries = 8;

      while (true) {
        var existingBytes = await tmpFile.exists() ? await tmpFile.length() : 0;
        var useRange = existingBytes > 0;
        final requestHeaders = Map<String, String>.from(httpHeaders);
        if (useRange) requestHeaders['Range'] = 'bytes=$existingBytes-';

        try {
          Response<ResponseBody> response;
          try {
            response = await _http.getStream(
              currentUrl,
              headers: requestHeaders,
              receiveTimeout: const Duration(seconds: 45),
              cancelToken: task.cancelToken,
            );
          } on NetworkException catch (e) {
            if (e.statusCode == 416 && useRange) {
              KazumiLogger().w(
                'DownloadManager: saved range is not accepted, restarting this file',
              );
              await tmpFile.delete();
              existingBytes = 0;
              useRange = false;
              requestHeaders.remove('Range');
              response = await _http.getStream(
                currentUrl,
                headers: requestHeaders,
                receiveTimeout: const Duration(seconds: 45),
                cancelToken: task.cancelToken,
              );
            } else if (currentFallback.isNotEmpty &&
                currentFallback != currentUrl) {
              KazumiLogger().w(
                'DownloadManager: direct source failed (${e.statusCode}), trying server fallback',
              );
              episode.networkM3u8Url = currentFallback;
              response = await _http.getStream(
                currentFallback,
                headers: requestHeaders,
                receiveTimeout: const Duration(seconds: 45),
                cancelToken: task.cancelToken,
              );
            } else {
              rethrow;
            }
          }

          final contentType = response.headers.value(Headers.contentTypeHeader);
          if (!isPlausibleDirectMediaContentType(contentType)) {
            throw _InvalidMediaResponseException(contentType ?? 'unknown');
          }

          if (useRange && response.statusCode == 200) {
            KazumiLogger().w(
              'DownloadManager: server ignored Range, restarting direct download',
            );
            if (await tmpFile.exists()) await tmpFile.delete();
            existingBytes = 0;
            useRange = false;
          }

          final contentRange = response.headers.value('content-range');
          final contentLength = int.tryParse(
                  response.headers.value(Headers.contentLengthHeader) ?? '') ??
              0;
          final rangeMatch = contentRange == null
              ? null
              : RegExp(r'bytes\s+(\d+)-(\d+)/(\d+)', caseSensitive: false)
                  .firstMatch(contentRange);
          final totalSize = rangeMatch != null
              ? int.parse(rangeMatch.group(3)!)
              : (contentLength > 0 ? existingBytes + contentLength : 0);

          final raf = await tmpFile.open(
            mode: existingBytes > 0 ? FileMode.append : FileMode.write,
          );
          var received = existingBytes;
          try {
            await for (final chunk in response.data!.stream) {
              if (task.isPaused || task.cancelToken.isCancelled) break;
              await raf.writeFrom(chunk);
              received += chunk.length;
              episode.totalBytes = received;
              episode.progressPercent =
                  totalSize > 0 ? (received / totalSize).clamp(0.0, 1.0) : 0;
              _speedTrackers[key]?.update(received);
              _notifyProgress(task.recordKey, task.episodeNumber, episode);
            }
          } finally {
            await raf.close();
          }

          if (task.isPaused || task.cancelToken.isCancelled) {
            if (task.isPaused) episode.status = DownloadStatus.paused;
            _notifyProgress(task.recordKey, task.episodeNumber, episode);
            return;
          }

          final actualSize = await tmpFile.length();
          final expectedRangeEnd =
              rangeMatch == null ? 0 : int.parse(rangeMatch.group(2)!) + 1;
          if (shouldContinueBoundedRange(
            actualBytes: actualSize,
            totalBytes: totalSize,
            expectedRangeEnd: expectedRangeEnd,
            previousBytes: existingBytes,
          )) {
            // The server intentionally returned a bounded Range chunk. Continue
            // immediately from the next byte without counting it as a failure.
            retryCount = 0;
            continue;
          }
          if (!isDirectDownloadComplete(actualSize, totalSize)) {
            throw _IncompleteDownloadException(
              '文件接收不完整：已接收 $actualSize / ${totalSize > 0 ? totalSize : "未知"} 字节',
            );
          }
          break;
        } catch (e) {
          if (task.isPaused || task.cancelToken.isCancelled) {
            if (task.isPaused) episode.status = DownloadStatus.paused;
            _notifyProgress(task.recordKey, task.episodeNumber, episode);
            return;
          }
          if (e is FileSystemException || e is _InsufficientStorageException) {
            rethrow;
          }

          retryCount++;
          if (retryCount >= maxRetries) {
            throw const _IncompleteDownloadException(
              '下载连接多次中断，已保留下载进度，请稍后重试',
            );
          }

          if (sourceRefresher != null) {
            try {
              final refreshed = await sourceRefresher();
              currentUrl = refreshed.directUrl;
              currentFallback = refreshed.fallbackUrl;
              episode.networkM3u8Url = currentUrl;
            } catch (refreshError) {
              KazumiLogger().w(
                'DownloadManager: failed to refresh direct source',
                error: refreshError,
              );
            }
          }
          final delaySeconds = [1, 2, 4, 8, 12, 15, 20][retryCount - 1];
          KazumiLogger().w(
            'DownloadManager: direct stream interrupted, resuming attempt $retryCount/$maxRetries',
            error: e,
          );
          await Future.delayed(Duration(seconds: delaySeconds));
        }
      }

      final finalFile = File(filePath);
      if (await finalFile.exists()) await finalFile.delete();
      await tmpFile.rename(filePath);

      episode.status = DownloadStatus.completed;
      episode.localM3u8Path = filePath;
      episode.downloadedSegments = 1;
      episode.progressPercent = 1.0;
      episode.completedAt = DateTime.now();
      episode.totalBytes = await File(filePath).length();
      _notifyProgress(task.recordKey, task.episodeNumber, episode);

      KazumiLogger().i(
        'DownloadManager: episode ${task.episodeNumber} completed (direct download). '
        '${(episode.totalBytes / 1024 / 1024).toStringAsFixed(1)} MB',
      );
    } on _IncompleteDownloadException catch (e) {
      episode.status = DownloadStatus.failed;
      episode.errorMessage = e.message;
      _notifyProgress(task.recordKey, task.episodeNumber, episode);
    } on _InsufficientStorageException catch (e) {
      episode.status = DownloadStatus.failed;
      episode.errorMessage =
          '存储空间不足 (可用: ${fmt.formatBytes(e.availableBytes)})';
      _notifyProgress(task.recordKey, task.episodeNumber, episode);
      KazumiLogger().w('DownloadManager: insufficient storage space', error: e);
    } on FileSystemException catch (e) {
      episode.status = DownloadStatus.failed;
      episode.errorMessage = _getStorageErrorMessage(e);
      _notifyProgress(task.recordKey, task.episodeNumber, episode);
      KazumiLogger().e('DownloadManager: file system error', error: e);
    } on NetworkException catch (e) {
      if (e.type == NetworkExceptionType.cancel) {
        if (task.isPaused) {
          episode.status = DownloadStatus.paused;
        }
      } else {
        episode.status = DownloadStatus.failed;
        episode.errorMessage = e.message;
      }
      _notifyProgress(task.recordKey, task.episodeNumber, episode);
    } catch (e) {
      episode.status = DownloadStatus.failed;
      episode.errorMessage = e.toString();
      _notifyProgress(task.recordKey, task.episodeNumber, episode);
      KazumiLogger()
          .e('DownloadManager: direct file download failed', error: e);
    }
  }

  void _onTaskComplete(DownloadTask task) {
    final key = _taskKey(task.recordKey, task.episodeNumber);
    if (identical(_activeTasks[key], task)) {
      _activeTasks.remove(key);
      _speedTrackers.remove(key);
    }
    if (task.isRunning) {
      task.isRunning = false;
      _runningCount--;
    }
    if (!task.completion.isCompleted) task.completion.complete();
    _processQueue();
  }

  void _notifyProgress(
      String recordKey, int episodeNumber, DownloadEpisode episode) {
    final key = _taskKey(recordKey, episodeNumber);
    if (_activeTasks[key]?.isRemoved == true) return;
    final speed = _speedTrackers[key]?.currentSpeed ?? 0.0;
    onProgress?.call(recordKey, episodeNumber, episode, speed);
  }

  Future<String> _fetchM3u8(
      String url, Map<String, String> headers, CancelToken cancelToken) async {
    final fetchToken = CancelToken();

    if (cancelToken.isCancelled) {
      throw NetworkException(
        type: NetworkExceptionType.cancel,
        message: '请求已被取消，请重新请求',
      );
    }

    try {
      final content = await _http.getPlain(
        url,
        headers: headers,
        receiveTimeout: const Duration(seconds: 15),
        cancelToken: fetchToken,
        onReceiveProgress: (received, total) {
          if (cancelToken.isCancelled) {
            fetchToken.cancel('task cancelled');
            return;
          }
          if (received > 2 * 1024 * 1024) {
            fetchToken.cancel('too large');
          }
        },
      );

      final trimmed = content.trimLeft();
      if (!trimmed.startsWith('#EXTM3U')) {
        throw _NotM3u8Exception('URL 不是 M3U8 播放列表');
      }

      return content;
    } on NetworkException catch (e) {
      if (cancelToken.isCancelled) rethrow;
      if (e.type == NetworkExceptionType.cancel) {
        throw _NotM3u8Exception('响应过大，非 M3U8 播放列表');
      }
      rethrow;
    }
  }

  Future<void> _downloadFile(String url, String savePath,
      Map<String, String> headers, CancelToken cancelToken) async {
    await _http.download(
      url,
      savePath,
      headers: headers,
      cancelToken: cancelToken,
    );
  }

  Future<int> _downloadSegmentWithRetry(
    String url,
    String savePath,
    Map<String, String> headers,
    CancelToken cancelToken, {
    int maxRetries = 3,
    M3u8ByteRange? byteRange,
  }) async {
    return SegmentDownload(_http).fetch(url, savePath, headers, cancelToken,
        range: byteRange, attempts: maxRetries);
  }

  @override
  Future<void> deleteEpisodeFiles(
      int bangumiId, String pluginName, int episodeNumber) async {
    final base = await _downloadBaseDir;
    final dir =
        Directory(getEpisodeDir(base, bangumiId, pluginName, episodeNumber));
    if (await dir.exists()) {
      await dir.delete(recursive: true);
    }
  }

  @override
  Future<void> deleteRecordFiles(int bangumiId, String pluginName) async {
    final base = await _downloadBaseDir;
    final dir = Directory('$base/${bangumiId}_$pluginName');
    if (await dir.exists()) {
      await dir.delete(recursive: true);
    }
  }

  @override
  String? getLocalVideoPath(DownloadEpisode? episode) {
    if (episode == null) return null;
    if (episode.status != DownloadStatus.completed) return null;
    if (episode.localM3u8Path.isEmpty) return null;
    final file = File(episode.localM3u8Path);
    if (!file.existsSync()) return null;
    return episode.localM3u8Path;
  }

  @override
  Future<DownloadRestoreResult> restoreExistingLocalDownload(
    int bangumiId,
    String pluginName,
    int episodeNumber,
    DownloadEpisode episode,
  ) async {
    final base = await _downloadBaseDir;
    final episodeDir =
        getEpisodeDir(base, bangumiId, pluginName, episodeNumber);
    final dir = Directory(episodeDir);
    if (!await dir.exists()) return DownloadRestoreResult.none;

    final video = File('$episodeDir/video.mp4');
    final playlist = File('$episodeDir/playlist.m3u8');

    // Case 1: fully completed direct (single-file) download.
    if (await video.exists() && await video.length() > 0) {
      episode.status = DownloadStatus.completed;
      episode.localM3u8Path = video.path;
      episode.downloadDirectory = episodeDir;
      episode.progressPercent = 1;
      episode.downloadedSegments =
          episode.totalSegments > 0 ? episode.totalSegments : 1;
      episode.totalBytes = await video.length();
      episode.completedAt ??= DateTime.now();
      episode.errorMessage = '';
      final partial = File('$episodeDir/video.mp4.tmp');
      if (await partial.exists()) {
        try {
          await partial.delete();
        } catch (_) {}
      }
      return DownloadRestoreResult.completed;
    }

    // Case 2: fully completed m3u8 download.
    if (await playlist.exists() &&
        await playlist.length() > 0 &&
        await HlsDownloadManifest.playlistComplete(episodeDir)) {
      episode.status = DownloadStatus.completed;
      episode.localM3u8Path = playlist.path;
      episode.downloadDirectory = episodeDir;
      episode.progressPercent = 1;
      episode.downloadedSegments =
          episode.totalSegments > 0 ? episode.totalSegments : 1;
      episode.totalBytes = await calculateM3u8VideoBytes(episodeDir);
      episode.completedAt ??= DateTime.now();
      episode.errorMessage = '';
      return DownloadRestoreResult.completed;
    }

    // Case 3: partial / interrupted download — some segments are present.
    // Recover the progress so the user can resume instead of starting over.
    var existingSegments = 0;
    var existingBytes = 0;
    await for (final entity in dir.list(followLinks: false)) {
      if (entity is! File) continue;
      final name = entity.path.split(Platform.pathSeparator).last;
      if (!_m3u8SegmentFileNamePattern.hasMatch(name)) continue;
      final len = await entity.length();
      if (len <= 0) continue;
      existingSegments++;
      existingBytes += len;
    }
    if (existingSegments > 0) {
      episode.status = DownloadStatus.paused;
      episode.downloadDirectory = episodeDir;
      episode.downloadedSegments = existingSegments;
      episode.totalBytes = existingBytes;
      episode.progressPercent = episode.totalSegments > 0
          ? (existingSegments / episode.totalSegments).clamp(0.0, 1.0)
          : 0.0;
      episode.errorMessage = '';
      return DownloadRestoreResult.partial;
    }

    return DownloadRestoreResult.none;
  }
}
