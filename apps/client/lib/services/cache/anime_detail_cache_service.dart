import 'dart:convert';
import 'dart:io';

import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/services/cache/bangumi_item_cache_codec.dart';
import 'package:path_provider/path_provider.dart';

class AnimeDetailCacheService {
  AnimeDetailCacheService._();

  static final AnimeDetailCacheService instance = AnimeDetailCacheService._();
  static const _codec = BangumiItemCacheCodec();
  static const _maxAge = Duration(days: 30);
  static const _maxEntries = 200;

  final Map<String, _DetailEntry> _entries = {};
  Future<void>? _loadFuture;
  Future<void> _writeTail = Future.value();

  Future<BangumiItem?> load({
    required String server,
    required BangumiItem item,
  }) async {
    await (_loadFuture ??= _loadFromDisk());
    _DetailEntry? entry;
    for (final key in _keys(server, item)) {
      entry = _entries[key];
      if (entry != null) break;
    }
    if (entry == null || DateTime.now().difference(entry.savedAt) > _maxAge) {
      return null;
    }
    return _codec.decode(entry.item);
  }

  Future<void> save({
    required String server,
    required BangumiItem item,
  }) async {
    await (_loadFuture ??= _loadFromDisk());
    final entry = _DetailEntry(
      savedAt: DateTime.now().toUtc(),
      item: _codec.encode(item),
    );
    for (final key in _keys(server, item)) {
      _entries[key] = entry;
    }
    _trim();
    final previous = _writeTail;
    _writeTail = previous.catchError((_) {}).then((_) => _writeToDisk());
    await _writeTail;
  }

  Future<Directory> cacheDirectory() async {
    final root = await getApplicationSupportDirectory();
    return Directory(
      '${root.path}${Platform.pathSeparator}aniworld_cache',
    );
  }

  Future<void> clear() async {
    await (_loadFuture ??= _loadFromDisk());
    _entries.clear();
    final file = await _file();
    try {
      if (await file.exists()) await file.delete();
    } catch (_) {}
  }

  Iterable<String> _keys(String server, BangumiItem item) sync* {
    final prefix = server.trim().toLowerCase();
    if (item.id > 0) yield '$prefix|id:${item.id}';
    final title =
        (item.nameCn.isNotEmpty ? item.nameCn : item.name).trim().toLowerCase();
    if (title.isNotEmpty) yield '$prefix|title:$title';
  }

  Future<void> _loadFromDisk() async {
    try {
      final file = await _file();
      if (!await file.exists()) return;
      final decoded = jsonDecode(await file.readAsString());
      if (decoded is! Map || decoded['entries'] is! Map) return;
      for (final entry in (decoded['entries'] as Map).entries) {
        if (entry.value is! Map) continue;
        final value = Map<String, dynamic>.from(entry.value as Map);
        final savedAt = DateTime.tryParse('${value['savedAt'] ?? ''}');
        if (savedAt == null || value['item'] is! Map) continue;
        if (DateTime.now().difference(savedAt) > _maxAge) continue;
        _entries['${entry.key}'] = _DetailEntry(
          savedAt: savedAt,
          item: Map<String, dynamic>.from(value['item'] as Map),
        );
      }
      _trim();
    } catch (_) {}
  }

  Future<void> _writeToDisk() async {
    final file = await _file(createDirectory: true);
    final temporary = File('${file.path}.tmp');
    final payload = jsonEncode({
      'version': 1,
      'entries': {
        for (final entry in _entries.entries)
          entry.key: {
            'savedAt': entry.value.savedAt.toIso8601String(),
            'item': entry.value.item,
          },
      },
    });
    await temporary.writeAsString(payload, flush: true);
    if (await file.exists()) await file.delete();
    await temporary.rename(file.path);
  }

  void _trim() {
    if (_entries.length <= _maxEntries) return;
    final ordered = _entries.entries.toList()
      ..sort((a, b) => b.value.savedAt.compareTo(a.value.savedAt));
    final keep = ordered.take(_maxEntries).map((entry) => entry.key).toSet();
    _entries.removeWhere((key, _) => !keep.contains(key));
  }

  Future<File> _file({bool createDirectory = false}) async {
    final directory = await cacheDirectory();
    if (createDirectory) await directory.create(recursive: true);
    return File(
      '${directory.path}${Platform.pathSeparator}anime_details_v1.json',
    );
  }
}

class _DetailEntry {
  const _DetailEntry({required this.savedAt, required this.item});

  final DateTime savedAt;
  final Map<String, dynamic> item;
}
