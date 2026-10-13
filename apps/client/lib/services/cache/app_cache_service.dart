import 'dart:io';

import 'package:kazumi/services/cache/anime_detail_cache_service.dart';
import 'package:kazumi/services/cache/home_cache_service.dart';
import 'package:path_provider/path_provider.dart';

class AppCacheService {
  AppCacheService._();

  static final AppCacheService instance = AppCacheService._();

  Future<int> sizeInBytes() async {
    var total = 0;
    for (final directory in await _cacheDirectories()) {
      total += await _directorySize(directory);
    }
    return total;
  }

  Future<void> clear() async {
    for (final directory in await _cacheDirectories()) {
      try {
        if (await directory.exists()) await directory.delete(recursive: true);
      } catch (_) {}
    }
    await HomeCacheService.instance.clear();
    await AnimeDetailCacheService.instance.clear();
  }

  String formatBytes(int bytes) {
    if (bytes < 1024) return '$bytes B';
    final kilobytes = bytes / 1024;
    if (kilobytes < 1024) return '${kilobytes.toStringAsFixed(1)} KB';
    return '${(kilobytes / 1024).toStringAsFixed(2)} MB';
  }

  Future<List<Directory>> _cacheDirectories() async {
    final temporaryDirectory = await getTemporaryDirectory();
    return [
      Directory(
        '${temporaryDirectory.path}${Platform.pathSeparator}libCachedImageData',
      ),
      await HomeCacheService.instance.cacheDirectory(),
      await AnimeDetailCacheService.instance.cacheDirectory(),
    ];
  }

  Future<int> _directorySize(Directory directory) async {
    if (!await directory.exists()) return 0;
    var total = 0;
    try {
      await for (final entity in directory.list(recursive: true)) {
        if (entity is File) total += await entity.length();
      }
    } catch (_) {}
    return total;
  }
}
