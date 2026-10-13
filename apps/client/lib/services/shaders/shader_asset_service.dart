import 'dart:io';

import 'package:flutter/services.dart' show rootBundle, AssetManifest;
import 'package:kazumi/services/logging/logger.dart';
import 'package:path/path.dart' as path;
import 'package:path_provider/path_provider.dart';

class ShaderAssetService {
  late Directory shadersDirectory;
  bool _initialized = false;
  Future<void>? _copying;

  bool isInitialized() => _initialized;

  /// Copy GLSL shader assets to an external directory accessible to mpv.
  /// Throws on failure so callers can show error feedback.
  Future<void> copyShadersToExternalDirectory() async {
    if (_initialized) return;
    final active = _copying;
    if (active != null) return active;
    final work = _copyAssets();
    _copying = work;
    try {
      await work;
    } finally {
      if (identical(_copying, work)) _copying = null;
    }
  }

  Future<void> _copyAssets() async {
    final assetManifest = await AssetManifest.loadFromAssetBundle(rootBundle);
    final assets = assetManifest.listAssets();
    final directory = await getApplicationSupportDirectory();
    shadersDirectory = Directory(path.join(directory.path, 'anime_shaders'));

    if (!await shadersDirectory.exists()) {
      await shadersDirectory.create(recursive: true);
      KazumiLogger()
          .i('ShaderManager: Create GLSL Shader: ${shadersDirectory.path}');
    }

    final shaderFiles = assets.where((String asset) =>
        asset.startsWith('assets/shaders/') && asset.endsWith('.glsl'));

    int copiedFilesCount = 0;
    final errors = <String>[];

    for (var filePath in shaderFiles) {
      final fileName = filePath.split('/').last;
      final targetFile = File(path.join(shadersDirectory.path, fileName));
      if (await targetFile.exists()) {
        KazumiLogger()
            .i('ShaderManager: GLSL Shader exists, skip: ${targetFile.path}');
        copiedFilesCount++;
        continue;
      }

      try {
        final data = await rootBundle.load(filePath);
        final List<int> bytes = data.buffer.asUint8List();
        await targetFile.writeAsBytes(bytes);
        copiedFilesCount++;
        KazumiLogger().i('ShaderManager: Copy: ${targetFile.path}');
      } catch (e) {
        errors.add('$fileName: $e');
        KazumiLogger().e('ShaderManager: Copy: ($filePath)', error: e);
      }
    }

    // Validate: at least some shaders were copied
    if (copiedFilesCount == 0) {
      throw Exception(
          '着色器文件复制失败，无法启用超分辨率。${errors.isNotEmpty ? "错误: ${errors.join(", ")}" : ""}');
    }

    _initialized = true;
    KazumiLogger().i(
        'ShaderManager: $copiedFilesCount GLSL files copied to ${shadersDirectory.path}');
  }
}
