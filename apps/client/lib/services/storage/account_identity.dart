import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:kazumi/request/config/api_endpoints.dart';

/// Server-local user IDs are never an identity across backends.
class AccountIdentity {
  AccountIdentity(String address, this.userId)
      : serverAddress = address.trim().isEmpty
            ? ApiEndpoints.defaultSelfBackend
            : address.trim();

  final String serverAddress;
  final int? userId;

  static String serverKey(String address) {
    final uri = Uri.parse(address.trim().isEmpty
        ? ApiEndpoints.defaultSelfBackend
        : address.trim());
    final origin =
        '${uri.scheme.toLowerCase()}://${uri.host.toLowerCase()}:${uri.port}';
    return sha256.convert(utf8.encode(origin)).toString();
  }

  String get serverId => serverKey(serverAddress);
  String get localOwner => userId == null ? 'guest' : 'user_$userId';
  String get owner => 'server_${serverId}_$localOwner';
}
