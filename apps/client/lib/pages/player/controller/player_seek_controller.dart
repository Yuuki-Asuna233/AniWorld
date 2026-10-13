// 对齐原版 Kazumi (Predidit/Kazumi main) 的 PlayerSeekController。
// 所有跳转统一使用 player.seek(target)，
// 避免 mpv start 属性粘性导致的"拖回0仍跳回"问题。
import 'package:kazumi/pages/player/controller/player_danmaku_controller.dart';
import 'package:kazumi/pages/player/controller/player_playback_controller.dart';
import 'package:media_kit/media_kit.dart';
import 'package:kazumi/services/player/playback_session_monitor.dart';

class _InteractiveSeekSession {
  _InteractiveSeekSession(this.pauseCompleted, this.target, this.player,
      this.generation, this.resume, this.monitor);

  final Future<void> pauseCompleted;
  Duration target;
  Future<bool>? commit;
  final Player player;
  final int generation;
  final bool resume;
  final PlaybackSessionMonitor? monitor;
  bool finished = false;
}

class PlayerSeekController {
  PlayerSeekController({
    required PlayerPlaybackController playback,
    required PlayerDanmakuController danmaku,
    required Future<void> Function({bool enableSync}) pause,
    required Future<void> Function({bool enableSync}) play,
    required Future<void> Function(bool enableSync) onSeekCompleted,
  })  : _playback = playback,
        _danmaku = danmaku,
        _pause = pause,
        _play = play,
        _onSeekCompleted = onSeekCompleted;

  final PlayerPlaybackController _playback;
  final PlayerDanmakuController _danmaku;
  final Future<void> Function({bool enableSync}) _pause;
  final Future<void> Function({bool enableSync}) _play;
  final Future<void> Function(bool enableSync) _onSeekCompleted;

  Future<void> _seekTail = Future<void>.value();
  _InteractiveSeekSession? _interactiveSession;

  bool get hasActiveInteractiveSeek => _interactiveSession != null;

  Future<void> seekTo(
    Duration target, {
    bool enableSync = true,
  }) {
    final player = _playback.mediaPlayer;
    if (player == null) {
      return Future<void>.value();
    }

    final normalizedTarget = _normalize(target);
    final generation = (player.platform as NativePlayer).mediaGeneration;
    _playback.currentPosition = normalizedTarget;
    _danmaku.clearAndInvalidateScheduledDanmakus();

    final operation = _seekTail.then((_) async {
      if (!_playback.isCurrentPlayer(player) ||
          generation != (player.platform as NativePlayer).mediaGeneration) {
        return;
      }
      final monitor = _playback.monitor;
      monitor?.beginSeek();
      try {
        await player.seek(normalizedTarget);
      } catch (_) {
        return;
      } finally {
        monitor?.endSeek();
      }
      if (_playback.isCurrentPlayer(player) &&
          generation == (player.platform as NativePlayer).mediaGeneration) {
        await _onSeekCompleted(enableSync);
      }
    });
    _seekTail = _settle(operation);
    return operation;
  }

  Future<void> seekBy(
    Duration offset, {
    bool enableSync = true,
  }) =>
      seekTo(
        _playback.currentPosition + offset,
        enableSync: enableSync,
      );

  bool beginInteractiveSeek() {
    final player = _playback.mediaPlayer;
    if (player == null || !_playback.isCurrentPlayer(player)) return false;
    if (_interactiveSession != null) return false;
    final resume = _playback.requestedPlay ?? _playback.playerPlaying;
    final monitor = _playback.monitor;
    monitor?.beginSeek();
    _interactiveSession = _InteractiveSeekSession(
      _pause(enableSync: false),
      _playback.currentPosition,
      player,
      (player.platform as NativePlayer).mediaGeneration,
      resume,
      monitor,
    );
    return true;
  }

  bool updateInteractiveSeek(Duration target) {
    final session = _interactiveSession;
    if (session == null || !_isCurrent(session)) {
      return false;
    }
    session.target = _normalize(target);
    _playback.currentPosition = session.target;
    return true;
  }

  Future<bool> commitInteractiveSeek() {
    final session = _interactiveSession;
    if (session == null) {
      return Future<bool>.value(false);
    }
    return session.commit ??= _commitInteractiveSeek(session);
  }

  void invalidateInteractiveSeek() {
    final session = _interactiveSession;
    _interactiveSession = null;
    if (session != null) _finish(session);
  }

  Future<bool> _commitInteractiveSeek(
    _InteractiveSeekSession session,
  ) async {
    try {
      await session.pauseCompleted;
      if (!_isCurrent(session)) {
        return false;
      }

      // Preserve the HLS play-before-seek order only for an originally playing
      // session. A paused user can inspect another frame without being resumed.
      if (session.resume) await _play(enableSync: false);
      if (!_isCurrent(session)) {
        return false;
      }
      await seekTo(session.target);
      return _isCurrent(session);
    } finally {
      if (_isCurrent(session)) {
        _interactiveSession = null;
      }
      _finish(session);
    }
  }

  Duration _normalize(Duration target) {
    var milliseconds = target.inMilliseconds;
    if (milliseconds < 0) {
      milliseconds = 0;
    }
    final duration = _playback.duration;
    if (duration > Duration.zero && milliseconds > duration.inMilliseconds) {
      milliseconds = duration.inMilliseconds;
    }
    return Duration(milliseconds: milliseconds);
  }

  bool _isCurrent(_InteractiveSeekSession session) =>
      identical(_interactiveSession, session) &&
      _playback.isCurrentPlayer(session.player) &&
      (session.player.platform as NativePlayer).mediaGeneration ==
          session.generation;

  void _finish(_InteractiveSeekSession session) {
    if (session.finished) return;
    session.finished = true;
    session.monitor?.endSeek();
  }

  Future<void> _settle(Future<void> operation) async {
    try {
      await operation;
    } catch (_) {
      // The caller receives the error; the queue only needs to remain usable.
    }
  }
}
