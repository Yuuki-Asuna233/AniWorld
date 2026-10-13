import 'dart:io';
import 'package:dio/dio.dart';
import 'package:kazumi/request/clients/download_http_client.dart';
import 'package:kazumi/utils/m3u8_parser.dart';

/// A segment becomes reusable only after its complete response is validated.
class SegmentDownload {
  const SegmentDownload(this.http);
  final DownloadHttpClient http;

  Future<int> fetch(
      String url, String path, Map<String, String> headers, CancelToken token,
      {M3u8ByteRange? range, int attempts = 3}) async {
    final temporary = File('$path.tmp');
    for (var attempt = 0;; attempt++) {
      if (token.isCancelled) throw token.cancelError!;
      try {
        final response = await http.download(url, temporary.path,
            headers: {
              ...headers,
              if (range != null)
                'Range':
                    'bytes=${range.offset}-${range.offset + range.length - 1}'
            },
            cancelToken: token);
        if (token.isCancelled) throw token.cancelError!;
        final size = await temporary.length();
        if (size <= 0) throw const FormatException('Empty media segment');
        if (range != null) {
          if (response.statusCode == 206) {
            final match =
                RegExp(r'^bytes\s+(\d+)-(\d+)/(\d+|\*)$', caseSensitive: false)
                    .firstMatch(response.headers.value('content-range') ?? '');
            if (match == null ||
                int.parse(match.group(1)!) != range.offset ||
                int.parse(match.group(2)!) != range.offset + range.length - 1 ||
                size != range.length ||
                (match.group(3) != '*' &&
                    int.parse(match.group(3)!) < range.offset + range.length)) {
              throw const FormatException('Media range response mismatch');
            }
          } else if (response.statusCode == 200) {
            if (size < range.offset + range.length) {
              throw const FormatException('Incomplete media resource');
            }
            final handle = await temporary.open();
            late List<int> bytes;
            try {
              await handle.setPosition(range.offset);
              bytes = await handle.read(range.length);
            } finally {
              await handle.close();
            }
            if (bytes.length != range.length) {
              throw const FormatException('Incomplete media range');
            }
            await temporary.writeAsBytes(bytes, flush: true);
          } else {
            throw const FormatException('Unexpected media range status');
          }
        }
        if (token.isCancelled) throw token.cancelError!;
        await temporary.rename(path);
        return await File(path).length();
      } catch (_) {
        if (await temporary.exists()) await temporary.delete();
        if (token.isCancelled || attempt + 1 >= attempts) rethrow;
        await Future.any<void>([
          Future<void>.delayed(Duration(seconds: attempt == 0 ? 1 : 3)),
          token.whenCancel.then<void>((_) {})
        ]);
      }
    }
  }
}
