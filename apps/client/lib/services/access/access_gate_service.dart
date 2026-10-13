import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:kazumi/request/config/api_endpoints.dart';
import 'package:kazumi/services/storage/storage.dart';

class AccessGateService {
  AccessGateService._();

  static String _token = '';
  static bool _storageLoaded = false;
  static bool _verifiedForCurrentProcess = false;
  static int _generation = 0;

  /// Called when the backend rejects an authenticated request.
  ///
  /// The UI registers this callback so an expired/revoked token immediately
  /// returns the whole app to the access page instead of leaving a broken
  /// home page on screen.
  static void Function()? onAccessRequired;

  static String get _currentToken {
    if (!_storageLoaded) {
      _token = GStorage.getSetting(SettingsKeys.accessGateToken).trim();
      _storageLoaded = true;
    }
    return _token;
  }

  /// Whether access has been verified during this app process.
  ///
  /// An unexpired persisted token can unlock cached content immediately;
  /// [checkAccess] then validates it without rebuilding the application.
  static bool get isUnlocked => _verifiedForCurrentProcess;

  /// Reuse a server-issued, unexpired JWT for the first frame, then verify it
  /// in the background. A protected request still locks the app immediately
  /// when the server reports revocation or expiry.
  static bool tryFastUnlock() {
    final token = _currentToken;
    if (token.isEmpty) return false;
    try {
      final parts = token.split('.');
      if (parts.length != 3) return false;
      final payload = jsonDecode(
        utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))),
      );
      if (payload is! Map) return false;
      final expiresAt = int.tryParse('${payload['exp'] ?? ''}') ?? 0;
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      if (expiresAt <= now + 60) return false;
      _verifiedForCurrentProcess = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  static bool isAniWorldBackend(Uri uri) {
    final backend = Uri.parse(ApiEndpoints.selfBackend);
    return uri.scheme == backend.scheme &&
        uri.host == backend.host &&
        uri.port == backend.port;
  }

  static Map<String, String> get requestHeaders => {
        if (_currentToken.isNotEmpty) 'X-AniWorld-Access': _currentToken,
      };

  static Future<bool> checkAccess() async {
    final generation = _generation;
    if (_currentToken.isEmpty) {
      _verifiedForCurrentProcess = false;
      return false;
    }
    final fastUnlocked = _verifiedForCurrentProcess;
    try {
      final result = await _request('/api/access/status');
      if (generation != _generation) return false;
      if (result.statusCode != 200 || result.data['unlocked'] != true) {
        clear();
        return false;
      }
      _verifiedForCurrentProcess = true;
      return true;
    } catch (_) {
      if (generation != _generation) return false;
      // A network outage is not proof that a locally unexpired token was
      // revoked. Keep the cached/offline experience available; the interceptor
      // will lock the app on the first explicit 401 from the backend.
      _verifiedForCurrentProcess = fastUnlocked;
      return fastUnlocked;
    }
  }

  static Future<AccessUnlockResult> unlock(String password) async {
    if (password.length != 18) {
      return const AccessUnlockResult(success: false, message: '访问密码必须为 18 位');
    }
    final generation = _generation;
    try {
      final result = await _request(
        '/api/access/unlock',
        method: 'POST',
        body: {'password': password},
      );
      final token = '${result.data['token'] ?? ''}'.trim();
      if (generation != _generation) {
        return const AccessUnlockResult(
            success: false, message: '服务器已切换，请重新验证');
      }
      if (result.statusCode == 200 && token.isNotEmpty) {
        final unlockedGeneration = ++_generation;
        _token = token;
        _storageLoaded = true;
        _verifiedForCurrentProcess = true;
        await GStorage.putSetting(SettingsKeys.accessGateToken, token);
        if (unlockedGeneration != _generation) {
          return const AccessUnlockResult(
              success: false, message: '访问状态已变化，请重新验证');
        }
        return const AccessUnlockResult(success: true, message: '验证成功');
      }
      return AccessUnlockResult(
        success: false,
        message: '${result.data['message'] ?? '访问密码错误'}',
      );
    } catch (_) {
      return const AccessUnlockResult(
        success: false,
        message: '无法连接服务器，请检查网络后重试',
      );
    }
  }

  static void clear() {
    invalidateForServerChange();
    unawaited(GStorage.putSetting(SettingsKeys.accessGateToken, ''));
  }

  static void invalidateForServerChange() {
    _generation++;
    _token = '';
    _storageLoaded = true;
    _verifiedForCurrentProcess = false;
  }

  static void requireUnlock() {
    clear();
    onAccessRequired?.call();
  }

  static Future<void> resetForServerChange() async {
    invalidateForServerChange();
    await GStorage.putSetting(SettingsKeys.accessGateToken, '');
    onAccessRequired?.call();
  }

  static String addMediaToken(String url) {
    if (_currentToken.isEmpty) return url;
    final uri = Uri.tryParse(url);
    if (uri == null || !isAniWorldBackend(uri) || uri.path != '/api/video') {
      return url;
    }
    return uri.replace(
      queryParameters: {
        ...uri.queryParameters,
        'access_token': _currentToken,
      },
    ).toString();
  }

  static Future<_AccessResponse> _request(
    String path, {
    String method = 'GET',
    Map<String, dynamic>? body,
  }) async {
    final generation = _generation;
    final uri = Uri.parse(ApiEndpoints.selfBackend).resolve(path);
    final headers = requestHeaders;
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 4);
    try {
      final request = method == 'POST'
          ? await client.postUrl(uri)
          : await client.getUrl(uri);
      if (generation != _generation) throw StateError('服务器已切换');
      request.followRedirects = false;
      request.headers.set(HttpHeaders.acceptHeader, 'application/json');
      for (final entry in headers.entries) {
        request.headers.set(entry.key, entry.value);
      }
      if (body != null) {
        request.headers.contentType = ContentType.json;
        request.write(jsonEncode(body));
      }
      final response = await request.close().timeout(
            const Duration(seconds: 6),
          );
      final text = await response.transform(utf8.decoder).join();
      Map<String, dynamic> data = {};
      if (text.isNotEmpty) {
        final decoded = jsonDecode(text);
        if (decoded is Map) data = Map<String, dynamic>.from(decoded);
      }
      return _AccessResponse(response.statusCode, data);
    } finally {
      client.close(force: true);
    }
  }
}

class AccessGateInterceptor extends Interceptor {
  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    if (AccessGateService.isAniWorldBackend(options.uri)) {
      options.headers.addAll(AccessGateService.requestHeaders);
    }
    handler.next(options);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    final data = err.response?.data;
    if (err.response?.statusCode == 401 &&
        AccessGateService.isAniWorldBackend(err.requestOptions.uri) &&
        err.requestOptions.headers['X-AniWorld-Access'] ==
            AccessGateService._currentToken &&
        data is Map &&
        data['error'] == 'ACCESS_REQUIRED') {
      AccessGateService.requireUnlock();
    }
    handler.next(err);
  }
}

class AccessUnlockResult {
  const AccessUnlockResult({required this.success, required this.message});

  final bool success;
  final String message;
}

class _AccessResponse {
  const _AccessResponse(this.statusCode, this.data);

  final int statusCode;
  final Map<String, dynamic> data;
}
