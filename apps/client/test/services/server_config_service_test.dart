import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/request/config/api_endpoints.dart';
import 'package:kazumi/services/server/server_config_service.dart';

void main() {
  tearDown(() {
    ApiEndpoints.configureServer(ApiEndpoints.defaultSelfBackend);
  });

  group('ServerConfigService.normalizeAddress', () {
    test('adds the default scheme and port to a bare IP', () {
      expect(
        ServerConfigService.normalizeAddress('192.0.2.10'),
        'http://192.0.2.10:3000',
      );
    });

    test('preserves explicit schemes and ports', () {
      expect(
        ServerConfigService.normalizeAddress('http://192.0.2.10:8080/'),
        'http://192.0.2.10:8080',
      );
      expect(
        ServerConfigService.normalizeAddress('https://anime.example.com'),
        'https://anime.example.com',
      );
    });

    test('rejects non-root and unsupported addresses', () {
      expect(
        () => ServerConfigService.normalizeAddress(
          'http://192.0.2.10:3000/api',
        ),
        throwsFormatException,
      );
      expect(
        () => ServerConfigService.normalizeAddress('ftp://192.0.2.10'),
        throwsFormatException,
      );
      expect(
        () => ServerConfigService.normalizeAddress(''),
        throwsFormatException,
      );
    });
  });

  test('configured server updates every derived backend endpoint', () {
    ApiEndpoints.configureServer('http://192.0.2.25:4000/');

    expect(ApiEndpoints.selfBackend, 'http://192.0.2.25:4000');
    expect(
      ApiEndpoints.latestAppMirror,
      'http://192.0.2.25:4000/kazumi/v1/app/latest',
    );
    expect(ApiEndpoints.bangumiAPIDomain, 'http://192.0.2.25:4000/kazumi');
    expect(
      ApiEndpoints.bangumiAuthAPIMirrorDomain,
      'http://192.0.2.25:4000/kazumi',
    );
    expect(
      ApiEndpoints.bangumiAPINextDomain,
      'http://192.0.2.25:4000/kazumi',
    );
  });
}
