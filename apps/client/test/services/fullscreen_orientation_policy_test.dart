import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/services/platform/fullscreen_orientation_policy.dart';

void main() {
  test('does not exit during an explicit landscape transition', () {
    expect(
      shouldExitFullscreenForPortrait(
        isFullscreen: true,
        explicitLandscapeFullscreen: true,
      ),
      isFalse,
    );
  });

  test('exits when an auto-rotated fullscreen returns to portrait', () {
    expect(
      shouldExitFullscreenForPortrait(
        isFullscreen: true,
        explicitLandscapeFullscreen: false,
      ),
      isTrue,
    );
  });

  test('does nothing when fullscreen is already off', () {
    expect(
      shouldExitFullscreenForPortrait(
        isFullscreen: false,
        explicitLandscapeFullscreen: false,
      ),
      isFalse,
    );
  });

  test('does not re-enter while an explicit exit is rotating to portrait', () {
    expect(
      shouldEnterFullscreenForLandscape(
        isFullscreen: false,
        suppressAutoEnter: true,
      ),
      isFalse,
    );
  });

  test('auto-enters for a normal device rotation to landscape', () {
    expect(
      shouldEnterFullscreenForLandscape(
        isFullscreen: false,
        suppressAutoEnter: false,
      ),
      isTrue,
    );
  });
}
