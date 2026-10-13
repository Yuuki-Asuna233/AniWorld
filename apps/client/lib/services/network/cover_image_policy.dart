import 'dart:typed_data';

import 'package:image/image.dart' as image;

/// Only expand the known cover mirror; never guess another title's cover.
class CoverImagePolicy {
  static const placeholderMaxBytes = 1024;

  static Uri? _originalCover(String url) {
    final mirror = Uri.tryParse(url);
    if (mirror == null ||
        !RegExp(r'^gimg\d+\.baidu\.com$').hasMatch(mirror.host) ||
        (mirror.path != '/gimg' && !mirror.path.startsWith('/gimg/'))) {
      return null;
    }
    try {
      var source = mirror.queryParameters['src'] ?? '';
      if (source.isEmpty && mirror.path.startsWith('/gimg/')) {
        // CYCANI places app/src in the path, not the URL query. Parse the raw
        // text so an encoded source URL is decoded exactly once.
        final start = url.indexOf('/gimg/') + '/gimg/'.length;
        final parameters =
            url.substring(start).split('?').first.split('#').first;
        source = Uri.splitQueryString(parameters)['src'] ?? '';
      }
      final uri =
          Uri.tryParse(source.startsWith('http') ? source : 'https://$source');
      return uri != null && _isCoverOrigin(uri) ? uri : null;
    } on FormatException {
      return null;
    }
  }

  static bool _isCoverOrigin(Uri uri) =>
      (uri.scheme == 'https' || uri.scheme == 'http') &&
      uri.userInfo.isEmpty &&
      RegExp(r'^img\d+\.cycimg\.me$').hasMatch(uri.host) &&
      uri.path.startsWith('/pic/cover/');

  static bool shouldValidate(String url) {
    final uri = Uri.tryParse(url);
    return (uri != null && _isCoverOrigin(uri)) || _originalCover(url) != null;
  }

  static List<String> sources(String? primary, String? fallback) {
    final urls = <String>{};
    for (final value in [primary, fallback]) {
      final url = value?.trim() ?? '';
      if (url.isNotEmpty) urls.add(url);
    }
    for (final url in urls.toList()) {
      final original = _originalCover(url);
      if (original != null) urls.add(original.toString());
    }
    return urls.toList();
  }

  /// Inspect only tiny GIFs from the known cover source. Normal GIF covers,
  /// avatars and emotes are not rejected based on their format.
  static bool isTransparentPlaceholder(Uint8List bytes) {
    if (bytes.length < 10 || bytes.length > placeholderMaxBytes) return false;
    if (bytes[0] != 0x47 || bytes[1] != 0x49 || bytes[2] != 0x46) return false;
    final width = bytes[6] | (bytes[7] << 8);
    final height = bytes[8] | (bytes[9] << 8);
    if (width <= 0 || height <= 0 || width > 16 || height > 16) return false;
    try {
      final decoder = image.GifDecoder();
      final info = decoder.startDecode(bytes);
      if (info == null || info.numFrames == 0) return false;
      // Also bound individual frame dimensions before allocating pixel data.
      if (info.frames.any((frame) => frame.width > 16 || frame.height > 16)) {
        return false;
      }
      for (var index = 0; index < info.numFrames; index++) {
        final frame = decoder.decodeFrame(index);
        if (frame == null || frame.any((pixel) => pixel.a != 0)) return false;
      }
      return true;
    } catch (_) {
      return false; // Malformed images remain the image decoder's responsibility.
    }
  }
}
