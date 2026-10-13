import 'dart:async';
import 'package:kazumi/services/logging/logger.dart';
import 'package:kazumi/services/player/playback_cache_state.dart';
import 'package:kazumi/services/player/playback_position_policy.dart';
import 'package:media_kit/media_kit.dart';
import 'package:media_kit_video/media_kit_video.dart';
import 'package:kazumi/services/player/playback_startup_trace.dart';

class PlaybackOpenException implements Exception {
  final String kind;
  const PlaybackOpenException(this.kind);
  @override
  String toString() => 'PlaybackOpenException: $kind';
}

/// Observes one media instance. It never chooses episodes or rewrites position.
class PlaybackSessionMonitor {
  static const int _cacheSampleIntervalMs = 2000;

  PlaybackSessionMonitor(
      {required this.player,
      required this.isCurrent,
      required this.canRecover,
      required this.onRecover,
      this.onTerminalError,
      this.startup,
      required this.report,
      required this.metadata}) {
    _events =
        (player.platform as NativePlayer).mediaEvents.listen(_onMediaEvent);
    _logs = player.stream.log.listen((log) {
      if (_waiting && !_closed && isCurrent() && log.level == 'error') {
        _errorComponents.add(log.prefix);
      }
    });
    _videoParams = player.stream.videoParams.listen((_) => _tryReady());
    _timer = Timer.periodic(const Duration(seconds: 1), (_) => _sample());
  }

  final Player player;
  final bool Function() isCurrent;
  final bool Function() canRecover;
  final Future<bool> Function(String reason) onRecover;
  final void Function(String kind)? onTerminalError;
  final PlaybackStartupTrace? startup;
  final void Function(Map<String, Object> event) report;
  final Map<String, Object> metadata;
  final List<Map<String, Object>> events = [];
  final Completer<void> _ready = Completer<void>();
  final Completer<void> _failure = Completer<void>();
  final Stopwatch _elapsed = Stopwatch()..start();
  late final StreamSubscription<NativeMediaEvent> _events;
  late final StreamSubscription<PlayerLog> _logs;
  late final StreamSubscription<VideoParams> _videoParams;
  final Set<String> _errorComponents = {};
  int? _generation;
  bool _fileLoaded = false, _restarted = false;
  late final Timer _timer;
  bool _waiting = false, _opened = false, _closed = false, _recovering = false;
  DateTime _lastPlaybackProgress = DateTime.now();
  DateTime? _seekGraceUntil;
  DateTime? _bufferStarted;
  Duration _progressPosition = Duration.zero;
  int _stallCount = 0, _bufferMs = 0, _attempts = 0;
  int _lastCacheSampleMs = -_cacheSampleIntervalMs, _cacheRevision = 0;
  bool _samplingCache = false, _cacheReadWarned = false;
  PlaybackCacheState? _cacheState;
  int _pendingSeeks = 0;
  DateTime _lastCacheProgress = DateTime.now();
  int? _previousDiskBytes;
  Duration? _previousBuffered;
  String? _pendingRecoveryReason;

  Duration? get bufferedPosition =>
      _cacheState?.bufferedUntil(player.state.position, player.state.duration);

  Future<void> open(VideoController controller, Future<void> Function() load,
      {bool newSurface = true}) async {
    _waiting = true;
    _generation = (player.platform as NativePlayer).mediaGeneration + 1;
    try {
      final loading = Future.wait([
        load(),
        _ready.future,
        if (newSurface) controller.waitUntilFirstFrameRendered,
      ], eagerError: true)
          .then<void>((_) {});
      await Future.any<void>([loading, _failure.future])
          .timeout(const Duration(seconds: 30));
      if (_closed || !isCurrent()) {
        throw const PlaybackOpenException('cancelled');
      }
      _opened = true;
      _lastPlaybackProgress = DateTime.now();
      _progressPosition = player.state.position;
      _emit('ready', {
        'readyMs': _elapsed.elapsedMilliseconds,
        if (startup != null) 'startupMs': startup!.elapsedMs,
        'openMs': _elapsed.elapsedMilliseconds
      });
    } on TimeoutException {
      _emit('open_failed', {'error': 'timeout'});
      throw const PlaybackOpenException('timeout');
    } on PlaybackOpenException catch (error) {
      _emit('open_failed', {'error': error.kind});
      rethrow;
    } finally {
      _waiting = false;
    }
  }

  void _tryReady() {
    if (_closed ||
        !_waiting ||
        !isCurrent() ||
        !_fileLoaded ||
        !_restarted ||
        _ready.isCompleted) {
      return;
    }
    final params = player.state.videoParams;
    if ((params.dw ?? 0) > 0 && (params.dh ?? 0) > 0) _ready.complete();
  }

  void _onMediaEvent(NativeMediaEvent event) {
    if (_closed || !isCurrent() || event.generation != _generation) return;
    if (event.kind == NativeMediaEventKind.started) _errorComponents.clear();
    if (event.kind == NativeMediaEventKind.loaded) _fileLoaded = true;
    if (event.kind == NativeMediaEventKind.ready) _restarted = true;
    _tryReady();
    if (event.kind != NativeMediaEventKind.failed) return;
    // Only END_FILE/ERROR is fatal. Decoder/audio/network log messages can
    // occur during successful native retry or hardware fallback.
    final kind = event.errorCode == -15
        ? 'renderer'
        : event.errorCode == -14
            ? 'audio'
            : event.errorCode == -13
                ? 'network'
                : _errorComponents.contains('vd')
                    ? 'decoder'
                    : 'open';
    if (!_opened && _waiting && !_failure.isCompleted) {
      _failure.completeError(PlaybackOpenException(kind));
    } else if (_opened) {
      _emit('media_error', {'error': kind});
      onTerminalError?.call(kind);
      if (kind == 'network' || kind == 'open') {
        _pendingRecoveryReason = kind;
        unawaited(_recover(kind));
      }
    }
  }

  void markSeek() {
    if (_closed || !isCurrent()) return;
    _seekGraceUntil = DateTime.now().add(const Duration(seconds: 8));
    _lastPlaybackProgress = DateTime.now();
    _progressPosition = player.state.position;
    _cacheRevision++;
    _cacheState = null;
    _previousBuffered = null;
    _previousDiskBytes = null;
    _lastCacheProgress = DateTime.now();
    _lastCacheSampleMs = -_cacheSampleIntervalMs;
    if (_bufferStarted != null) _finishBuffer(DateTime.now());
  }

  void beginSeek() {
    _pendingSeeks++;
    markSeek();
  }

  void endSeek() {
    if (_pendingSeeks > 0) _pendingSeeks--;
    markSeek();
  }

  void _sample() {
    if (_closed) return;
    if (!isCurrent()) {
      dispose();
      return;
    }
    if (!_opened) return;
    if (!_samplingCache &&
        _elapsed.elapsedMilliseconds - _lastCacheSampleMs >=
            _cacheSampleIntervalMs) {
      unawaited(_sampleCache());
    }
    final state = player.state;
    final now = DateTime.now();
    final pendingRecovery = _pendingRecoveryReason;
    if (pendingRecovery != null) unawaited(_recover(pendingRecovery));
    if (state.position >=
        _progressPosition + const Duration(milliseconds: 500)) {
      _lastPlaybackProgress = now;
      _progressPosition = state.position;
    }
    if (state.completed) {
      if (_bufferStarted != null) _finishBuffer(now);
      // mpv stops playing on EOF, including a truncated network stream. The
      // recovery gate uses playback intent rather than that stopped state.
      if (_hasPrematureEnd(state)) unawaited(_recover('premature_eof'));
      return;
    }
    if (!state.playing || !canRecover()) {
      _lastPlaybackProgress = now;
      _progressPosition = state.position;
      if (_bufferStarted != null) _finishBuffer(now);
      return;
    }
    if (!state.buffering) {
      if (_bufferStarted != null) _finishBuffer(now);
      return;
    }
    if (_bufferStarted == null) {
      _bufferStarted = now;
      _stallCount++;
    }
    final noInputProgress =
        now.difference(_lastCacheProgress) >= const Duration(seconds: 18);
    if ((noInputProgress &&
            now.difference(_bufferStarted!) >= const Duration(seconds: 18) &&
            now.difference(_lastPlaybackProgress) >=
                const Duration(seconds: 18)) ||
        now.difference(_bufferStarted!) >= const Duration(minutes: 2)) {
      unawaited(_recover('buffer_stalled'));
    }
  }

  void _finishBuffer(DateTime now) {
    _bufferMs += now.difference(_bufferStarted!).inMilliseconds;
    _bufferStarted = null;
    _emit('buffered');
  }

  Future<void> _sampleCache() async {
    _samplingCache = true;
    _lastCacheSampleMs = _elapsed.elapsedMilliseconds;
    final revision = _cacheRevision;
    try {
      final snapshot = await PlaybackCacheState.read(player)
          .timeout(const Duration(seconds: 2));
      if (!_closed && isCurrent() && revision == _cacheRevision) {
        _cacheState = snapshot;
        final bytes = snapshot.diskBytes;
        final buffered = snapshot.bufferedUntil(
            player.state.position, player.state.duration);
        if ((bytes != null &&
                _previousDiskBytes != null &&
                bytes - _previousDiskBytes! >= 128 * 1024) ||
            (buffered != null &&
                _previousBuffered != null &&
                buffered - _previousBuffered! >=
                    const Duration(milliseconds: 500)) ||
            (snapshot.inputBytesPerSecond ?? 0) >= 16 * 1024) {
          _lastCacheProgress = DateTime.now();
        }
        _previousDiskBytes = bytes;
        _previousBuffered = buffered;
      }
    } catch (error) {
      if (!_closed && isCurrent() && revision == _cacheRevision) {
        _cacheState = null;
        if (!_cacheReadWarned) {
          _cacheReadWarned = true;
          KazumiLogger().w('Playback: cache metrics unavailable', error: error);
        }
      }
      // Statistics are optional and never disable disk caching.
    } finally {
      _samplingCache = false;
    }
  }

  Future<void> _recover(String reason) async {
    if (_closed ||
        !isCurrent() ||
        !canRecover() ||
        (player.state.completed &&
            !_hasPrematureEnd(player.state) &&
            reason != 'network' &&
            reason != 'open') ||
        _pendingSeeks > 0 ||
        (_seekGraceUntil != null &&
            DateTime.now().isBefore(_seekGraceUntil!)) ||
        _recovering ||
        _attempts >= 2) {
      return;
    }
    _recovering = true;
    _pendingRecoveryReason = null;
    _attempts++;
    _lastPlaybackProgress = DateTime.now();
    _emit('recovery', {'error': reason, 'attempt': _attempts});
    try {
      if (!await onRecover(reason)) {
        _attempts = 2;
        _emit('recovery_failed', {'error': reason});
      }
    } catch (_) {
      _emit('recovery_failed', {'error': reason});
    } finally {
      _recovering = false;
    }
  }

  bool _hasPrematureEnd(PlayerState state) => isPlaybackAtPrematureEnd(
        completed: state.completed,
        position: state.position,
        duration: state.duration,
      );

  void _emit(String result, [Map<String, Object> extra = const {}]) {
    if (_closed) return;
    final buffered = bufferedPosition;
    final ahead = buffered == null ? null : buffered - player.state.position;
    final diskBytes = _cacheState?.diskBytes;
    final inputRate = _cacheState?.inputBytesPerSecond;
    final event = <String, Object>{
      ...metadata,
      ...?startup?.phases,
      'result': result,
      'stallCount': _stallCount,
      'bufferMs': _bufferMs,
      if (ahead != null)
        'aheadSeconds': ahead.inSeconds < 0 ? 0 : ahead.inSeconds,
      if (diskBytes != null) 'diskBytes': diskBytes,
      if (inputRate != null) 'inputBytesPerSecond': inputRate,
      ...extra
    };
    events.add(event);
    if (events.length > 20) events.removeAt(0);
    report(event);
  }

  void markVisible() {
    if (!_closed && isCurrent()) {
      _emit('visible',
          {'visibleMs': startup?.elapsedMs ?? _elapsed.elapsedMilliseconds});
    }
  }

  void dispose() {
    if (_closed) return;
    if (_opened) {
      if (_bufferStarted != null) _finishBuffer(DateTime.now());
      _emit('closed');
    }
    _closed = true;
    _pendingRecoveryReason = null;
    _timer.cancel();
    unawaited(_events.cancel());
    unawaited(_logs.cancel());
    unawaited(_videoParams.cancel());
    if (_waiting && !_failure.isCompleted) {
      _failure.completeError(const PlaybackOpenException('cancelled'));
    }
    if (!_ready.isCompleted) _ready.complete();
  }
}
