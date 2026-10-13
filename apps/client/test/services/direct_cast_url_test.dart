import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/services/player/remote.dart';

void main() {
  const backend = 'http://121.4.90.108:3000';
  const direct =
      'https://v6.douyinvod.com/video/file.mp4?filename=episode-01.mp4';

  test('keeps a direct CDN URL unchanged', () {
    expect(
      buildDirectCastUrl(video: direct, backendUrl: backend),
      direct,
    );
  });

  test('unwraps the original CDN URL from the AniWorld video proxy', () {
    final proxy = Uri.parse(backend).replace(
      path: '/api/video',
      queryParameters: {
        'url': direct,
        'referer': 'https://example.com/watch',
        'access_token': 'not-forwarded-to-the-renderer',
      },
    );

    expect(
      buildDirectCastUrl(video: proxy.toString(), backendUrl: backend),
      direct,
    );
  });

  test('unwraps accidentally nested video proxies', () {
    final firstProxy = Uri.parse(backend).replace(
      path: '/api/video',
      queryParameters: {'url': direct},
    );
    final nestedProxy = Uri.parse(backend).replace(
      path: '/api/video',
      queryParameters: {'url': firstProxy.toString()},
    );

    expect(
      buildDirectCastUrl(video: nestedProxy.toString(), backendUrl: backend),
      direct,
    );
  });

  test('does not rewrite unrelated backend URLs', () {
    const unrelated = '$backend/app-releases/example.mp4';
    expect(
      buildDirectCastUrl(video: unrelated, backendUrl: backend),
      unrelated,
    );
  });
}
