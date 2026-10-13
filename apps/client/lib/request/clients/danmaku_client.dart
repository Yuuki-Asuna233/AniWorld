import 'package:dio/dio.dart';
import 'package:kazumi/request/core/dio_factory.dart';
import 'package:kazumi/request/core/network_error_mapper.dart';
import 'package:kazumi/utils/dandan_credentials.dart';
import 'package:kazumi/utils/http_headers.dart';
import 'package:kazumi/utils/crypto.dart';
import 'package:kazumi/request/config/api_endpoints.dart';

class DanmakuClient {
  DanmakuClient._();

  static final DanmakuClient instance = DanmakuClient._();
  static const Duration _receiveTimeout = Duration(seconds: 35);
  static const Duration _retryDelay = Duration(milliseconds: 600);

  Future<dynamic> get(
    String url, {
    Map<String, dynamic>? queryParameters,
    Map<String, dynamic> headers = const {},
    CancelToken? cancelToken,
  }) async {
    final appId = dandanCredentials['id']?.trim() ?? '';
    final apiKey = dandanCredentials['value']?.trim() ?? '';
    if (appId.isEmpty || apiKey.isEmpty) {
      return _getThroughAniWorldProxy(
        url,
        queryParameters: queryParameters,
        cancelToken: cancelToken,
      );
    }

    final timestamp = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final uri = Uri.parse(url);
    final requestHeaders = <String, dynamic>{
      'user-agent': getRandomUA(),
      'referer': '',
      'X-Auth': 1,
      'X-AppId': appId,
      'X-Timestamp': timestamp,
      'X-Signature': generateDandanSignature(uri.path, timestamp),
      ...headers,
    };

    return _getWithRetry(
      url,
      queryParameters: queryParameters,
      headers: requestHeaders,
      cancelToken: cancelToken,
    );
  }

  Future<dynamic> _getThroughAniWorldProxy(
    String url, {
    Map<String, dynamic>? queryParameters,
    CancelToken? cancelToken,
  }) async {
    final uri = Uri.parse(url);
    final params = <String, dynamic>{
      'path': uri.path,
      ...uri.queryParameters,
      ...?queryParameters,
    };
    return _getWithRetry(
      '${ApiEndpoints.selfBackend}/api/danmaku/proxy',
      queryParameters: params,
      headers: {'user-agent': getRandomUA()},
      cancelToken: cancelToken,
    );
  }

  Future<dynamic> _getWithRetry(
    String url, {
    Map<String, dynamic>? queryParameters,
    required Map<String, dynamic> headers,
    CancelToken? cancelToken,
  }) async {
    DioException? lastError;
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        final response = await DioFactory.apiDio.get(
          url,
          queryParameters: queryParameters,
          options: Options(
            headers: headers,
            receiveTimeout: _receiveTimeout,
          ),
          cancelToken: cancelToken,
        );
        return response.data;
      } on DioException catch (error) {
        lastError = error;
        if (attempt > 0 || !_isRetryable(error)) break;
        await Future<void>.delayed(_retryDelay);
      }
    }
    throw await NetworkErrorMapper.mapException(lastError!);
  }

  bool _isRetryable(DioException error) {
    if (error.type == DioExceptionType.cancel ||
        error.response?.statusCode == 401) {
      return false;
    }
    if (error.type == DioExceptionType.connectionError ||
        error.type == DioExceptionType.connectionTimeout ||
        error.type == DioExceptionType.receiveTimeout ||
        error.type == DioExceptionType.sendTimeout ||
        error.type == DioExceptionType.unknown) {
      return true;
    }
    final status = error.response?.statusCode ?? 0;
    return status == 408 || status == 429 || status >= 500;
  }
}
