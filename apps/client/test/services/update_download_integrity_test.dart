import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/services/update/auto_updater.dart';

void main() {
  test('download attempt URL bypasses caches and preserves existing query', () {
    final first = buildUpdateDownloadAttemptUrl(
      'http://example.com/app.apk?channel=stable',
      expectedHash: '93eec4cb306ea988bced3a7cd4280fe2',
      attempt: 1,
      nonce: 100,
    );
    final second = buildUpdateDownloadAttemptUrl(
      'http://example.com/app.apk?channel=stable',
      expectedHash: '93eec4cb306ea988bced3a7cd4280fe2',
      attempt: 2,
      nonce: 101,
    );

    expect(Uri.parse(first).queryParameters['channel'], 'stable');
    expect(
      Uri.parse(first).queryParameters['_aniworld_update'],
      '93eec4cb306e-1-100',
    );
    expect(first, isNot(second));
  });

  test('integrity requires both expected size and hash to match', () {
    expect(
      updateFileMatches(
        actualSize: 100,
        actualHash: 'abcdef',
        expectedSize: 100,
        expectedHash: 'ABCDEF',
      ),
      isTrue,
    );
    expect(
      updateFileMatches(
        actualSize: 99,
        actualHash: 'abcdef',
        expectedSize: 100,
        expectedHash: 'abcdef',
      ),
      isFalse,
    );
    expect(
      updateFileMatches(
        actualSize: 100,
        actualHash: 'bad',
        expectedSize: 100,
        expectedHash: 'abcdef',
      ),
      isFalse,
    );
  });
}
