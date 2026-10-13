import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_cache_manager/flutter_cache_manager.dart';
import 'package:kazumi/services/logging/logger.dart';
import 'package:kazumi/services/network/proxy_utils.dart';
import 'package:kazumi/services/network/cover_image_policy.dart';
import 'package:kazumi/services/storage/storage.dart';

class ProxyAwareImageCacheManager extends CacheManager with ImageCacheManager {
  static final ProxyAwareImageCacheManager instance =
      ProxyAwareImageCacheManager._();

  ProxyAwareImageCacheManager._()
      : super(
          Config(
            DefaultCacheManager.key,
            fileService: ProxyAwareImageFileService(),
          ),
        );

  @override
  Future<FileInfo?> getFileFromCache(String key,
      {bool ignoreMemCache = false}) async {
    final cached =
        await super.getFileFromCache(key, ignoreMemCache: ignoreMemCache);
    if (cached == null ||
        !CoverImagePolicy.shouldValidate(cached.originalUrl)) {
      return cached;
    }
    if (await cached.file.length() <= CoverImagePolicy.placeholderMaxBytes &&
        CoverImagePolicy.isTransparentPlaceholder(
            await cached.file.readAsBytes())) {
      await removeFile(key);
      KazumiLogger().w('NetworkImage: removed transparent cover placeholder');
      return null;
    }
    return cached;
  }
}

class ProxyAwareImageFileService extends FileService {
  static String rewriteBangumiMirrorImageUrl(
    String url, {
    required bool enableBangumiProxy,
  }) {
    if (!enableBangumiProxy) return url;

    final uri = Uri.tryParse(url);
    if (uri == null || uri.host != 'lain.bgm.tv') return url;
    if (uri.scheme != 'http' && uri.scheme != 'https') return url;

    final sourceUrl =
        uri.host + uri.path + (uri.hasQuery ? '?${uri.query}' : '');
    return 'https://wsrv.nl/?url=$sourceUrl';
  }

  @override
  Future<FileServiceResponse> get(
    String url, {
    Map<String, String>? headers,
  }) async {
    final client = _createHttpClient();
    try {
      final request = await client
          .getUrl(Uri.parse(
            rewriteBangumiMirrorImageUrl(
              url,
              enableBangumiProxy: _bangumiMirrorEnabled(),
            ),
          ))
          .timeout(const Duration(seconds: 15));
      headers?.forEach(request.headers.set);
      final response =
          await request.close().timeout(const Duration(seconds: 15));
      // The cache manager does not consume bodies for 304/error responses.
      if (response.statusCode != 200 && response.statusCode != 202) {
        client.close(force: true);
      }
      Uint8List? smallCover;
      if ((response.statusCode == 200 || response.statusCode == 202) &&
          CoverImagePolicy.shouldValidate(url) &&
          response.contentLength >= 0 &&
          response.contentLength <= CoverImagePolicy.placeholderMaxBytes) {
        final bytes = BytesBuilder(copy: false);
        await for (final chunk
            in response.timeout(const Duration(seconds: 15))) {
          if (bytes.length + chunk.length >
              CoverImagePolicy.placeholderMaxBytes) {
            throw const FormatException('Invalid small cover content length');
          }
          bytes.add(chunk);
        }
        smallCover = bytes.takeBytes();
        client.close(force: true);
        if (CoverImagePolicy.isTransparentPlaceholder(smallCover)) {
          // Reject before the cache manager creates a file for this response.
          throw const FormatException('Transparent cover placeholder');
        }
      }
      return _ProxyAwareImageFileServiceResponse(
          response, client, url, smallCover);
    } catch (_) {
      client.close(force: true);
      rethrow;
    }
  }

  bool _bangumiMirrorEnabled() {
    return GStorage.getSetting(SettingsKeys.enableBangumiProxy);
  }

  HttpClient _createHttpClient() {
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 10);
    final proxy = _currentProxy();
    if (proxy == null) return client;

    client.findProxy = (_) => 'PROXY ${proxy.$1}:${proxy.$2}';
    return client;
  }

  (String, int)? _currentProxy() {
    final bool proxyEnable = GStorage.getSetting(SettingsKeys.proxyEnable);
    if (!proxyEnable) return null;

    final String proxyUrl = GStorage.getSetting(SettingsKeys.proxyUrl);
    final parsed = ProxyUtils.parseProxyUrl(proxyUrl);
    if (parsed == null) {
      KazumiLogger().w('Proxy: 图片缓存代理地址格式错误或为空');
    }
    return parsed;
  }
}

class _ProxyAwareImageFileServiceResponse implements FileServiceResponse {
  _ProxyAwareImageFileServiceResponse(
      this._response, this._client, this._url, this._smallCover);

  final HttpClientResponse _response;
  final HttpClient _client;
  final String _url;
  final Uint8List? _smallCover;
  final DateTime _receivedTime = DateTime.now();

  @override
  Stream<List<int>> get content async* {
    try {
      if (_smallCover != null) {
        yield _smallCover;
        return;
      }
      final prefix = BytesBuilder(copy: false);
      var inspect = CoverImagePolicy.shouldValidate(_url);
      await for (final chunk
          in _response.timeout(const Duration(seconds: 15))) {
        if (inspect) {
          if (prefix.length + chunk.length <=
              CoverImagePolicy.placeholderMaxBytes) {
            prefix.add(chunk);
            continue;
          }
          inspect = false;
          if (prefix.isNotEmpty) yield prefix.takeBytes();
        }
        yield chunk;
      }
      if (inspect) {
        final bytes = prefix.takeBytes();
        if (CoverImagePolicy.isTransparentPlaceholder(bytes)) {
          throw const FormatException('Transparent cover placeholder');
        }
        if (bytes.isNotEmpty) yield bytes;
      }
    } finally {
      _client.close(force: true);
    }
  }

  @override
  int? get contentLength =>
      _response.contentLength >= 0 ? _response.contentLength : null;

  @override
  String? get eTag => _response.headers.value(HttpHeaders.etagHeader);

  @override
  String get fileExtension {
    return switch (_response.headers.contentType?.mimeType.toLowerCase()) {
      'image/jpeg' => '.jpg',
      'image/png' => '.png',
      'image/gif' => '.gif',
      'image/webp' => '.webp',
      'image/bmp' => '.bmp',
      'image/x-icon' || 'image/vnd.microsoft.icon' => '.ico',
      'image/avif' => '.avif',
      'image/svg+xml' => '.svg',
      _ => '',
    };
  }

  @override
  int get statusCode => _response.statusCode;

  @override
  DateTime get validTill {
    final controlHeader =
        _response.headers.value(HttpHeaders.cacheControlHeader);
    final settings = (controlHeader ?? '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .toList();
    if (settings.any((value) {
      final directive = value.split('=').first.trim();
      return directive == 'no-store' || directive == 'no-cache';
    })) {
      return _receivedTime;
    }
    for (final setting in settings) {
      final match = RegExp(r'^max-age="?(\d+)"?$').firstMatch(setting);
      final seconds = int.tryParse(match?.group(1) ?? '');
      if (seconds == null) continue;
      final age =
          int.tryParse(_response.headers.value(HttpHeaders.ageHeader) ?? '') ??
              0;
      final date = _parseDate(_response.headers.value(HttpHeaders.dateHeader));
      final apparentAge =
          date == null ? 0 : _receivedTime.difference(date).inSeconds;
      final elapsed = age > apparentAge ? age : apparentAge;
      final remaining = seconds - (elapsed > 0 ? elapsed : 0);
      return _receivedTime
          .add(Duration(seconds: remaining > 0 ? remaining : 0));
    }
    final expiresHeader = _response.headers.value(HttpHeaders.expiresHeader);
    if (expiresHeader != null) {
      return _parseDate(expiresHeader) ?? _receivedTime;
    }
    return _receivedTime.add(const Duration(days: 7));
  }

  DateTime? _parseDate(String? value) {
    if (value == null) return null;
    try {
      return HttpDate.parse(value);
    } on FormatException {
      return null;
    }
  }
}
