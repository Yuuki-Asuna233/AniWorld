import 'package:media_kit/media_kit.dart';

/// Missing metrics remain unknown and never change the prefetch policy.
class PlaybackCacheState {
  PlaybackCacheState._(this._values);
  final Map<String, Object?> _values;

  static Future<PlaybackCacheState> read(Player player) async {
    final value = await (player.platform as NativePlayer)
        .getPropertyNode('demuxer-cache-state');
    if (value is! Map<String, Object?>) {
      throw StateError('mpv cache state is not a map');
    }
    return PlaybackCacheState._(value);
  }

  int? get diskBytes => _integer('file-cache-bytes');
  int? get inputBytesPerSecond => _integer('raw-input-rate');
  bool get fullyCached =>
      _values['bof-cached'] == true &&
      _values['eof-cached'] == true &&
      _ranges.length == 1;

  int? _integer(String key) {
    final value = _values[key];
    return value is num && value.isFinite && value >= 0 ? value.toInt() : null;
  }

  List<dynamic> get _ranges => _values['seekable-ranges'] is List
      ? _values['seekable-ranges'] as List
      : const [];

  /// Only the continuous range containing the playhead contributes to the bar.
  Duration? bufferedUntil(Duration position, Duration duration) {
    final seconds = position.inMicroseconds / Duration.microsecondsPerSecond;
    for (final range in _ranges) {
      if (range is! Map) continue;
      final start = range['start'], end = range['end'];
      if (start is! num || end is! num || !start.isFinite || !end.isFinite) {
        continue;
      }
      // A premature network EOF must not paint an uncached tail as complete.
      if (fullyCached &&
          duration > Duration.zero &&
          end >=
              duration.inMicroseconds / Duration.microsecondsPerSecond - 0.5) {
        return duration;
      }
      if (seconds < start - 0.5 || seconds > end + 0.5) continue;
      final buffered = Duration(
          microseconds: (end * Duration.microsecondsPerSecond).round());
      return duration > Duration.zero && buffered > duration
          ? duration
          : buffered;
    }
    return null;
  }
}
