import 'dart:convert';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/modules/bangumi/bangumi_tag.dart';
import 'package:kazumi/modules/comments/comment_item.dart';
import 'package:kazumi/modules/notifications/comment_notification.dart';
import 'package:kazumi/request/config/api_endpoints.dart';
import 'package:kazumi/request/core/dio_factory.dart';
import 'package:kazumi/services/storage/storage.dart';
import 'package:kazumi/services/storage/account_identity.dart';
import 'package:kazumi/services/sync/history_sync_service.dart';
import 'package:kazumi/services/access/access_gate_service.dart';
import 'package:path/path.dart' as p;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:kazumi/request/apis/aniworld_models.dart';

export 'package:kazumi/request/apis/aniworld_models.dart';

bool isAniWorldDirectDownload(String videoType, String url) {
  final normalizedType = videoType.toLowerCase();
  final path = Uri.tryParse(url)?.path.toLowerCase() ?? '';
  return !normalizedType.contains('m3u8') &&
      !normalizedType.contains('hls') &&
      !normalizedType.contains('mpegurl') &&
      !path.endsWith('.m3u8') &&
      !path.endsWith('.m3u');
}

bool isPlausibleAniWorldPlaybackUrl(String url) {
  // Validate the transport without guessing which CDN hosts the source uses.
  final uri = Uri.tryParse(url.trim());
  return uri != null &&
      (uri.scheme == 'http' || uri.scheme == 'https') &&
      uri.host.isNotEmpty &&
      uri.userInfo.isEmpty;
}

class AniWorldVideoSource {
  final String directUrl;

  /// Only the download manager may use this compatibility proxy fallback.
  /// Native playback must always open [directUrl].
  final String downloadFallbackUrl;
  final bool isDirectFile;
  final String videoType;

  const AniWorldVideoSource({
    required this.directUrl,
    required this.downloadFallbackUrl,
    required this.isDirectFile,
    this.videoType = '',
  });
}

extension AniWorldAgentCardBangumiMapper on AniWorldAgentCard {
  BangumiItem toBangumiItem() {
    final uri = Uri.tryParse(href);
    final msg = uri?.queryParameters['msg'] ?? title;
    final index = int.tryParse(uri?.queryParameters['n'] ?? '') ?? 1;
    return AniWorldApi.oiToBangumi({
      'anilistId': anilistId,
      'title': title,
      'image': image,
      'score': score,
      'year': year,
      'status': status,
      'oiMsg': msg,
      'oiIndex': index,
    });
  }
}

class AniWorldAccountSnapshot {
  final String owner = GStorage.accountOwner;
  final int revision = GStorage.accountRevision;
  final String token = AniWorldApi.token;
  final String serverId = GStorage.accountIdentity.serverId;
  bool get isCurrent =>
      !GStorage.accountChanging &&
      owner == GStorage.activeAccountOwner &&
      revision == GStorage.accountRevision &&
      serverId == AccountIdentity.serverKey(ApiEndpoints.selfBackend) &&
      token == AniWorldApi.token;
  bool get isLoggedIn =>
      isCurrent &&
      GStorage.accountIdentity.userId != null &&
      token.trim().isNotEmpty;
  Map<String, String> get headers =>
      {if (token.trim().isNotEmpty) 'Authorization': 'Bearer $token'};
  Options get options => Options(headers: headers);
}

class AniWorldApi {
  static String get serverAddress => ApiEndpoints.selfBackend;

  static Dio get _dio => DioFactory.selfBackendDio;
  static final Map<String, _CachedOiDetails> _oiDetailsCache = {};
  static final Map<String, Future<Map<String, dynamic>>> _oiDetailsInFlight =
      {};
  static const Duration _oiDetailsMaxAge = Duration(minutes: 10);
  static final Map<String, _CachedOiSearch> _oiSearchCache = {};
  static final Map<String, Future<List<Map<String, dynamic>>>>
      _oiSearchInFlight = {};
  static const Duration _oiSearchMaxAge = Duration(minutes: 10);

  static String get token => GStorage.getSetting(SettingsKeys.aniworldToken);

  static AniWorldUser? get cachedUser {
    final raw = GStorage.getSetting(SettingsKeys.aniworldUserJson);
    if (raw.trim().isEmpty) return null;
    try {
      return AniWorldUser.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  static bool get isLoggedIn => AniWorldAccountSnapshot().isLoggedIn;

  static Map<String, String> get _authHeaders => {
        if (token.trim().isNotEmpty) 'Authorization': 'Bearer $token',
      };

  static Options get _authOptions => Options(headers: _authHeaders);

  static Future<void> _saveAuth(String nextToken, dynamic userRaw,
      {AniWorldAccountSnapshot? expected}) async {
    final user = userRaw is Map<String, dynamic>
        ? AniWorldUser.fromJson(userRaw)
        : AniWorldUser.fromJson(Map<String, dynamic>.from(userRaw as Map));
    await HistorySyncService().withLocalLock(() async {
      if (expected != null &&
          (!expected.isCurrent || expected.token != token)) {
        throw StateError('账户或服务器已切换，请重新操作');
      }
      await GStorage.switchAccount(
          user.id, nextToken, jsonEncode(user.toJson()));
    });
  }

  static Future<void> logout({AniWorldAccountSnapshot? expected}) =>
      HistorySyncService().withLocalLock(() async {
        if (expected != null &&
            (!expected.isCurrent || expected.token != token)) {
          return;
        }
        await GStorage.switchAccount(null, '', '');
      });

  static Future<AniWorldAuthResult> login({
    required String email,
    required String password,
  }) async {
    final account = AniWorldAccountSnapshot();
    try {
      final response = await _dio.post(
        '/api/auth/login',
        data: {'email': email, 'password': password},
      );
      final data = _asMap(response.data);
      await _saveAuth('${data['token'] ?? ''}', data['user'],
          expected: account);
      return AniWorldAuthResult(
        success: true,
        message: '登录成功',
        user: cachedUser,
      );
    } on DioException catch (e) {
      return AniWorldAuthResult(success: false, message: _errorMessage(e));
    } catch (e) {
      return AniWorldAuthResult(success: false, message: e.toString());
    }
  }

  static Future<AniWorldAuthResult> register({
    required String email,
    required String username,
    required String password,
    required String code,
  }) async {
    final account = AniWorldAccountSnapshot();
    try {
      final response = await _dio.post(
        '/api/auth/register',
        data: {
          'email': email,
          'username': username,
          'password': password,
          'confirmPassword': password,
          'code': code,
        },
      );
      final data = _asMap(response.data);
      await _saveAuth('${data['token'] ?? ''}', data['user'],
          expected: account);
      return AniWorldAuthResult(
        success: true,
        message: '注册成功',
        user: cachedUser,
      );
    } on DioException catch (e) {
      return AniWorldAuthResult(success: false, message: _errorMessage(e));
    } catch (e) {
      return AniWorldAuthResult(success: false, message: e.toString());
    }
  }

  static Future<String> sendRegisterCode(String email) async {
    try {
      final response = await _dio.post(
        '/api/auth/send-code',
        data: {'email': email},
      );
      return '${_asMap(response.data)['message'] ?? 'Code sent'}';
    } on DioException catch (e) {
      return _errorMessage(e);
    }
  }

  static Future<String> sendPasswordResetCode(String email) async {
    try {
      final response = await _dio.post(
        '/api/auth/send-reset-code',
        data: {'email': email},
      );
      return '${_asMap(response.data)['message'] ?? '验证码已发送'}';
    } on DioException catch (e) {
      return _errorMessage(e);
    }
  }

  /// Sends a verification code to a new email address before rebinding it.
  static Future<String> sendEmailChangeCode(String email) async {
    return sendRegisterCode(email);
  }

  static Future<AniWorldAuthResult> changeEmail({
    required String email,
    required String code,
    required String currentPassword,
  }) async {
    final account = AniWorldAccountSnapshot();
    try {
      final response = await _dio.post(
        '/api/auth/change-email',
        data: {
          'email': email,
          'code': code,
          'currentPassword': currentPassword,
        },
        options: account.options,
      );
      final data = _asMap(response.data);
      await _saveAuth('${data['token'] ?? account.token}', data['user'],
          expected: account);
      return AniWorldAuthResult(
        success: true,
        message: '${data['message'] ?? '邮箱修改成功'}',
        user: cachedUser,
      );
    } on DioException catch (e) {
      return AniWorldAuthResult(success: false, message: _errorMessage(e));
    } catch (e) {
      return AniWorldAuthResult(success: false, message: e.toString());
    }
  }

  static Future<AniWorldAuthResult> resetPassword({
    required String email,
    required String code,
    required String newPassword,
    required String confirmPassword,
  }) async {
    try {
      final response = await _dio.post(
        '/api/auth/reset-password',
        data: {
          'email': email,
          'code': code,
          'newPassword': newPassword,
          'confirmPassword': confirmPassword,
        },
      );
      return AniWorldAuthResult(
        success: true,
        message: '${_asMap(response.data)['message'] ?? '密码已重置'}',
      );
    } on DioException catch (e) {
      return AniWorldAuthResult(success: false, message: _errorMessage(e));
    } catch (e) {
      return AniWorldAuthResult(success: false, message: e.toString());
    }
  }

  static Future<AniWorldAuthResult> changePassword({
    required String currentPassword,
    required String newPassword,
    required String confirmPassword,
  }) async {
    try {
      final response = await _dio.post(
        '/api/auth/change-password',
        data: {
          'currentPassword': currentPassword,
          'newPassword': newPassword,
          'confirmPassword': confirmPassword,
        },
        options: _authOptions,
      );
      final message = '${_asMap(response.data)['message'] ?? '密码修改成功'}';
      await logout();
      return AniWorldAuthResult(success: true, message: message);
    } on DioException catch (e) {
      return AniWorldAuthResult(success: false, message: _errorMessage(e));
    } catch (e) {
      return AniWorldAuthResult(success: false, message: e.toString());
    }
  }

  static Future<AniWorldUser?> fetchMe() async {
    final account = AniWorldAccountSnapshot();
    if (!account.isLoggedIn) return null;
    try {
      final response = await _dio.get('/api/auth/me', options: account.options);
      if (!account.isCurrent) return null;
      final user = AniWorldUser.fromJson(_asMap(response.data));
      await _saveAuth(account.token, user.toJson(), expected: account);
      return account.isCurrent ? cachedUser : null;
    } on DioException catch (error) {
      if (!account.isCurrent) return null;
      if (error.response?.statusCode == 401) {
        await logout(expected: account);
        return null;
      }
      return cachedUser;
    } catch (_) {
      return account.isCurrent ? cachedUser : null;
    }
  }

  /// Resolve avatar string to a display-ready image provider or null.
  /// Handles data URLs in memory and stores network avatars in the disk cache.
  static ImageProvider? resolveAvatar(String avatar) {
    final normalizedAvatar = avatar.trim();
    if (normalizedAvatar.isEmpty) return null;
    if (normalizedAvatar.startsWith('data:')) {
      final separatorIndex = normalizedAvatar.indexOf(',');
      if (separatorIndex < 0) return null;
      final base64Str = normalizedAvatar.substring(separatorIndex + 1);
      try {
        return MemoryImage(base64Decode(base64Str));
      } catch (_) {
        return null;
      }
    }
    if (normalizedAvatar.startsWith('http')) {
      final uri = Uri.tryParse(normalizedAvatar);
      return CachedNetworkImageProvider(
        normalizedAvatar,
        headers: uri != null && AccessGateService.isAniWorldBackend(uri)
            ? AccessGateService.requestHeaders
            : null,
        maxWidth: 256,
        maxHeight: 256,
      );
    }
    final avatarUrl = Uri.parse(ApiEndpoints.selfBackend)
        .resolve(normalizedAvatar)
        .toString();
    return CachedNetworkImageProvider(
      avatarUrl,
      headers: AccessGateService.requestHeaders,
      maxWidth: 256,
      maxHeight: 256,
    );
  }

  /// Upload avatar image file to /api/auth/avatar.
  /// Returns updated user on success.
  static Future<AniWorldAuthResult> uploadAvatar(String filePath) async {
    final account = AniWorldAccountSnapshot();
    try {
      final fileName = p.basename(filePath);
      final formData = FormData.fromMap({
        'avatar': await MultipartFile.fromFile(filePath, filename: fileName),
      });
      if (!account.isLoggedIn) throw StateError('账户已切换');
      final response = await _dio.post(
        '/api/auth/avatar',
        data: formData,
        options: account.options,
      );
      final data = _asMap(response.data);
      final nextToken = '${data['token'] ?? account.token}';
      if (data['user'] != null) {
        await _saveAuth(nextToken, data['user'], expected: account);
      }
      return AniWorldAuthResult(
        success: true,
        message: 'Avatar updated',
        user: cachedUser,
      );
    } on DioException catch (e) {
      return AniWorldAuthResult(success: false, message: _errorMessage(e));
    } catch (e) {
      return AniWorldAuthResult(success: false, message: e.toString());
    }
  }

  static Future<AniWorldAuthResult> updateProfile({
    required String username,
    String? avatar,
  }) async {
    final account = AniWorldAccountSnapshot();
    try {
      final response = await _dio.put(
        '/api/auth/profile',
        data: {'username': username, if (avatar != null) 'avatar': avatar},
        options: account.options,
      );
      final data = _asMap(response.data);
      await _saveAuth('${data['token'] ?? account.token}', data['user'],
          expected: account);
      return AniWorldAuthResult(
        success: true,
        message: '${data['message'] ?? 'Profile updated'}',
        user: cachedUser,
      );
    } on DioException catch (e) {
      return AniWorldAuthResult(success: false, message: _errorMessage(e));
    } catch (e) {
      return AniWorldAuthResult(success: false, message: e.toString());
    }
  }

  static Future<AniWorldAgentChatResult> chatWithSession(
    String message, {
    String sessionId = '',
    Map<String, dynamic> pageContext = const {},
    String? requestId,
    String? confirmationId,
    void Function(String text)? onDelta,
    void Function(Map<String, dynamic> event)? onEvent,
    void Function(String name, Map<String, dynamic> args)? onToolStart,
    void Function(String name)? onToolResult,
    CancelToken? cancelToken,
  }) async {
    final account = AniWorldAccountSnapshot();
    if (!account.isCurrent) throw StateError('账户正在切换，请稍后重试');
    try {
      final response = await _dio.post(
        '/api/agent/chat',
        data: {
          'message': message,
          if (confirmationId != null && confirmationId.isNotEmpty)
            'confirmationId': confirmationId,
          if (sessionId.trim().isNotEmpty) 'sessionId': sessionId.trim(),
          if (pageContext.isNotEmpty) 'pageContext': pageContext,
        },
        cancelToken: cancelToken,
        onReceiveProgress: null,
        options: Options(
          receiveTimeout: const Duration(minutes: 6),
          headers: {
            ...account.headers,
            if (requestId != null && requestId.trim().isNotEmpty)
              'X-Agent-Request-Id': requestId.trim(),
          },
          responseType: ResponseType.stream,
        ),
      );
      final raw = StringBuffer();
      void dispatchLine(String line) {
        if (line.trim().isEmpty) return;
        final dynamic decoded;
        try {
          decoded = jsonDecode(line);
        } on FormatException {
          return; // The final protocol validator reports malformed streams.
        }
        if (decoded is! Map || !account.isCurrent) return;
        final event = Map<String, dynamic>.from(decoded);
        onEvent?.call(event);
        if (event['type'] == 'delta') {
          onDelta?.call('${event['text'] ?? ''}');
        } else if (event['type'] == 'tool_start') {
          onToolStart?.call(
              '${event['name'] ?? ''}',
              event['args'] is Map
                  ? Map<String, dynamic>.from(event['args'])
                  : {});
        } else if (event['type'] == 'tool_result') {
          onToolResult?.call('${event['name'] ?? ''}');
        }
      }

      final streamBody =
          response.data is ResponseBody ? response.data as ResponseBody : null;
      if (streamBody != null) {
        final decoder = const Utf8Decoder(allowMalformed: true);
        var pendingLine = '';
        await for (final chunk
            in streamBody.stream.cast<List<int>>().transform(decoder)) {
          raw.write(chunk);
          final lines = '$pendingLine$chunk'.split('\n');
          pendingLine = lines.isEmpty ? '' : lines.removeLast();
          for (final line in lines) {
            dispatchLine(line);
          }
        }
        dispatchLine(pendingLine);
      } else {
        raw.write('${response.data ?? ''}');
      }
      final result = _extractAgentChatResult(raw.toString());
      return AniWorldAgentChatResult(
        answer:
            result.answer.trim().isEmpty ? '白羽暂时没有生成回答，请稍后再试。' : result.answer,
        sessionId: result.sessionId.isEmpty ? sessionId : result.sessionId,
        cards: result.cards,
        suggestions: result.suggestions,
        actions: result.actions,
        plan: result.plan,
      );
    } catch (_) {
      final recovered = await _recoverAgentRequest(requestId, account);
      if (recovered != null) {
        if (cancelToken?.isCancelled == true) {
          final actions = recovered.actions
              .where((action) =>
                  !['play', 'navigate', 'confirm'].contains(action['type']))
              .toList();
          return AniWorldAgentChatResult(
              answer: actions.length == recovered.actions.length
                  ? recovered.answer
                  : '${recovered.answer}\n已停止后续播放、跳转与待确认操作。',
              sessionId: recovered.sessionId,
              cards: recovered.cards,
              suggestions: recovered.suggestions,
              actions: actions,
              plan: recovered.plan);
        }
        return recovered;
      }
      rethrow;
    }
  }

  static Future<AniWorldAgentChatResult?> _recoverAgentRequest(
      String? requestId, AniWorldAccountSnapshot account) async {
    if (requestId == null || requestId.isEmpty || !account.isLoggedIn) {
      return null;
    }
    AniWorldAgentChatResult? confirmedOperations;
    for (var attempt = 0; attempt < 6 && account.isCurrent; attempt++) {
      try {
        final response = await _dio.get(
            '/api/agent/requests/${Uri.encodeComponent(requestId)}',
            options: Options(
                headers: account.headers,
                sendTimeout: const Duration(seconds: 2),
                receiveTimeout: const Duration(seconds: 2)));
        if (!account.isCurrent) return null;
        final data = _asMap(response.data);
        if (['completed', 'operation_completed'].contains(data['status']) &&
            data['result'] is Map) {
          return _extractAgentChatResult(jsonEncode(data['result']));
        }
        if (data['operationCompleted'] == true && data['result'] is Map) {
          confirmedOperations =
              _extractAgentChatResult(jsonEncode(data['result']));
        }
        if (data['status'] != 'running') return null;
      } on DioException catch (error) {
        if ([404, 503].contains(error.response?.statusCode)) return null;
      } catch (_) {
        return null;
      }
      await Future<void>.delayed(const Duration(milliseconds: 500));
    }
    return account.isCurrent ? confirmedOperations : null;
  }

  static Future<void> cancelAgentRequest(String requestId) async {
    await _dio.post('/api/agent/cancel',
        data: {'requestId': requestId}, options: _authOptions);
  }

  static Future<List<Map<String, dynamic>>> getAgentMemory() async {
    final response = await _dio.get('/api/agent/memory', options: _authOptions);
    final data = _asMap(response.data);
    return (data['results'] is List ? data['results'] as List : const [])
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  /// Returns the structured Baiyu profile together with the small list of
  /// memory entries. Raw transcripts are intentionally kept in the history
  /// endpoint and are not used by the memory sheet.
  static Future<Map<String, dynamic>> getAgentMemoryOverview() async {
    final response = await _dio.get('/api/agent/memory', options: _authOptions);
    final data = _asMap(response.data);
    final results =
        (data['results'] is List ? data['results'] as List : const [])
            .whereType<Map>()
            .map((item) => Map<String, dynamic>.from(item))
            .toList();
    final profile = data['profile'] is Map
        ? Map<String, dynamic>.from(data['profile'] as Map)
        : <String, dynamic>{};
    return {'profile': profile, 'results': results};
  }

  static Future<void> clearAgentMemory() async {
    await _dio.delete('/api/agent/memory', options: _authOptions);
  }

  static Future<void> clearAgentSessionMemory(String sessionId) async {
    await _dio.delete('/api/agent/memory/${Uri.encodeComponent(sessionId)}',
        options: _authOptions);
  }

  static Future<void> forgetAgentMemoryItem(String memoryId) async {
    await _dio.delete(
      '/api/agent/memory/items/${Uri.encodeComponent(memoryId)}',
      options: _authOptions,
    );
  }

  static Future<void> removeUserFavorite(String animeId,
      {AniWorldAccountSnapshot? account}) async {
    account ??= AniWorldAccountSnapshot();
    if (!account.isLoggedIn || animeId.trim().isEmpty) return;
    await _dio.delete('/api/user/favorites/${Uri.encodeComponent(animeId)}',
        options: account.options);
  }

  static Future<void> removeUserHistory(String animeId) async {
    if (!isLoggedIn || animeId.trim().isEmpty) return;
    await _dio.delete('/api/user/history/${Uri.encodeComponent(animeId)}',
        options: _authOptions);
  }

  static Map<String, dynamic> userAnimeIdentity(BangumiItem item) {
    Map<String, dynamic> identity = const {};
    try {
      final raw = jsonDecode(item.info);
      if (raw is Map) identity = Map<String, dynamic>.from(raw);
    } catch (_) {}
    final title = item.nameCn.isNotEmpty ? item.nameCn : item.name;
    final anilistId = _parseAniListId(identity['anilistId']);
    final msg = '${identity['oiMsg'] ?? title}';
    final n = int.tryParse('${identity['oiIndex'] ?? 1}') ?? 1;
    return {
      'anilist_id': anilistId,
      'anime_id': anilistId > 0
          ? 'anilist_$anilistId'
          : 'oiapi_${msg.replaceAll('/', '_')}_$n',
      'anime_title': title,
      'anime_image': item.images['large'] ?? '',
      'anime_msg': msg,
      'anime_n': n,
      'oi_index': n,
    };
  }

  static Future<void> addUserFavorite(BangumiItem item,
      {AniWorldAccountSnapshot? account}) async {
    account ??= AniWorldAccountSnapshot();
    if (!account.isLoggedIn) return;
    await _dio.post('/api/user/favorites',
        data: userAnimeIdentity(item), options: account.options);
  }

  static Future<void> saveUserHistory({
    required BangumiItem item,
    required int episode,
    required Duration progress,
    String episodeTitle = '',
    String videoUrl = '',
    Duration duration = Duration.zero,
    AniWorldAccountSnapshot? account,
  }) async {
    account ??= AniWorldAccountSnapshot();
    if (!account.isLoggedIn) return;
    await _dio.post('/api/user/history',
        data: {
          ...userAnimeIdentity(item),
          'episode_number': episode,
          'episode_title': episodeTitle,
          'position_seconds': progress.inMilliseconds / 1000,
          if (duration > Duration.zero)
            'duration_seconds': duration.inMilliseconds / 1000,
          'video_url': videoUrl,
        },
        options: account.options);
  }

  static Future<String> chat(String message) async {
    return (await chatWithSession(message)).answer;
  }

  static Future<List<AniWorldAgentSession>> getAgentSessions() async {
    final response = await _dio.get(
      '/api/agent/sessions',
      options: _authOptions,
    );
    final data = _asMap(response.data);
    final list = data['results'] is List ? data['results'] as List : const [];
    return list
        .whereType<Map>()
        .map(
          (item) =>
              AniWorldAgentSession.fromJson(Map<String, dynamic>.from(item)),
        )
        .where((item) => item.id.isNotEmpty)
        .toList();
  }

  static Future<List<AniWorldAgentMessage>> getAgentMessages(
    String sessionId,
  ) async {
    final response = await _dio.get(
      '/api/agent/sessions/${Uri.encodeComponent(sessionId)}/messages',
      options: _authOptions,
    );
    final data = _asMap(response.data);
    final list = data['results'] is List ? data['results'] as List : const [];
    return list
        .whereType<Map>()
        .map(
          (item) =>
              AniWorldAgentMessage.fromJson(Map<String, dynamic>.from(item)),
        )
        .where((item) => item.content.trim().isNotEmpty)
        .toList();
  }

  static Future<void> deleteAgentSession(String sessionId) async {
    await _dio.delete(
      '/api/agent/sessions/${Uri.encodeComponent(sessionId)}',
      options: _authOptions,
    );
  }

  static Future<List<EpisodeCommentItem>> getEpisodeComments({
    required BangumiItem item,
    required int episode,
  }) async {
    final response = await _dio.get(
      '/api/comments/episode',
      queryParameters: {'anime_id': '${item.id}', 'episode_number': '$episode'},
      options: _authOptions,
    );
    final data = _asMap(response.data);
    final list = data['results'] is List ? data['results'] as List : const [];
    return list
        .whereType<Map>()
        .map(
          (raw) => EpisodeCommentItem.fromJson(Map<String, dynamic>.from(raw)),
        )
        .toList();
  }

  static Future<String> postEpisodeComment({
    required BangumiItem item,
    required int episode,
    required String content,
    int? parentId,
  }) async {
    final authToken = token.trim();
    if (authToken.isEmpty) {
      throw StateError('请先登录后再发表评论');
    }
    try {
      await _dio.post(
        '/api/comments/episode',
        data: {
          'anime_id': '${item.id}',
          'anime_title': item.nameCn.isNotEmpty ? item.nameCn : item.name,
          'episode_number': '${episode <= 0 ? 1 : episode}',
          'content': content,
          if (parentId != null) 'parent_id': parentId,
        },
        options: _authOptions,
      );
      return '评论发送成功';
    } on DioException catch (e) {
      if (e.response?.statusCode == 401) {
        throw StateError('登录状态验证失败，请重新登录或同步云服务器后端');
      }
      throw StateError(_errorMessage(e));
    }
  }

  static Future<EpisodeCommentRepliesPage> getEpisodeCommentReplies({
    required int commentId,
    required int page,
    int limit = 10,
  }) async {
    final response = await _dio.get(
      '/api/comments/episode/$commentId/replies',
      queryParameters: {'page': page, 'limit': limit},
      options: _authOptions,
    );
    final data = _asMap(response.data);
    final rawList =
        data['results'] is List ? data['results'] as List : const [];
    return EpisodeCommentRepliesPage(
      replies: rawList
          .whereType<Map>()
          .map((raw) => EpisodeComment.fromJson(Map<String, dynamic>.from(raw)))
          .toList(),
      page: data['page'] is num ? (data['page'] as num).toInt() : page,
      total: data['total'] is num ? (data['total'] as num).toInt() : 0,
      totalPages:
          data['totalPages'] is num ? (data['totalPages'] as num).toInt() : 1,
    );
  }

  /// Set the current user's reaction for an episode comment.
  /// [reaction] is 1 for like, -1 for dislike and 0 to clear it.
  static Future<Map<String, int>> reactToEpisodeComment({
    required int commentId,
    required int reaction,
  }) async {
    final authToken = token.trim();
    if (authToken.isEmpty) {
      throw StateError('请先登录后再操作评论');
    }
    try {
      final response = await _dio.post(
        '/api/comments/episode/$commentId/reaction',
        data: {'reaction': reaction},
        options: _authOptions,
      );
      final data = _asMap(response.data);
      return {
        'likes': data['likes'] is num ? (data['likes'] as num).toInt() : 0,
        'dislikes':
            data['dislikes'] is num ? (data['dislikes'] as num).toInt() : 0,
        'myReaction': data['my_reaction'] is num
            ? (data['my_reaction'] as num).toInt()
            : 0,
      };
    } on DioException catch (e) {
      if (e.response?.statusCode == 401) {
        throw StateError('登录状态验证失败，请重新登录或同步云服务器后端');
      }
      throw StateError(_errorMessage(e));
    }
  }

  static Future<void> deleteEpisodeComment({required int commentId}) async {
    final authToken = token.trim();
    if (authToken.isEmpty) {
      throw StateError('请先登录后再删除评论');
    }
    try {
      await _dio.delete(
        '/api/comments/episode/$commentId',
        options: _authOptions,
      );
    } on DioException catch (e) {
      if (e.response?.statusCode == 401) {
        throw StateError('登录状态验证失败，请重新登录或同步云服务器后端');
      }
      if (e.response?.statusCode == 403) {
        throw StateError('只有评论发布者可以删除评论');
      }
      throw StateError(_errorMessage(e));
    }
  }

  static Future<CommentNotificationResult> getCommentNotifications({
    String type = 'all',
    int limit = 100,
    AniWorldAccountSnapshot? account,
  }) async {
    account ??= AniWorldAccountSnapshot();
    if (!account.isLoggedIn) {
      return const CommentNotificationResult(notifications: [], unreadCount: 0);
    }
    try {
      final response = await _dio.get(
        '/api/comments/notifications',
        queryParameters: {'type': type, 'limit': limit},
        options: account.options,
      );
      if (!account.isCurrent) {
        return const CommentNotificationResult(
            notifications: [], unreadCount: 0);
      }
      final data = _asMap(response.data);
      final rawList =
          data['results'] is List ? data['results'] as List : const [];
      return CommentNotificationResult(
        notifications: rawList
            .whereType<Map>()
            .map((raw) => CommentNotification.fromJson(
                  Map<String, dynamic>.from(raw),
                ))
            .toList(),
        unreadCount: data['unreadCount'] is num
            ? (data['unreadCount'] as num).toInt()
            : 0,
      );
    } on DioException catch (e) {
      if (e.response?.statusCode == 401) {
        throw StateError('登录状态验证失败，请重新登录或同步云服务器后端');
      }
      throw StateError(_errorMessage(e));
    }
  }

  static Future<bool> markCommentNotificationsRead(
      {String type = 'all', AniWorldAccountSnapshot? account}) async {
    account ??= AniWorldAccountSnapshot();
    if (!account.isLoggedIn) return false;
    try {
      await _dio.post(
        '/api/comments/notifications/read',
        data: {'type': type},
        options: account.options,
      );
      return account.isCurrent;
    } on DioException catch (e) {
      if (e.response?.statusCode == 401) {
        throw StateError('登录状态验证失败，请重新登录或同步云服务器后端');
      }
      throw StateError(_errorMessage(e));
    }
  }

  static Future<List<BangumiItem>> searchOi(String keyword,
      {bool forceRefresh = false}) async {
    final normalized = keyword.trim().toLowerCase();
    if (normalized.isEmpty) return const [];
    final server = serverAddress;
    final dio = _dio;
    final key = '$server|$normalized';
    if (forceRefresh) _oiSearchCache.remove(key);
    final cached = _oiSearchCache[key];
    if (!forceRefresh &&
        cached != null &&
        DateTime.now().difference(cached.savedAt) <= _oiSearchMaxAge) {
      return _decodeOiSearch(cached.data);
    }
    final active = _oiSearchInFlight[key];
    if (!forceRefresh && active != null) return _decodeOiSearch(await active);

    late final Future<List<Map<String, dynamic>>> request;
    request = () async {
      final response = await dio.get(
        '/api/oi/search',
        queryParameters: {
          'q': keyword.trim(),
          'pure': '1',
          if (forceRefresh) 'refresh': '1'
        },
        options: forceRefresh
            ? Options(headers: {'Cache-Control': 'no-cache'})
            : null,
      );
      final data = response.data;
      if (data is! Map || data['results'] is! List || data['error'] != null) {
        throw const FormatException('搜索响应格式异常');
      }
      final list = data['results'] as List;
      if (list.any((item) => item is! Map)) {
        throw const FormatException('搜索结果格式异常');
      }
      final raw =
          list.map((item) => Map<String, dynamic>.from(item as Map)).toList();
      // Validate decoding before publishing the cache. Empty and degraded results
      // are deliberately not cached, so a retry can query the provider again.
      _decodeOiSearch(raw);
      if (server == serverAddress &&
          identical(_oiSearchInFlight[key], request)) {
        if (raw.isEmpty || data['degraded'] == true) {
          _oiSearchCache.remove(key);
        } else {
          _oiSearchCache[key] = _CachedOiSearch(raw, DateTime.now());
          if (_oiSearchCache.length > 50) {
            final oldest = _oiSearchCache.entries.reduce(
              (a, b) => a.value.savedAt.isBefore(b.value.savedAt) ? a : b,
            );
            _oiSearchCache.remove(oldest.key);
          }
        }
      }
      return raw;
    }();
    _oiSearchInFlight[key] = request;
    try {
      return _decodeOiSearch(await request);
    } finally {
      if (identical(_oiSearchInFlight[key], request)) {
        _oiSearchInFlight.remove(key);
      }
    }
  }

  static List<BangumiItem> _decodeOiSearch(
    List<Map<String, dynamic>> items,
  ) {
    return items.map((item) => oiToBangumi(item)).toList();
  }

  static Future<Map<int, BangumiItem>> resolveSavedBangumiMetadata(
    List<BangumiItem> items,
  ) async {
    if (items.isEmpty) return const {};
    Map<String, dynamic> savedIdentity(BangumiItem item) {
      try {
        final decoded = jsonDecode(item.info);
        if (decoded is Map) return Map<String, dynamic>.from(decoded);
      } catch (_) {}
      return const {};
    }

    final response = await _dio.post(
      '/kazumi/v1/aniworld/subjects/resolve',
      data: {
        'items': items.take(200).map((item) {
          final identity = savedIdentity(item);
          return {
            'id': item.id,
            'title': item.nameCn.isNotEmpty ? item.nameCn : item.name,
            'year': item.yearText,
            'airDate': item.airDate,
            'oiMsg': identity['oiMsg'] ?? '',
            'oiIndex': identity['oiIndex'] ?? 1,
          };
        }).toList(),
      },
    );
    final rawList = response.data is List ? response.data as List : const [];
    final result = <int, BangumiItem>{};
    for (final raw in rawList.whereType<Map>()) {
      final requestedId = int.tryParse('${raw['requestedId'] ?? ''}') ?? 0;
      final subject = raw['subject'];
      if (requestedId <= 0 || subject is! Map) continue;
      result[requestedId] = BangumiItem.fromJson(
        Map<String, dynamic>.from(subject),
      );
    }
    return result;
  }

  static Future<List<List<BangumiItem>>> getOiCalendar() async {
    final response = await _dio.get('/api/oi/calendar');
    final data = _asMap(response.data);
    final schedule = data['schedule'] is Map ? data['schedule'] as Map : {};
    const keys = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    return keys.map((key) {
      final list = schedule[key] is List ? schedule[key] as List : const [];
      return list
          .whereType<Map>()
          .map((item) => oiToBangumi(Map<String, dynamic>.from(item)))
          .toList();
    }).toList();
  }

  static Future<List<BangumiItem>> getOiFranchise(BangumiItem item) async {
    final title = _oiMsgFromItem(item);
    final response = await _dio.get(
      '/api/oi/franchise',
      queryParameters: {'msg': title, 'n': _oiIndexFromItem(item)},
    );
    final data = _asMap(response.data);
    final entries =
        data['entries'] is List ? data['entries'] as List : const [];
    return entries
        .whereType<Map>()
        .map((raw) {
          final entry = Map<String, dynamic>.from(raw);
          final entryTitle = '${entry['title'] ?? ''}'.trim();
          return oiToBangumi({
            ...entry,
            'title': entryTitle,
            'name': entryTitle,
            'oiMsg': entryTitle,
            'oiIndex': entry['index'] ?? 1,
          });
        })
        .where((entry) => entry.nameCn.trim().isNotEmpty)
        .toList();
  }

  static Future<BangumiItem?> getOiDetails(BangumiItem item) async {
    try {
      final title = _oiMsgFromItem(item);
      final data = await _getOiDetailsData(item);
      final oiName = '${data['name'] ?? title}'.trim();
      final metadataMatched = data['metadataMatched'] == true;
      final chineseTitle = '${data['aniTitleChinese'] ?? ''}'.trim();
      data['title'] = metadataMatched && chineseTitle.isNotEmpty
          ? chineseTitle
          : (item.nameCn.trim().isNotEmpty ? item.nameCn.trim() : oiName);
      // Keep the exact card title (including arc/part suffixes) as the visible
      // identity. AniList fields enrich the card but must never rename it.
      data['title'] = item.nameCn.trim().isNotEmpty
          ? item.nameCn.trim()
          : (oiName.isNotEmpty ? oiName : data['title']);
      data['aniTitleChinese'] = data['title'];
      data['romajiTitle'] =
          metadataMatched ? (data['aniTitleRomaji'] ?? item.name) : item.name;
      data['nativeTitle'] =
          metadataMatched ? (data['aniTitleNative'] ?? '') : item.name;
      final resolvedId = metadataMatched ? _parseAniListId(data['aniId']) : 0;
      if (resolvedId > 0) data['id'] = resolvedId;
      if (!metadataMatched) {
        data['id'] = item.id;
        data['aniId'] = 0;
        data['aniTitleRomaji'] = '';
        data['aniTitleNative'] = '';
        data['aniPopularity'] = 0;
        data['aniScore'] = 0;
        data['aniGenres'] = const <dynamic>[];
      }
      data['image'] = data['image'] ?? item.images['large'];
      data['oiMsg'] = oiName;
      data['oiIndex'] = data['resolved_n'] ?? _oiIndexFromItem(item);
      return oiToBangumi(data);
    } catch (_) {
      return null;
    }
  }

  static Future<Map<String, dynamic>> _getOiDetailsData(
    BangumiItem item,
  ) async {
    final title = _oiMsgFromItem(item);
    final index = _oiIndexFromItem(item);
    final key = '${ApiEndpoints.selfBackend}|$title|$index';
    final cached = _oiDetailsCache[key];
    if (cached != null &&
        DateTime.now().difference(cached.savedAt) <= _oiDetailsMaxAge) {
      return Map<String, dynamic>.from(cached.data);
    }
    final active = _oiDetailsInFlight[key];
    if (active != null) {
      return Map<String, dynamic>.from(await active);
    }

    final request = () async {
      final response = await _dio.get(
        '/api/oi/details',
        queryParameters: {'msg': title, 'n': index},
      );
      final data = _asMap(response.data);
      _oiDetailsCache[key] = _CachedOiDetails(
        Map<String, dynamic>.from(data),
        DateTime.now(),
      );
      return data;
    }();
    _oiDetailsInFlight[key] = request;
    try {
      return Map<String, dynamic>.from(await request);
    } finally {
      if (identical(_oiDetailsInFlight[key], request)) {
        _oiDetailsInFlight.remove(key);
      }
    }
  }

  // Retain an explicit error for old download/history entries, never call a retired API.
  static Future<AniWorldVideoSource> resolveVideoSource(String episodeUrl,
      {CancelToken? cancelToken}) async {
    throw StateError('公开版已移除内置播放源，请在详情页选择 AGE、DM84 或 enlie');
  }

  static Future<PackageInfo>? _reportPackageInfo;
  static Future<void> reportPlayback(Map<String, Object> event) async {
    PackageInfo? info;
    try {
      info = await (_reportPackageInfo ??= PackageInfo.fromPlatform())
          .timeout(const Duration(seconds: 2));
    } catch (_) {
      _reportPackageInfo = null;
    }
    try {
      await _dio.post('/api/playback-report',
          data: {
            ...event,
            if (info != null) 'appVersion': info.version,
            if (info != null) 'buildNumber': info.buildNumber
          },
          options: Options(
              sendTimeout: const Duration(seconds: 3),
              receiveTimeout: const Duration(seconds: 3)));
    } catch (_) {/* Diagnostics must never delay or fail playback. */}
  }

  static BangumiItem oiToBangumi(Map<String, dynamic> item) {
    final title =
        '${item['aniTitleChinese'] ?? item['titleChinese'] ?? item['name_cn'] ?? item['title'] ?? item['name'] ?? item['oiMsg'] ?? ''}'
            .trim();
    final parsedId = _parseAniListId(
      item['anilist_id'] ?? item['anilistId'] ?? item['aniId'] ?? item['id'],
    );
    final id = parsedId > 0 ? parsedId : title.hashCode.abs();
    final covers = [
      if (item['metadataMatched'] == true) item['aniCover'],
      item['image'],
      item['cover'],
      item['aniCover'],
      item['coverFallback'],
    ]
        .map((value) => '${value ?? ''}'.trim())
        .where((url) => url.isNotEmpty)
        .toSet()
        .toList();
    final image = covers.isEmpty ? '' : covers.first;
    final fallback = covers.length > 1 ? covers[1] : '';
    final ratingSource = '${item['ratingSource'] ?? ''}'.trim();
    var score = double.tryParse(
          '${item['ratingScore'] ?? item['score'] ?? item['aniScore'] ?? 0}',
        ) ??
        0;
    if (score > 10) score = score / 10;
    final year =
        '${item['year'] ?? item['seasonYear'] ?? item['aniSeasonYear'] ?? ''}';
    final airDate = _airDateFromItem(item, fallbackYear: year);
    final genres = item['genres'] is List
        ? item['genres'] as List
        : item['aniGenres'] is List
            ? item['aniGenres'] as List
            : const [];
    final ratingCount = item['ratingCount'];
    final voteCounts = ratingCount is Map
        ? List<int>.generate(
            10,
            (index) => int.tryParse('${ratingCount['${index + 1}'] ?? 0}') ?? 0,
          )
        : ratingCount is List
            ? ratingCount
                .take(10)
                .map((value) => int.tryParse('$value') ?? 0)
                .toList()
            : const <int>[];
    final ratingTotal = int.tryParse('${item['ratingTotal'] ?? 0}') ?? 0;
    final popularity = int.tryParse(
          '${item['popularity'] ?? item['aniPopularity'] ?? item['votes'] ?? 0}',
        ) ??
        0;
    final animeStatus = _normalizedAniStatus(item);
    var episodes = int.tryParse(
          '${item['episodes'] ?? item['aniEpisodes'] ?? 0}',
        ) ??
        0;
    final airedEpisodes = _releasedEpisodeCount(
      item,
      animeStatus: animeStatus,
      episodes: episodes,
    );
    if (animeStatus == 'FINISHED' && episodes <= 0 && airedEpisodes > 0) {
      episodes = airedEpisodes;
    }
    return BangumiItem(
      id: id,
      type: 2,
      name:
          '${item['nativeTitle'] ?? item['aniTitleNative'] ?? item['romajiTitle'] ?? item['aniTitleRomaji'] ?? title}',
      nameCn: title,
      summary:
          '${item['desc'] ?? item['summary'] ?? item['description'] ?? ''}',
      airDate: airDate,
      airWeekday: 1,
      rank: int.tryParse('${item['ratingRank'] ?? item['rank'] ?? 0}') ?? 0,
      images: {
        if (fallback.isNotEmpty) 'fallback': fallback,
        'large': image,
        'common': image,
        'medium': image,
        'small': image,
        'grid': image,
      },
      tags: genres
          .map((g) => BangumiTag(name: '$g', count: 0, totalCount: 0))
          .toList(),
      alias: [],
      ratingScore: score,
      votes: ratingTotal > 0 ? ratingTotal : popularity,
      votesCount: voteCounts,
      info: jsonEncode({
        'source': 'oiapi',
        'anilistId': parsedId,
        'oiMsg': item['oiMsg'] ?? title,
        'oiIndex': item['oiIndex'] ?? item['resolved_n'] ?? 1,
        'ji': item['ji'] ?? '',
        'episodes': item['episodes'] ?? item['aniEpisodes'] ?? '',
        'releasedEpisodes': item['releasedEpisodes'] ?? 0,
        'episodeCountSource': item['episodeCountSource'] ?? 'unknown',
        'aniStatus': _normalizedAniStatus(item),
        'ratingSource': ratingTotal > 0
            ? (ratingSource.isEmpty ? 'bangumi' : ratingSource)
            : 'anilist',
        'bangumiSubjectId': item['bangumiSubjectId'] ?? 0,
        'nextAiringEpisode': item['nextAiringEpisode'] ??
            item['aniNextAiringEpisode'] ??
            (item['aniNextAiring'] is Map
                ? item['aniNextAiring']['episode']
                : null) ??
            (item['nextAiring'] is Map ? item['nextAiring']['episode'] : ''),
        'nextAiringAt': item['nextAiringAt'] ??
            item['aniNextAiringAt'] ??
            (item['aniNextAiring'] is Map
                ? item['aniNextAiring']['airingAt']
                : null) ??
            (item['nextAiring'] is Map ? item['nextAiring']['time'] : ''),
      }),
      animeStatus: animeStatus,
      episodes: episodes,
      airedEpisodes: airedEpisodes,
    );
  }

  static int _oiIndexFromItem(BangumiItem item) {
    try {
      final data = jsonDecode(item.info);
      return int.tryParse('${data['oiIndex'] ?? 1}') ?? 1;
    } catch (_) {
      return 1;
    }
  }

  static String _oiMsgFromItem(BangumiItem item) {
    try {
      final data = jsonDecode(item.info);
      final oiMsg = '${data['oiMsg'] ?? ''}'.trim();
      if (oiMsg.isNotEmpty) return oiMsg;
    } catch (_) {}
    return item.nameCn.isNotEmpty ? item.nameCn : item.name;
  }

  static String _airDateFromItem(
    Map<String, dynamic> item, {
    required String fallbackYear,
  }) {
    final direct = '${item['airDate'] ?? item['date'] ?? ''}'.trim();
    if (direct.isNotEmpty) return direct;
    final rawStartDate = item['startDate'] ?? item['aniStartDate'];
    final startDate = rawStartDate is Map ? rawStartDate : {};
    final startYear = startDate['year'] ?? fallbackYear;
    final startMonth = startDate['month'];
    final startDay = startDate['day'];
    if ('$startYear'.isNotEmpty && startMonth != null && startDay != null) {
      final mm = '$startMonth'.padLeft(2, '0');
      final dd = '$startDay'.padLeft(2, '0');
      return '$startYear-$mm-$dd';
    }
    return fallbackYear.isEmpty ? '' : fallbackYear;
  }

  static Map<String, dynamic> _asMap(dynamic data) {
    if (data is String) return jsonDecode(data) as Map<String, dynamic>;
    if (data is Map<String, dynamic>) return data;
    if (data is Map) return Map<String, dynamic>.from(data);
    return {};
  }

  static AniWorldAgentChatResult _extractAgentChatResult(String raw) {
    if (raw.trim().isEmpty) {
      throw StateError('未收到完整回答');
    }
    try {
      final data = _asMap(raw);
      if (data['type'] != null || data['answer'] is! String) {
        throw const FormatException('stream');
      }
      return AniWorldAgentChatResult(
        answer: '${data['answer'] ?? data['message'] ?? data['text'] ?? ''}',
        sessionId: '${data['sessionId'] ?? ''}',
        cards: (data['cards'] is List ? data['cards'] as List : const [])
            .whereType<Map>()
            .map(
              (item) =>
                  AniWorldAgentCard.fromJson(Map<String, dynamic>.from(item)),
            )
            .toList(),
        suggestions: (data['suggestions'] is List
                ? data['suggestions'] as List
                : const [])
            .map((item) => '$item')
            .toList(),
        actions: (data['actions'] is List ? data['actions'] as List : const [])
            .whereType<Map>()
            .map((item) => Map<String, dynamic>.from(item))
            .toList(),
        plan: (data['plan'] is List ? data['plan'] as List : const [])
            .map((item) => '$item')
            .toList(),
      );
    } catch (_) {}

    final buffer = StringBuffer();
    String? finalAnswer;
    var completed = false;
    var sessionId = '';
    final cards = <AniWorldAgentCard>[];
    final suggestions = <String>[];
    final actions = <Map<String, dynamic>>[];
    final plan = <String>[];
    for (final line in const LineSplitter().convert(raw)) {
      final text = line.trim();
      if (text.isEmpty) continue;
      try {
        final event = jsonDecode(text);
        if (event is Map) {
          if (event['type'] == 'error' || event['type'] == 'cancelled') {
            throw StateError('${event['error'] ?? '请求未完成'}');
          } else if (event['type'] == 'done') {
            completed = true;
            if (event['answer'] is String) {
              finalAnswer = event['answer'] as String;
            }
            if (event['cards'] is List) {
              cards
                ..clear()
                ..addAll((event['cards'] as List).whereType<Map>().map((item) =>
                    AniWorldAgentCard.fromJson(
                        Map<String, dynamic>.from(item))));
            }
            if (event['actions'] is List) {
              actions
                ..clear()
                ..addAll((event['actions'] as List)
                    .whereType<Map>()
                    .map((item) => Map<String, dynamic>.from(item)));
            }
            if (event['suggestions'] is List) {
              suggestions
                ..clear()
                ..addAll((event['suggestions'] as List).map((item) => '$item'));
            }
          } else if (event['type'] == 'session') {
            sessionId = '${event['sessionId'] ?? ''}';
          } else if (event['type'] == 'answer_start') {
            buffer.clear();
          } else if (event['type'] == 'delta') {
            buffer.write('${event['text'] ?? ''}');
          } else if (event['type'] == 'cards' && event['items'] is List) {
            cards.addAll(
              (event['items'] as List).whereType<Map>().map(
                    (item) => AniWorldAgentCard.fromJson(
                        Map<String, dynamic>.from(item)),
                  ),
            );
          } else if (event['type'] == 'suggestions' && event['items'] is List) {
            suggestions
              ..clear()
              ..addAll((event['items'] as List).map((item) => '$item'));
          } else if (event['type'] == 'actions' && event['items'] is List) {
            actions.addAll(
              (event['items'] as List).whereType<Map>().map(
                    (item) => Map<String, dynamic>.from(item),
                  ),
            );
          } else if (event['type'] == 'plan' && event['items'] is List) {
            plan
              ..clear()
              ..addAll((event['items'] as List).map((item) => '$item'));
          } else if (event['answer'] != null || event['message'] != null) {
            buffer.write('${event['answer'] ?? event['message']}');
          }
        }
      } on FormatException {
        throw StateError('服务端返回了无效的响应');
      }
    }
    if (!completed) throw StateError('回答未完整结束');
    return AniWorldAgentChatResult(
      answer: finalAnswer ?? buffer.toString(),
      sessionId: sessionId,
      cards: cards,
      suggestions: suggestions,
      actions: actions,
      plan: plan,
    );
  }

  static int _parseAniListId(dynamic raw) {
    if (raw is num) return raw.toInt();
    final text = '${raw ?? ''}'.trim();
    if (text.isEmpty) return 0;
    final direct = int.tryParse(text);
    if (direct != null) return direct;
    final match = RegExp(
      r'^anilist_(\d+)$',
      caseSensitive: false,
    ).firstMatch(text);
    return int.tryParse(match?.group(1) ?? '') ?? 0;
  }

  static String _normalizedAniStatus(Map<String, dynamic> item) {
    final next =
        item['nextAiring'] is Map ? item['nextAiring'] as Map : const {};
    final nextAt = int.tryParse(
          '${item['nextAiringAt'] ?? item['aniNextAiringAt'] ?? next['time'] ?? next['airingAt'] ?? 0}',
        ) ??
        0;
    final nextEpisode = int.tryParse(
          '${item['nextAiringEpisode'] ?? item['aniNextAiringEpisode'] ?? next['episode'] ?? 0}',
        ) ??
        0;
    if (nextAt > 0 || nextEpisode > 0) return 'RELEASING';

    var status = '${item['aniStatus'] ?? ''}'.trim();
    if (status.isEmpty) status = '${item['status'] ?? ''}'.trim();
    final upper = status.toUpperCase();
    if (upper == 'RELEASING' ||
        status.contains('更新') ||
        status.contains('连载')) {
      return 'RELEASING';
    }
    if (upper == 'FINISHED' || status.contains('完结') || status.contains('完結')) {
      return 'FINISHED';
    }
    if (upper == 'NOT_YET_RELEASED' || status.contains('未开播')) {
      return 'NOT_YET_RELEASED';
    }
    if (upper == 'CANCELLED' || status.contains('取消')) return 'CANCELLED';
    if (upper == 'HIATUS' || status.contains('暂停')) return 'HIATUS';

    final progress = '${item['ji'] ?? ''}';
    if (progress.contains('更新')) return 'RELEASING';
    if (progress.contains('完结') || progress.contains('全')) return 'FINISHED';
    return upper;
  }

  static int _releasedEpisodeCount(
    Map<String, dynamic> item, {
    required String animeStatus,
    required int episodes,
  }) {
    for (final value in [
      item['releasedEpisodes'],
      item['airedEpisodes'],
      item['aired_eps'],
    ]) {
      final parsed = int.tryParse('${value ?? ''}') ?? 0;
      if (parsed > 0) return parsed;
    }

    final next =
        item['nextAiring'] is Map ? item['nextAiring'] as Map : const {};
    final nextEpisode = int.tryParse(
          '${item['nextAiringEpisode'] ?? item['aniNextAiringEpisode'] ?? next['episode'] ?? 0}',
        ) ??
        0;
    if (nextEpisode > 1) return nextEpisode - 1;
    if (animeStatus == 'FINISHED' && episodes > 0) return episodes;

    final progress = '${item['ji'] ?? ''}';
    final progressMatch = RegExp(
      r'(?:更新至|更新到|第)\s*0*(\d+)',
      caseSensitive: false,
    ).firstMatch(progress);
    if (progressMatch != null) {
      return int.tryParse(progressMatch.group(1) ?? '') ?? 0;
    }
    final finishedMatch = RegExp(
      r'0*(\d+)\s*(?:集|话|話)?\s*(?:全|完结|完結)',
      caseSensitive: false,
    ).firstMatch(progress);
    return int.tryParse(finishedMatch?.group(1) ?? '') ?? 0;
  }

  static String _errorMessage(DioException e) {
    final data = e.response?.data;
    if (data is Map && data['error'] != null) return '${data['error']}';
    if (data is Map && data['message'] != null) return '${data['message']}';
    return e.message ?? '请求失败';
  }
}

class _CachedOiDetails {
  const _CachedOiDetails(this.data, this.savedAt);

  final Map<String, dynamic> data;
  final DateTime savedAt;
}

class _CachedOiSearch {
  const _CachedOiSearch(this.data, this.savedAt);

  final List<Map<String, dynamic>> data;
  final DateTime savedAt;
}
