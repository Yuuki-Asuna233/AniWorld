import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/services/player/playback_position_policy.dart';

void main() {
  group('isPlaybackAtConfirmedEnd', () {
    test('rejects an early decoder EOF', () {
      expect(
        isPlaybackAtConfirmedEnd(
          completed: true,
          position: const Duration(minutes: 3, seconds: 20),
          duration: const Duration(minutes: 23, seconds: 40),
        ),
        isFalse,
      );
    });

    test('accepts EOF within the end tolerance', () {
      expect(
        isPlaybackAtConfirmedEnd(
          completed: true,
          position: const Duration(minutes: 23, seconds: 39),
          duration: const Duration(minutes: 23, seconds: 40),
        ),
        isTrue,
      );
    });

    test('rejects EOF before duration is known', () {
      expect(
        isPlaybackAtConfirmedEnd(
          completed: true,
          position: Duration.zero,
          duration: Duration.zero,
        ),
        isFalse,
      );
    });

    test('does not auto-next without EOF', () {
      expect(
        isPlaybackAtConfirmedEnd(
          completed: false,
          position: const Duration(minutes: 23, seconds: 40),
          duration: const Duration(minutes: 23, seconds: 40),
        ),
        isFalse,
      );
    });
  });
}
