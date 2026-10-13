import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:kazumi/services/logging/logger.dart';
import 'package:kazumi/services/player/syncplay_client.dart';
import 'package:kazumi/services/player/syncplay_endpoint.dart';
import 'package:kazumi/services/storage/storage.dart';

/// Owns the SyncPlay connection independently from a particular player page.
///
/// A player can come and go while the room remains connected. This is what
/// allows the top-level Together Watch page and the video page to share one
/// session instead of opening two competing SyncPlay connections.
class SyncPlaySessionController extends ChangeNotifier {
  SyncplayClient? client;
  StreamSubscription<Map<String, dynamic>>? _roomSubscription;
  StreamSubscription<Map<String, dynamic>>? _fileSubscription;
  StreamSubscription<Map<String, dynamic>>? _positionSubscription;
  StreamSubscription<Map<String, dynamic>>? _chatSubscription;

  final StreamController<Map<String, dynamic>> _roomEvents =
      StreamController<Map<String, dynamic>>.broadcast();
  final StreamController<Map<String, dynamic>> _fileEvents =
      StreamController<Map<String, dynamic>>.broadcast();
  final StreamController<Map<String, dynamic>> _positionEvents =
      StreamController<Map<String, dynamic>>.broadcast();
  final StreamController<Map<String, dynamic>> _chatEvents =
      StreamController<Map<String, dynamic>>.broadcast();

  String room = '';
  String username = '';
  String ownerName = '';
  String currentFileName = '';
  String currentSourceName = '';
  Map<String, dynamic>? latestPosition;
  bool isHost = false;
  bool roomEnded = false;

  bool get hasSession => client != null;
  bool get isGuest => hasSession && !isHost;

  Stream<Map<String, dynamic>> get roomEvents => _roomEvents.stream;
  Stream<Map<String, dynamic>> get fileEvents => _fileEvents.stream;
  Stream<Map<String, dynamic>> get positionEvents => _positionEvents.stream;
  Stream<Map<String, dynamic>> get chatEvents => _chatEvents.stream;

  Future<void> connect({
    required String nextRoom,
    required String nextUsername,
    required bool asHost,
    bool? enableTLS,
  }) async {
    await disconnect();

    final endpointText =
        GStorage.getSetting<String>(SettingsKeys.syncPlayEndPoint);
    final endpoint = parseSyncPlayEndPoint(endpointText);
    if (endpoint == null) {
      throw const FormatException('SyncPlay 服务地址无效');
    }

    final nextClient = SyncplayClient(
      host: endpoint.host,
      port: endpoint.port,
    );
    client = nextClient;
    room = nextRoom;
    username = nextUsername;
    isHost = asHost;
    ownerName = asHost ? nextUsername : '';
    currentFileName = '';
    currentSourceName = '';
    latestPosition = null;
    roomEnded = false;
    notifyListeners();

    try {
      await nextClient.connect(
        enableTLS: enableTLS ?? isOfficialSyncPlayEndPoint(endpoint),
      );
      if (!nextClient.isConnected) {
        throw SyncplayConnectionException('无法连接一起看服务器');
      }
      _bindClient(nextClient);
      await nextClient.joinRoom(nextRoom, nextUsername);
    } catch (error) {
      KazumiLogger().e('SyncPlay session connection failed', error: error);
      await disconnect();
      rethrow;
    }
  }

  void _bindClient(SyncplayClient nextClient) {
    _roomSubscription = nextClient.onRoomMessage.listen((message) {
      final type = '${message['type'] ?? ''}';
      final reportedOwner = '${message['username'] ?? ''}'.trim();
      if (type == 'init' && !isHost && reportedOwner.isNotEmpty) {
        ownerName = reportedOwner;
      } else if (type == 'init' && isHost) {
        ownerName = username;
      }
      if (type == 'left' &&
          ownerName.isNotEmpty &&
          reportedOwner == ownerName &&
          !isHost) {
        roomEnded = true;
      }
      // SyncPlay's initial playlistIndex message identifies the room owner,
      // but does not reliably include the owner's current file for clients
      // that join after playback has already started. Re-announce the host's
      // current file/state when a new participant joins so late guests can
      // immediately follow the same anime instead of receiving position-only
      // updates.
      if (type == 'joined' && isHost) {
        unawaited(_rebroadcastCurrentState());
      }
      _roomEvents.add(Map<String, dynamic>.from(message));
      notifyListeners();
    });

    _fileSubscription = nextClient.onFileChangedMessage.listen((message) {
      final setter = '${message['setBy'] ?? ''}'.trim();
      final name = '${message['name'] ?? ''}'.trim();
      if (name.isEmpty) return;
      if (isHost && setter.isNotEmpty && setter != username) return;
      if (!isHost && ownerName.isNotEmpty && setter != ownerName) return;
      if (!isHost && ownerName.isEmpty && setter.isNotEmpty) {
        ownerName = setter;
      }
      currentFileName = name;
      currentSourceName = '${message['source'] ?? ''}'.trim();
      _fileEvents.add({...message, 'name': name, 'setBy': setter});
      notifyListeners();
    });

    _positionSubscription = nextClient.onPositionChangedMessage.listen((message) {
      final setter = '${message['setBy'] ?? ''}'.trim();
      if (isHost) return;
      if (ownerName.isNotEmpty && setter.isNotEmpty && setter != ownerName) {
        return;
      }
      if (ownerName.isEmpty && setter.isNotEmpty) ownerName = setter;
      latestPosition = Map<String, dynamic>.from(message);
      _positionEvents.add(latestPosition!);
      notifyListeners();
    });

    _chatSubscription = nextClient.onChatMessage.listen((message) {
      _chatEvents.add(Map<String, dynamic>.from(message));
    });
  }

  Future<void> publishFile({
    required String name,
    String sourceName = '',
    double duration = 10800,
    int size = 220514438,
  }) async {
    if (!isHost || client == null) return;
    currentFileName = name;
    currentSourceName = sourceName;
    ownerName = username;
    await client!.setSyncPlayPlaying(name, duration, size);
    notifyListeners();
  }

  Future<void> _rebroadcastCurrentState() async {
    final activeClient = client;
    final fileName = currentFileName;
    if (!isHost || activeClient == null || !activeClient.isConnected) return;
    if (fileName.isEmpty) return;

    await activeClient.setSyncPlayPlaying(
      fileName,
      10800,
      220514438,
    );
    final state = latestPosition;
    if (state == null) return;
    final position = (state['calculatedPositon'] as num?)?.toDouble() ?? 0.0;
    final paused = state['paused'] == true;
    activeClient.setPaused(paused);
    activeClient.setPosition(position);
    await activeClient.sendSyncPlaySyncRequest(doSeek: true);
  }

  void publishPosition({
    required double position,
    required bool paused,
  }) {
    if (!isHost || client == null) return;
    client!.setPaused(paused);
    client!.setPosition(position);
    latestPosition = {
      'position': position,
      'calculatedPositon': position,
      'paused': paused,
      'doSeek': false,
      'setBy': username,
    };
    notifyListeners();
  }

  Future<void> requestSync({bool? doSeek}) async {
    // A guest must not submit its local position as the room authority.
    if (!isHost || client == null) return;
    await client!.sendSyncPlaySyncRequest(doSeek: doSeek);
  }

  Future<void> sendChat(String message) async {
    await client?.sendChatMessage(message);
  }

  Future<void> disconnect() async {
    await _roomSubscription?.cancel();
    await _fileSubscription?.cancel();
    await _positionSubscription?.cancel();
    await _chatSubscription?.cancel();
    _roomSubscription = null;
    _fileSubscription = null;
    _positionSubscription = null;
    _chatSubscription = null;
    final previous = client;
    client = null;
    room = '';
    username = '';
    ownerName = '';
    currentFileName = '';
    currentSourceName = '';
    latestPosition = null;
    isHost = false;
    roomEnded = false;
    notifyListeners();
    await previous?.disconnect();
  }

  @override
  void dispose() {
    unawaited(disconnect());
    unawaited(_roomEvents.close());
    unawaited(_fileEvents.close());
    unawaited(_positionEvents.close());
    unawaited(_chatEvents.close());
    super.dispose();
  }
}
