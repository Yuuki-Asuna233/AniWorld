import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/services/download/download_manager.dart';

void main() {
  group('direct download completion', () {
    test('rejects empty and truncated responses', () {
      expect(isDirectDownloadComplete(0, 0), isFalse);
      expect(isDirectDownloadComplete(90, 100), isFalse);
      expect(isDirectDownloadComplete(101, 100), isFalse);
    });

    test('accepts exact known length and non-empty unknown length', () {
      expect(isDirectDownloadComplete(100, 100), isTrue);
      expect(isDirectDownloadComplete(100, 0), isTrue);
    });
  });

  group('bounded range responses', () {
    test('continues after a complete intermediate chunk', () {
      expect(
        shouldContinueBoundedRange(
          actualBytes: 4 * 1024 * 1024,
          totalBytes: 500 * 1024 * 1024,
          expectedRangeEnd: 4 * 1024 * 1024,
          previousBytes: 0,
        ),
        isTrue,
      );
    });

    test('does not accept a prematurely closed range', () {
      expect(
        shouldContinueBoundedRange(
          actualBytes: 2 * 1024 * 1024,
          totalBytes: 500 * 1024 * 1024,
          expectedRangeEnd: 4 * 1024 * 1024,
          previousBytes: 0,
        ),
        isFalse,
      );
    });
  });
}
