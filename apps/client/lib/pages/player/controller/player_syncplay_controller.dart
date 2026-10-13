// ignore_for_file: library_private_types_in_public_api

import 'dart:async';

import 'package:kazumi/bean/dialog/dialog_helper.dart';
import 'package:kazumi/pages/player/controller/player_models.dart';
import 'package:kazumi/services/logging/logger.dart';
import 'package:kazumi/services/player/syncplay_client.dart';
import 'package:kazumi/services/player/syncplay_session_controller.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:mobx/mobx.dart';

part 'player_syncplay_controller.g.dart';

class PlayerSyncPlayController = _PlayerSyncPlayController
    with _$PlayerSyncPlayController;

abstract class _PlayerSyncPlayController with Store {
  _PlayerSyncPlayController({
    required this.bangumiId,
    required this.bangumiName,
    required this.sourceName,
    required this.currentEpisode,
    required this.currentRoad,
    required this.playing,
    required this.currentPosition,
    required this.playerPosition,
    required this.duration,
    required this.pause,
    required this.play,
    required this.seek,
    required this.canApplyPosition,
  });

  final int Function() bangumiId;
  final String Function() bangumiName;
  final String Function() sourceName;
  final int Function() currentEpisode;
  final int Function() currentRoad;
  final bool Function() playing;
  final bool Function() canApplyPosition;
  final Duration Function() currentPosition;
  final Duration Function() playerPosition;
  final Duration Function() duration;
  final Future<void> Function({bool enableSync}) pause;
  final Future<void> Function({bool enableSync}) play;
  final Future<void> Function(Duration duration, {bool enableSync}) seek;

  final SyncPlaySessionController session =
      Modular.get<SyncPlaySessionController>();
  StreamSubscription<Map<String, dynamic>>? _roomSubscription;
  StreamSubscription<Map<String, dynamic>>? _fileSubscription;
  StreamSubscription<Map<String, dynamic>>? _positionSubscription;
  StreamSubscription<Map<String, dynamic>>? _chatSubscription;
  Future<void> Function(String fileName)? _changeFile;
  Future<void> Function(int episode, {int currentRoad, int offset})?
      _changeEpisode;

  SyncplayClient? get syncplayController => session.client;

  @observable
  String syncplayRoom = '';
  @observable
  int syncplayClientRtt = 0;

  bool get hasSession => session.hasSession;
  bool get isHost => session.isHost;
  bool get isGuest => session.isGuest;

  void setRemoteFileHandler(Future<void> Function(String fileName)? handler) {
    _changeFile = handler;
  }

  void setEpisodeHandler(
    Future<void> Function(int episode, {int currentRoad, int offset}) handler,
  ) {
    _changeEpisode = handler;
  }

  void attachToExistingSession({
    Future<void> Function(int episode, {int currentRoad, int offset})?
        changeEpisode,
  }) {
    if (changeEpisode != null) _changeEpisode = changeEpisode;
    if (!session.hasSession) return;
    final episodeHandler = _changeEpisode;
    if (episodeHandler == null) return;
    syncplayRoom = session.room;
    _unbindSession();
    _bindSession(episodeHandler);
    final fileName = session.currentFileName;
    if (fileName.isNotEmpty && isGuest) {
      unawaited(_handleFileChanged(fileName, episodeHandler));
    }
    final position = session.latestPosition;
    if (position != null && isGuest) {
      _applyRemotePosition(position);
    }
  }

  final StreamController<SyncPlayChatMessage> _chatStreamController =
      StreamController<SyncPlayChatMessage>.broadcast();

  Stream<SyncPlayChatMessage> get chatStream => _chatStreamController.stream;

  void emitChatMessage({
    required String username,
    required String message,
    required bool fromRemote,
  }) {
    if (_chatStreamController.isClosed) return;
    _chatStreamController.add(SyncPlayChatMessage(
      username: username,
      message: message,
      fromRemote: fromRemote,
    ));
  }

  Future<void> createRoom(
    String room,
    String username,
    Future<void> Function(int episode, {int currentRoad, int offset})
        changeEpisode, {
    Future<void> Function(String fileName)? changeFile,
    bool? enableTLS,
    bool asHost = true,
  }) async {
    _changeFile = changeFile;
    _changeEpisode = changeEpisode;
    _unbindSession();

    try {
      if (!session.hasSession ||
          session.room != room ||
          session.username != username ||
          session.isHost != asHost) {
        await session.connect(
          nextRoom: room,
          nextUsername: username,
          asHost: asHost,
          enableTLS: enableTLS,
        );
      }
      syncplayRoom = session.room;
      _bindSession(changeEpisode);

      final fileName = session.currentFileName;
      if (fileName.isNotEmpty && isGuest) {
        unawaited(_handleFileChanged(fileName, changeEpisode));
      }
    } catch (error) {
      KazumiLogger().e('SyncPlay: error', error: error);
      KazumiDialog.showToast(message: '一起看连接失败：$error');
    }
  }

  void _bindSession(
    Future<void> Function(int episode, {int currentRoad, int offset})
        changeEpisode,
  ) {
    _roomSubscription = session.roomEvents.listen((message) {
      syncplayRoom = session.room;
      if (message['type'] == 'init') {
        if (isHost) {
          KazumiDialog.showToast(message: '已创建房间，房间号：${session.room}');
        } else if (session.ownerName.isNotEmpty) {
          KazumiDialog.showToast(message: '已加入房间，跟随房主 ${session.ownerName} 播放');
        }
      }
      if (message['type'] == 'left' && session.roomEnded) {
        KazumiDialog.showToast(message: '房主已离开，一起看房间已结束');
        unawaited(exitRoom());
      }
    });
    _fileSubscription = session.fileEvents.listen((message) {
      if (!isGuest) return;
      unawaited(_handleFileChanged(
        '${message['name'] ?? ''}',
        changeEpisode,
      ));
    });
    _positionSubscription = session.positionEvents.listen((message) {
      if (!isGuest) return;
      syncplayClientRtt =
          (((message['clientRtt'] as num?) ?? 0).toDouble() * 1000).round();
      _applyRemotePosition(message);
    });
    _chatSubscription = session.chatEvents.listen((message) {
      final sender = '${message['username'] ?? ''}';
      emitChatMessage(
        username: sender,
        message: '${message['message'] ?? ''}',
        fromRemote: sender != session.username,
      );
    });
  }

  Future<void> _handleFileChanged(
    String fileName,
    Future<void> Function(int episode, {int currentRoad, int offset})
        changeEpisode,
  ) async {
    final match = RegExp(r'^(\d+)\[(\d+)\](?:\|(.*))?$').firstMatch(fileName);
    if (match == null) return;
    final id = int.tryParse(match.group(1) ?? '') ?? 0;
    final episode = int.tryParse(match.group(2) ?? '') ?? 0;
    if (id <= 0 || episode <= 0) return;

    var source = session.currentSourceName;
    final payload = match.group(3) ?? '';
    final separator = payload.indexOf('|');
    if (source.isEmpty && separator >= 0) {
      try {
        source = Uri.decodeComponent(payload.substring(0, separator));
      } on FormatException {
        return;
      }
    }
    if (id == bangumiId() &&
        episode == currentEpisode() &&
        (source.isEmpty ||
            source.toLowerCase() == sourceName().toLowerCase())) {
      return;
    }
    if (_changeFile != null) {
      try {
        await _changeFile!(fileName);
      } catch (error) {
        KazumiLogger()
            .w('SyncPlay: remote file transition failed', error: error);
      }
      return;
    }
    if (id == bangumiId()) {
      await changeEpisode(episode, currentRoad: currentRoad());
    }
  }

  void _applyRemotePosition(Map<String, dynamic> message) {
    if (!canApplyPosition()) return;
    final paused = message['paused'] == true;
    if (paused != !playing()) {
      if (paused) {
        unawaited(pause(enableSync: false));
      } else {
        unawaited(play(enableSync: false));
      }
    }
    final calculated =
        (message['calculatedPositon'] as num?)?.toDouble() ?? 0.0;
    if (duration().inMilliseconds <= 0 || calculated < 0) return;
    final difference =
        (playerPosition().inMilliseconds - calculated * 1000).abs();
    if (difference > 1000 || message['doSeek'] == true) {
      unawaited(seek(
        Duration(milliseconds: (calculated * 1000).round()),
        enableSync: false,
      ));
    }
  }

  void setCurrentPosition({bool? forceSyncPlaying, double? forceSyncPosition}) {
    if (!isHost || session.client == null) return;
    final position = forceSyncPosition ??
        (((currentPosition().inMilliseconds - playerPosition().inMilliseconds)
                    .abs() >
                2000)
            ? currentPosition().inMilliseconds / 1000
            : playerPosition().inMilliseconds / 1000);
    session.publishPosition(
      position: position,
      paused: !(forceSyncPlaying ?? playing()),
    );
  }

  Future<void> setPlayingBangumi({
    bool? forceSyncPlaying,
    double? forceSyncPosition,
  }) async {
    if (!isHost || session.client == null) return;
    final title = bangumiName().trim();
    final source = sourceName().trim();
    final encodedSource = Uri.encodeComponent(source);
    final encodedTitle = title.isEmpty ? '' : Uri.encodeComponent(title);
    final fileName = source.isEmpty
        ? (encodedTitle.isEmpty
            ? '${bangumiId()}[${currentEpisode()}]'
            : '${bangumiId()}[${currentEpisode()}]|$encodedTitle')
        : '${bangumiId()}[${currentEpisode()}]|$encodedSource|$encodedTitle';
    await session.publishFile(name: fileName, sourceName: source);
    setCurrentPosition(
      forceSyncPlaying: forceSyncPlaying,
      forceSyncPosition: forceSyncPosition,
    );
    await requestSync(doSeek: null);
  }

  Future<void> requestSync({bool? doSeek}) async {
    await session.requestSync(doSeek: doSeek);
  }

  Future<void> sendChatMessage(String message) async {
    await session.sendChat(message);
  }

  void _unbindSession() {
    _roomSubscription?.cancel();
    _fileSubscription?.cancel();
    _positionSubscription?.cancel();
    _chatSubscription?.cancel();
    _roomSubscription = null;
    _fileSubscription = null;
    _positionSubscription = null;
    _chatSubscription = null;
  }

  void detach() {
    _unbindSession();
  }

  @action
  Future<void> exitRoom() async {
    _unbindSession();
    syncplayRoom = '';
    syncplayClientRtt = 0;
    await session.disconnect();
  }

  Future<void> dispose() async {
    _unbindSession();
    await _chatStreamController.close();
  }
}
