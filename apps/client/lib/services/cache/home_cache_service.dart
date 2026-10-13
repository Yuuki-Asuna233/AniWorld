import 'dart:convert';
import 'dart:io';

import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/services/cache/bangumi_item_cache_codec.dart';
import 'package:path_provider/path_provider.dart';

class HomeCacheSnapshot {
  const HomeCacheSnapshot({
    required this.recommend,
    required this.today,
    required this.newSeason,
    required this.hot,
    required this.classic,
    required this.movies,
  });

  final List<BangumiItem> recommend;
  final List<BangumiItem> today;
  final List<BangumiItem> newSeason;
  final List<BangumiItem> hot;
  final List<BangumiItem> classic;
  final List<BangumiItem> movies;

  bool get hasContent =>
      recommend.isNotEmpty ||
      today.isNotEmpty ||
      newSeason.isNotEmpty ||
      hot.isNotEmpty ||
      classic.isNotEmpty ||
      movies.isNotEmpty;
}

class HomeCacheService {
  HomeCacheService({
    Future<Directory> Function()? temporaryDirectoryProvider,
    DateTime Function()? now,
  })  : _temporaryDirectoryProvider =
            temporaryDirectoryProvider ?? getTemporaryDirectory,
        _now = now ?? DateTime.now;

  static final HomeCacheService instance = HomeCacheService();

  static const directoryName = 'aniworld_cache';
  static const _fileName = 'home_sections_v1.json';
  static const _schemaVersion = 4;
  static const _maxAge = Duration(days: 7);
  static const _maxFileBytes = 4 * 1024 * 1024;

  final Future<Directory> Function() _temporaryDirectoryProvider;
  final DateTime Function() _now;
  static const _itemCodec = BangumiItemCacheCodec();

  HomeCacheSnapshot? _memorySnapshot;
  String? _memoryServer;
  DateTime? _memorySavedAt;

  Future<HomeCacheSnapshot?> load({required String server}) async {
    final normalizedServer = _normalizeServer(server);
    if (_isUsableMemoryCache(normalizedServer)) return _memorySnapshot;

    try {
      final file = await _cacheFile();
      if (!await file.exists()) return null;
      if (await file.length() > _maxFileBytes) {
        await file.delete();
        return null;
      }

      final decoded = jsonDecode(await file.readAsString());
      if (decoded is! Map) return null;
      final json = Map<String, dynamic>.from(decoded);
      if (json['version'] != _schemaVersion ||
          _normalizeServer('${json['server'] ?? ''}') != normalizedServer) {
        return null;
      }

      final savedAt = DateTime.tryParse('${json['savedAt'] ?? ''}');
      if (savedAt == null || _now().difference(savedAt) > _maxAge) {
        await file.delete();
        return null;
      }

      final sectionsRaw = json['sections'];
      if (sectionsRaw is! Map) return null;
      final sections = Map<String, dynamic>.from(sectionsRaw);
      final snapshot = HomeCacheSnapshot(
        recommend: _decodeItems(sections['recommend']),
        today: _decodeItems(sections['today']),
        newSeason: _decodeItems(sections['newSeason']),
        hot: _decodeItems(sections['hot']),
        classic: _decodeItems(sections['classic']),
        movies: _decodeItems(sections['movies']),
      );
      if (!snapshot.hasContent) return null;

      _remember(snapshot, normalizedServer, savedAt);
      return snapshot;
    } catch (_) {
      return null;
    }
  }

  Future<void> save({
    required String server,
    required HomeCacheSnapshot snapshot,
  }) async {
    if (!snapshot.hasContent) return;
    final normalizedServer = _normalizeServer(server);
    final savedAt = _now().toUtc();
    final payload = jsonEncode({
      'version': _schemaVersion,
      'server': normalizedServer,
      'savedAt': savedAt.toIso8601String(),
      'sections': {
        'recommend': _encodeItems(snapshot.recommend),
        'today': _encodeItems(snapshot.today),
        'newSeason': _encodeItems(snapshot.newSeason),
        'hot': _encodeItems(snapshot.hot),
        'classic': _encodeItems(snapshot.classic),
        'movies': _encodeItems(snapshot.movies),
      },
    });
    if (utf8.encode(payload).length > _maxFileBytes) return;

    final file = await _cacheFile(createDirectory: true);
    final temporaryFile = File('${file.path}.tmp');
    await temporaryFile.writeAsString(payload, flush: true);
    if (await file.exists()) await file.delete();
    await temporaryFile.rename(file.path);
    _remember(snapshot, normalizedServer, savedAt);
  }

  Future<void> clear() async {
    _memorySnapshot = null;
    _memoryServer = null;
    _memorySavedAt = null;
    final directory = await cacheDirectory();
    if (await directory.exists()) await directory.delete(recursive: true);
  }

  Future<Directory> cacheDirectory() async {
    final temporaryDirectory = await _temporaryDirectoryProvider();
    return Directory(
        '${temporaryDirectory.path}${Platform.pathSeparator}$directoryName');
  }

  Future<File> _cacheFile({bool createDirectory = false}) async {
    final directory = await cacheDirectory();
    if (createDirectory) await directory.create(recursive: true);
    return File('${directory.path}${Platform.pathSeparator}$_fileName');
  }

  bool _isUsableMemoryCache(String server) {
    final savedAt = _memorySavedAt;
    return _memorySnapshot != null &&
        _memoryServer == server &&
        savedAt != null &&
        _now().difference(savedAt) <= _maxAge;
  }

  void _remember(
    HomeCacheSnapshot snapshot,
    String server,
    DateTime savedAt,
  ) {
    _memorySnapshot = snapshot;
    _memoryServer = server;
    _memorySavedAt = savedAt;
  }

  String _normalizeServer(String value) {
    return value.trim().replaceFirst(RegExp(r'/+$'), '').toLowerCase();
  }

  List<BangumiItem> _decodeItems(dynamic raw) {
    if (raw is! List) return const [];
    final items = <BangumiItem>[];
    for (final item in raw) {
      final decoded = _itemCodec.decode(item);
      if (decoded != null) items.add(decoded);
    }
    return items;
  }

  List<Map<String, dynamic>> _encodeItems(List<BangumiItem> items) {
    return items.map(_itemCodec.encode).toList();
  }
}
