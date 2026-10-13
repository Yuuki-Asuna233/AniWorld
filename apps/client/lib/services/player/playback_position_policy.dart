import 'dart:math' as math;

/// Whether a decoder EOF can be treated as the real end of the episode.
///
/// Network interruptions and malformed manifests can also make mpv report EOF.
/// Auto-next is only safe when the reported position is actually near the
/// media duration.
bool isPlaybackAtConfirmedEnd({
  required bool completed,
  required Duration position,
  required Duration duration,
}) {
  if (!completed || duration <= Duration.zero || position < Duration.zero) {
    return false;
  }

  final durationMs = duration.inMilliseconds;
  final positionMs = position.inMilliseconds;
  final proportionalTolerance = (durationMs * 0.005).round();
  final toleranceMs = math.max(
    2000,
    math.min(5000, proportionalTolerance),
  );
  return positionMs >= durationMs - toleranceMs;
}

/// Only a known duration allows distinguishing a truncated stream from a
/// genuine end. Unknown-duration media must not enter an EOF recovery loop.
bool isPlaybackAtPrematureEnd({
  required bool completed,
  required Duration position,
  required Duration duration,
}) =>
    completed &&
    duration > Duration.zero &&
    position >= Duration.zero &&
    !isPlaybackAtConfirmedEnd(
      completed: completed,
      position: position,
      duration: duration,
    );
