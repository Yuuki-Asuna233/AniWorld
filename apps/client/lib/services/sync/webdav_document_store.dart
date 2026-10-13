import 'dart:typed_data';
import 'package:dio/dio.dart';
import 'package:webdav_client/webdav_client.dart' as webdav;

class RemoteDocument {
  const RemoteDocument(this.bytes, this.etag);
  final List<int>? bytes;
  final String? etag;
  bool get exists => bytes != null;
}

/// Only a confirmed 404 is absence. A snapshot overwrite is a conditional commit.
class WebDavDocumentStore {
  const WebDavDocumentStore(this.client);
  final webdav.Client client;
  Future<RemoteDocument> read(String path) async {
    final response = await client.c.req<List<int>>(client, 'GET', path,
        optionsHandler: (options) {
      options.responseType = ResponseType.bytes;
    });
    if (response.statusCode == 404) return const RemoteDocument(null, null);
    if (response.statusCode != 200 || response.data == null) {
      throw StateError('WebDAV读取失败：HTTP ${response.statusCode}');
    }
    return RemoteDocument(response.data!, response.headers.value('etag'));
  }

  Future<void> commit(
      String path, List<int> bytes, RemoteDocument previous) async {
    final etag = previous.etag;
    if (previous.exists &&
        (etag == null || !etag.startsWith('"') || !etag.endsWith('"'))) {
      throw StateError('WebDAV未提供强ETag，不能安全覆盖历史快照');
    }
    final response = await client.c.req(client, 'PUT', path,
        data: Uint8List.fromList(bytes), optionsHandler: (options) {
      options.contentType = 'application/octet-stream';
      options.headers = {
        if (previous.exists) 'If-Match': etag else 'If-None-Match': '*'
      };
    });
    if (response.statusCode == 412) throw StateError('远端历史已更新，请重新同步');
    if (![200, 201, 204].contains(response.statusCode)) {
      throw StateError('WebDAV保存失败：HTTP ${response.statusCode}');
    }
  }
}
