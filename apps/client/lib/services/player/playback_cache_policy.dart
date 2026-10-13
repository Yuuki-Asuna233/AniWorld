import 'dart:async';
import 'dart:ffi';
import 'dart:io';

import 'package:kazumi/services/logging/logger.dart';
import 'package:kazumi/services/network/metered_network_service.dart';
import 'package:kazumi/services/storage/storage.dart';
import 'package:kazumi/utils/async_serial_queue.dart';
import 'package:media_kit/media_kit.dart';
import 'package:kazumi/utils/media.dart';
import 'package:flutter/services.dart';
import 'package:kazumi/bean/dialog/dialog_helper.dart';

/// Keeps this episode on disk, including packets already played.
/// mpv's numeric ceiling is a limit, not a reserved memory allocation.
class PlaybackCachePolicy {
  PlaybackCachePolicy(
      {required this.currentPlayer, required this.isLocalPlayback});

  // mpv M_MAX_MEM_BYTES: min(2^62, SIZE_MAX / 2), for packet metadata.
  static final int nativeCacheCeilingBytes =
      sizeOf<IntPtr>() == 8 ? 1 << 62 : 0x7fffffff;
  static const int rebufferSeconds = 3;

  final Player? Function() currentPlayer;
  final bool Function() isLocalPlayback;
  final AsyncSerialQueue _writes = AsyncSerialQueue();
  StreamSubscription<void>? _settingsSubscription;
  bool _prefetchSuspended = false;
  bool _starting = true;
  Player? _configuredPlayer;
  bool _diskAvailable = true;
  bool _spacePaused = false, _checkingSpace = false;
  String? _diskDirectory;
  Timer? _spaceTimer;
  static const _storage = MethodChannel('com.predidit.kazumi/storage');
  final Set<String> _unavailable = {};
  bool get diskAvailable => _diskAvailable;

  bool get metered =>
      (Platform.isAndroid || Platform.isIOS) && MeteredNetworkService.isMetered;
  bool get prefetchSuspended => _prefetchSuspended || _spacePaused;
  int get bufferSize => nativeCacheCeilingBytes;

  void startWatching() {
    if (_settingsSubscription != null) return;
    _settingsSubscription = GStorage.watchSetting(SettingsKeys.playerHlsBitrate)
        .listen((_) => _onChanged());
    MeteredNetworkService.listenable.addListener(_onChanged);
    unawaited(MeteredNetworkService.refresh());
    _spaceTimer ??= Timer.periodic(
        const Duration(seconds: 30), (_) => unawaited(_checkSpace()));
  }

  void stopWatching() {
    MeteredNetworkService.listenable.removeListener(_onChanged);
    unawaited(_settingsSubscription?.cancel());
    _settingsSubscription = null;
    _spaceTimer?.cancel();
    _spaceTimer = null;
  }

  void _onChanged() => unawaited(apply().catchError((Object _) {}));

  Future<void> setPrefetchSuspended(bool suspended) async {
    _prefetchSuspended = suspended;
    if (!suspended) unawaited(MeteredNetworkService.refresh());
    await apply();
  }

  Future<void> configureDiskDirectory() async {
    final player = currentPlayer();
    if (player == null || identical(player, _configuredPlayer)) return;
    _configuredPlayer = player;
    _unavailable.clear();
    _diskAvailable = true;
    _diskDirectory = null;
    _spacePaused = false;
    try {
      final directory =
          await getPlayerTempPath().timeout(const Duration(seconds: 2));
      if (!identical(currentPlayer(), player)) return;
      await (player.platform as NativePlayer)
          .setProperty('demuxer-cache-dir', directory);
      _diskDirectory = directory;
      _spacePaused = false;
      // Capacity telemetry is optional and must not delay the first frame.
      unawaited(_checkSpace());
    } catch (error) {
      if (!identical(currentPlayer(), player)) return;
      _diskAvailable = false;
      KazumiLogger().w(
          'Playback: disk cache unavailable; continuing with bounded memory cache',
          error: error);
    }
  }

  Future<void> _checkSpace() async {
    final directory = _diskDirectory, player = currentPlayer();
    if (_checkingSpace ||
        directory == null ||
        player == null ||
        isLocalPlayback()) {
      return;
    }
    _checkingSpace = true;
    try {
      final available = await _storage.invokeMethod<int>('getAvailableStorage',
          {'path': directory}).timeout(const Duration(seconds: 2));
      if (!identical(currentPlayer(), player) ||
          available == null ||
          available < 0) {
        return;
      }
      final paused = available < 128 * 1024 * 1024;
      if (paused == _spacePaused) return;
      _spacePaused = paused;
      if (paused) {
        KazumiLogger().w(
            'Playback: free disk space is low; suspending speculative readahead');
        KazumiDialog.showToast(message: '存储空间不足，已暂停提前缓存，请释放空间');
      }
      await apply();
    } catch (error) {
      // Missing/failed capacity metrics do not disable the user's full-episode cache.
      KazumiLogger().w('Playback: disk capacity unavailable', error: error);
    } finally {
      _checkingSpace = false;
    }
  }

  Future<bool> _set(NativePlayer native, String key, String value) async {
    if (_unavailable.contains(key)) return false;
    try {
      await native.setProperty(key, value);
      return true;
    } catch (error) {
      // Unsupported optional policy must not turn a valid source into an open failure.
      if (!native.disposed && identical(currentPlayer()?.platform, native)) {
        _unavailable.add(key);
      }
      KazumiLogger().w('Playback: cache option $key unavailable', error: error);
      return false;
    }
  }

  Future<void> apply({bool? starting}) async {
    if (starting != null) _starting = starting;
    final player = currentPlayer();
    if (player == null) return;
    try {
      final native = player.platform as NativePlayer;
      await native.waitForPlayerInitialization;
      await _writes.run(() async {
        if (!identical(currentPlayer(), player)) return;
        final local = isLocalPlayback();
        if (_diskAvailable) {
          final enabled =
              await _set(native, 'cache-on-disk', local ? 'no' : 'yes');
          if (!identical(currentPlayer(), player)) return;
          if (!enabled) _diskAvailable = false;
        }
        if (!_diskAvailable) {
          // Native defaults may still enable disk caching after a path failure.
          await _set(native, 'cache-on-disk', 'no');
          if (!identical(currentPlayer(), player)) return;
        }
        final disk = !local && _diskAvailable;
        final configuredRate =
            GStorage.getSetting(SettingsKeys.playerHlsBitrate);
        final rate = configuredRate == -1
            ? 'max'
            : configuredRate > 0
                ? configuredRate.toString()
                : metered
                    ? '4000000'
                    : 'max';
        final properties = <String, String>{
          'cache': local ? 'no' : 'yes',
          'demuxer-seekable-cache': local ? 'auto' : 'yes',
          'demuxer-max-bytes':
              (disk ? bufferSize : 256 * 1024 * 1024).toString(),
          'demuxer-max-back-bytes':
              (disk ? bufferSize : 64 * 1024 * 1024).toString(),
          'cache-secs': local
              ? '1'
              : _prefetchSuspended || _spacePaused
                  ? '0'
                  : disk
                      ? double.maxFinite.toString()
                      : '60',
          'demuxer-readahead-secs':
              _prefetchSuspended || _spacePaused ? '0' : '1',
          'demuxer-hysteresis-secs': '0',
          'cache-pause': 'yes',
          'cache-pause-wait': (_starting ? 1 : rebufferSeconds).toString(),
          'cache-pause-initial': local ? 'no' : 'yes',
          'hls-bitrate': rate,
        };
        for (final property in properties.entries) {
          if (!identical(currentPlayer(), player)) return;
          await _set(native, property.key, property.value);
        }
      });
    } catch (error, stackTrace) {
      KazumiLogger().w('PlaybackCachePolicy: policy update failed',
          error: error, stackTrace: stackTrace);
      // Lifecycle and media opening continue; diagnostics expose the degraded policy.
    }
  }
}
