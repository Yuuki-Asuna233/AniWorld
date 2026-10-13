import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:kazumi/utils/m3u8_parser.dart';

/// Resume identity and disk completeness belong to the download, not its UI.
class HlsDownloadManifest {
  HlsDownloadManifest._(this.directory, this.identities, this.files);
  final String directory;
  final Map<String, String> identities;
  final Map<String, int> files;
  static const name = 'download-manifest.json';

  static String _resource(String value) {
    final uri = Uri.parse(value);
    // Only known signature fields are ephemeral; other query values can name media.
    final query = Map<String, List<String>>.from(uri.queryParametersAll)
      ..removeWhere((key, _) => [
            'x-amz-signature',
            'x-amz-credential',
            'x-amz-date',
            'x-amz-expires',
            'x-amz-security-token',
            'x-amz-signedheaders',
            'signature',
            'sign',
            'expires',
            'expiry'
          ].contains(key.toLowerCase()));
    final sorted = Map.fromEntries(
        query.entries.toList()..sort((a, b) => a.key.compareTo(b.key)));
    return uri.replace(queryParameters: sorted, fragment: '').toString();
  }

  static Future<HlsDownloadManifest> prepare(
      String directory,
      List<M3u8Segment> segments,
      M3u8Segment? init,
      Map<String, String> keyFiles,
      bool filterAds) async {
    final keys = <String, String>{};
    for (final entry in keyFiles.entries) {
      keys[entry.key] = (await File('$directory/${entry.value}')
              .openRead()
              .transform(sha256)
              .single)
          .toString();
    }
    String identity(M3u8Segment segment) => sha256
        .convert(utf8.encode(jsonEncode({
          'uri': _resource(segment.uri),
          'range': segment.byteRange == null
              ? null
              : [segment.byteRange!.offset, segment.byteRange!.length],
          'duration': segment.duration,
          'group': segment.discontinuityGroup,
          'filterAds': filterAds,
          'key': segment.key == null
              ? null
              : [
                  segment.key!.method,
                  _resource(segment.key!.uri),
                  segment.key!.iv,
                  keys[segment.key!.uri]
                ],
        })))
        .toString();
    final identities = <String, String>{
      for (var i = 0; i < segments.length; i++)
        segmentName(i, segments[i]): identity(segments[i]),
      if (init != null) 'init.mp4': identity(init),
      for (final entry in keyFiles.entries) entry.value: keys[entry.key]!,
    };
    Map<String, dynamic> previous = {};
    try {
      final value = jsonDecode(await File('$directory/$name').readAsString());
      if (value is Map && value['version'] == 1) {
        previous = Map<String, dynamic>.from(value);
      }
    } catch (_) {}
    final oldIdentities = previous['identities'] is Map
        ? previous['identities'] as Map
        : const {};
    final oldFiles =
        previous['files'] is Map ? previous['files'] as Map : const {};
    final retained = <String, int>{};
    for (final entry in identities.entries) {
      final file = File('$directory/${entry.key}');
      final size = oldFiles[entry.key];
      if (oldIdentities[entry.key] == entry.value &&
          size is int &&
          size > 0 &&
          await file.exists() &&
          await file.length() == size) {
        retained[entry.key] = size;
      } else if (!keyFiles.values.contains(entry.key) && await file.exists()) {
        await file.delete();
      }
    }
    final playlist = File('$directory/playlist.m3u8');
    if (await playlist.exists()) await playlist.delete();
    final result = HlsDownloadManifest._(directory, identities, retained);
    for (final keyFile in keyFiles.values) {
      await result.record(keyFile);
    }
    await result.save();
    return result;
  }

  static String segmentName(int index, M3u8Segment segment) =>
      'seg_${index.toString().padLeft(5, '0')}.${segment.byteRange == null ? 'ts' : 'mp4'}';
  bool canReuse(String filename) => files.containsKey(filename);
  Future<void> record(String filename) async {
    final size = await File('$directory/$filename').length();
    if (!identities.containsKey(filename) || size <= 0) {
      throw const FormatException('Incomplete download file');
    }
    files[filename] = size;
  }

  Future<void> save() async {
    final file = File('$directory/$name');
    final temporary = File('${file.path}.tmp');
    await temporary.writeAsString(
        jsonEncode({'version': 1, 'identities': identities, 'files': files}),
        flush: true);
    if (await file.exists()) await file.delete();
    await temporary.rename(file.path);
  }

  static Future<bool> playlistComplete(String directory) async {
    try {
      final text = await File('$directory/playlist.m3u8').readAsString();
      if (!text.startsWith('#EXTM3U') || !text.contains('#EXT-X-ENDLIST')) {
        return false;
      }
      final references = <String>{};
      for (final raw in text.split('\n')) {
        final line = raw.trim();
        if (line.isNotEmpty && !line.startsWith('#')) {
          references.add(line);
        }
        for (final match in RegExp(r'URI="([^"]+)"').allMatches(line)) {
          references.add(match.group(1)!);
        }
      }
      if (references.isEmpty) return false;
      Map? sizes;
      final manifestFile = File('$directory/$name');
      if (await manifestFile.exists()) {
        final manifest = jsonDecode(await manifestFile.readAsString());
        if (manifest is! Map ||
            manifest['version'] != 1 ||
            manifest['files'] is! Map) {
          return false;
        }
        sizes = manifest['files'] as Map;
      }
      for (final path in references) {
        if (!RegExp(r'^(seg_\d+\.(ts|mp4)|init\.mp4|key_\d+\.key)$')
            .hasMatch(path)) {
          return false;
        }
        final file = File('$directory/$path');
        if (!await file.exists() || await file.length() <= 0) return false;
        if (sizes != null && sizes[path] != await file.length()) return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }
}
