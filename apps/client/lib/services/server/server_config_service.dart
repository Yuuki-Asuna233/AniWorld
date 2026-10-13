import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:kazumi/request/config/api_endpoints.dart';
import 'package:kazumi/request/core/dio_factory.dart';
import 'package:kazumi/services/access/access_gate_service.dart';
import 'package:kazumi/services/storage/storage.dart';
import 'package:kazumi/services/sync/history_sync_service.dart';

class ServerConfigService {
  ServerConfigService._();

  static String get currentAddress => ApiEndpoints.selfBackend;

  static String normalizeAddress(String input) {
    final raw = input.trim();
    if (raw.isEmpty) {
      throw const FormatException('请输入服务器 IP 或地址');
    }

    final hasScheme = RegExp(
      r'^[a-zA-Z][a-zA-Z0-9+.-]*://',
    ).hasMatch(raw);
    final parsed = Uri.tryParse(hasScheme ? raw : 'http://$raw');
    if (parsed == null || parsed.host.isEmpty) {
      throw const FormatException('服务器地址格式不正确');
    }

    final scheme = parsed.scheme.toLowerCase();
    if (scheme != 'http' && scheme != 'https') {
      throw const FormatException('服务器地址只支持 HTTP 或 HTTPS');
    }
    if (parsed.userInfo.isNotEmpty ||
        parsed.hasQuery ||
        parsed.hasFragment ||
        (parsed.path.isNotEmpty && parsed.path != '/')) {
      throw const FormatException('请输入服务器根地址，不要包含路径、参数或账号');
    }

    final port = parsed.hasPort ? parsed.port : (hasScheme ? null : 3000);
    return Uri(
      scheme: scheme,
      host: parsed.host,
      port: port,
    ).toString().replaceFirst(RegExp(r'/+$'), '');
  }

  static Future<ServerTestResult> testAddress(String input) async {
    late final String normalized;
    try {
      normalized = normalizeAddress(input);
    } on FormatException catch (error) {
      return ServerTestResult.failure(error.message);
    }

    final client = HttpClient()..connectionTimeout = const Duration(seconds: 6);
    try {
      final uri = Uri.parse(normalized).resolve('/api/access/status');
      final request = await client.getUrl(uri).timeout(
            const Duration(seconds: 8),
          );
      request.headers.set(HttpHeaders.acceptHeader, 'application/json');
      final response = await request.close().timeout(
            const Duration(seconds: 8),
          );
      final body = await response.transform(utf8.decoder).join().timeout(
            const Duration(seconds: 8),
          );

      if (response.statusCode != HttpStatus.ok) {
        return ServerTestResult.failure(
          '服务器返回 HTTP ${response.statusCode}，无法使用',
          normalizedAddress: normalized,
        );
      }

      final decoded = jsonDecode(body);
      if (decoded is! Map || !AccessGateService.isCompatibleStatus(decoded)) {
        return ServerTestResult.failure(
          '地址可以访问，但不是兼容的 AniWorld 服务器',
          normalizedAddress: normalized,
        );
      }

      return ServerTestResult.success(
        normalized,
        '连接成功，已识别 AniWorld 服务',
      );
    } on TimeoutException {
      return ServerTestResult.failure(
        '连接超时，请检查 IP、端口和服务器防火墙',
        normalizedAddress: normalized,
      );
    } on HandshakeException {
      return ServerTestResult.failure(
        'HTTPS 证书验证失败',
        normalizedAddress: normalized,
      );
    } on SocketException catch (error) {
      return ServerTestResult.failure(
        '无法连接服务器：${error.message}',
        normalizedAddress: normalized,
      );
    } on FormatException {
      return ServerTestResult.failure(
        '服务器响应格式不正确',
        normalizedAddress: normalized,
      );
    } catch (error) {
      return ServerTestResult.failure(
        '测试失败：$error',
        normalizedAddress: normalized,
      );
    } finally {
      client.close(force: true);
    }
  }

  static Future<bool> applyAddress(String input) async {
    final normalized = normalizeAddress(input);
    final changed = await HistorySyncService().withLocalLock(() async {
      if (normalized == currentAddress) return false;
      await GStorage.switchAccount(null, '', '', serverAddress: normalized,
          onCommitted: () {
        AccessGateService.invalidateForServerChange();
        ApiEndpoints.configureServer(normalized);
        DioFactory.reset();
      });
      return true;
    });
    if (changed) AccessGateService.onAccessRequired?.call();
    return changed;
  }
}

class ServerTestResult {
  const ServerTestResult._({
    required this.success,
    required this.message,
    this.normalizedAddress,
  });

  factory ServerTestResult.success(String address, String message) {
    return ServerTestResult._(
      success: true,
      message: message,
      normalizedAddress: address,
    );
  }

  factory ServerTestResult.failure(
    String message, {
    String? normalizedAddress,
  }) {
    return ServerTestResult._(
      success: false,
      message: message,
      normalizedAddress: normalizedAddress,
    );
  }

  final bool success;
  final String message;
  final String? normalizedAddress;
}
