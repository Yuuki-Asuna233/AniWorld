import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_volume_controller/flutter_volume_controller.dart';
import 'package:media_kit/media_kit.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/services/player/external_playback_launcher.dart';
import 'package:kazumi/services/player/playback_session_monitor.dart';
import 'package:kazumi/pages/player/controller/player_danmaku_controller.dart';
import 'package:kazumi/pages/player/controller/player_debug_controller.dart';
import 'package:kazumi/pages/player/controller/player_models.dart';
import 'package:kazumi/pages/player/controller/player_panel_controller.dart';
import 'package:kazumi/pages/player/controller/player_playback_controller.dart';
import 'package:kazumi/pages/player/controller/player_seek_controller.dart';
import 'package:kazumi/pages/player/controller/player_syncplay_controller.dart';
import 'package:kazumi/services/storage/storage.dart';
import 'package:kazumi/services/logging/logger.dart';
import 'package:kazumi/services/shaders/shader_asset_service.dart';
import 'package:kazumi/utils/device.dart';
import 'package:kazumi/utils/async_serial_queue.dart';
import 'package:kazumi/services/platform/platform_environment_service.dart';
import 'package:flutter/widgets.dart'
    show WidgetsBinding, WidgetsBindingObserver, AppLifecycleState;

export 'package:kazumi/pages/player/controller/player_models.dart';

class PlayerController with WidgetsBindingObserver {
  PlayerController() {
    WidgetsBinding.instance.addObserver(this);
    playback.canPlay = () =>
        !_applicationPaused ||
        GStorage.getSetting<bool>(SettingsKeys.backgroundPlayback);
    _applicationPaused =
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.paused ||
            WidgetsBinding.instance.lifecycleState == AppLifecycleState.hidden;
    unawaited(_syncLifecycle());
  }

  bool _applicationPaused = false;
  bool _disposed = false;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_disposed) return;
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      _applicationPaused = true;
    } else if (state == AppLifecycleState.resumed) {
      _applicationPaused = false;
    } else {
      return;
    }
    unawaited(_syncLifecycle());
  }

  Future<void> _syncLifecycle() async {
    if (_disposed) return;
    final suspend = _applicationPaused &&
        !GStorage.getSetting<bool>(SettingsKeys.backgroundPlayback);
    final prefetch = playback.setPrefetchSuspended(suspend);
    if (suspend) {
      playback.requestedPlay = false;
      await pause(enableSync: false);
    }
    await prefetch;
  }

  final ShaderAssetService shaderAssetService =
      Modular.get<ShaderAssetService>();
  final PlayerPanelController panel = PlayerPanelController();
  final PlayerDebugController debug = PlayerDebugController();

  late final PlayerDanmakuController danmaku = PlayerDanmakuController(
    isLocalPlayback: () => isLocalPlayback,
  );
  late final PlayerPlaybackController playback = PlayerPlaybackController(
    shaderAssetService: shaderAssetService,
    debug: debug,
    videoUrl: () => videoUrl,
    onExitSyncPlayRoom: () => syncplay.exitRoom(),
    isLocalPlayback: () => isLocalPlayback,
  );
  late final PlayerSyncPlayController syncplay = PlayerSyncPlayController(
    bangumiId: () => bangumiId,
    bangumiName: () => bangumiName,
    sourceName: () => playbackSourceName,
    currentEpisode: () => currentEpisode,
    currentRoad: () => currentRoad,
    playing: () => playback.playing,
    canApplyPosition: () =>
        !playback.loading &&
        playback.mediaPlayer != null &&
        playback.isCurrentPlayer(playback.mediaPlayer!),
    currentPosition: () => playback.currentPosition,
    playerPosition: () => playback.playerPosition,
    duration: () => playback.duration,
    pause: pause,
    play: play,
    seek: seek,
  );
  late final ExternalPlaybackLauncher externalPlayback =
      ExternalPlaybackLauncher(
    videoUrl: () => videoUrl,
    referer: () => referer,
  );
  // 对齐原版：seek 统一走 PlayerSeekController（player.seek 直达，无 reopen 特殊路径）
  late final PlayerSeekController seeking = PlayerSeekController(
    playback: playback,
    danmaku: danmaku,
    pause: pause,
    play: play,
    onSeekCompleted: _onSeekCompleted,
  );

  late int bangumiId;
  late int currentEpisode;
  late int currentDanmakuEpisodeNumber;
  late int currentRoad;
  late String referer;
  late String episodeTitle;
  late String bangumiName;
  Map<String, String> httpHeaders = const {};
  String? coverUrl;
  String videoUrl = '';
  String playbackSourceName = '';
  bool isLocalPlayback = false;
  int _initializationRevision = 0;
  final AsyncSerialQueue _mediaOperations = AsyncSerialQueue();
  Player? _volumeAttachedPlayer;
  PlaybackOpenException? lastInitializationError;
  Future<void> Function()? onHistoryCheckpoint;
  Timer? hideVolumeUITimer;
  Timer? _volumeGestureSyncTimer;
  double? _pendingGestureVolume;

  void setVolumeDuringGesture(double value) {
    _pendingGestureVolume = value.clamp(0.0, 100.0);
    playback.updateVolume(_pendingGestureVolume!);
    _volumeGestureSyncTimer?.cancel();
    _volumeGestureSyncTimer = Timer(const Duration(milliseconds: 80), () {
      final vol = _pendingGestureVolume;
      if (vol == null) {
        return;
      }
      unawaited(playback.syncVolumeToDevice(vol));
    });
  }

  Future<void> finishVolumeGesture() async {
    _volumeGestureSyncTimer?.cancel();
    _volumeGestureSyncTimer = null;
    final vol = _pendingGestureVolume;
    _pendingGestureVolume = null;
    if (vol != null) {
      playback.volume = vol;
    }
    playback.invalidatePreciseVolume();
    await playback.syncVolumeToDevice(vol);
  }

  Future<bool> init(
    PlaybackInitParams params, {
    bool Function()? isActive,
    Duration timeout = const Duration(seconds: 45),
  }) async {
    if (!(isActive?.call() ?? true)) return false;
    final revision = ++_initializationRevision;
    seeking.invalidateInteractiveSeek();
    playback.cancelSession();
    lastInitializationError = null;
    bool ownsInitialization() =>
        revision == _initializationRevision && (isActive?.call() ?? true);
    if (!ownsInitialization()) return false;
    return _mediaOperations.run(() async {
      if (!ownsInitialization()) return false;
      final opened = await _initialize(params, ownsInitialization);
      if (opened || !ownsInitialization() || !Platform.isAndroid) return opened;
      if (lastInitializationError?.kind == 'decoder' && playback.hAenable) {
        return _initialize(params, ownsInitialization, softwareDecoder: true);
      }
      final renderer = params.androidVideoRenderer ??
          GStorage.getSetting(SettingsKeys.androidVideoRenderer);
      if (lastInitializationError?.kind == 'renderer' && renderer == 'auto') {
        return _initialize(params, ownsInitialization, fallbackRenderer: true);
      }
      return false;
    }).timeout(timeout, onTimeout: () {
      if (revision == _initializationRevision) {
        _initializationRevision++;
        lastInitializationError = const PlaybackOpenException('timeout');
        playback.cancelSession();
        playback.loading = false;
        final cleanupRevision = _initializationRevision;
        unawaited(_mediaOperations.run(() async {
          if (cleanupRevision == _initializationRevision) {
            await _disposeResources(disposeSyncPlayController: false);
          }
        }));
      }
      return false;
    });
  }

  Future<bool> _initialize(PlaybackInitParams params, bool Function() isActive,
      {bool softwareDecoder = false, bool fallbackRenderer = false}) async {
    if (!isActive()) return false;
    lastInitializationError = null;
    videoUrl = params.videoUrl;
    playbackSourceName = params.pluginName;
    isLocalPlayback = params.isLocalPlayback;
    bangumiId = params.bangumiId;
    currentEpisode = params.episode;
    currentDanmakuEpisodeNumber = params.danmakuEpisodeNumber;
    currentRoad = params.currentRoad;
    referer = params.referer;
    episodeTitle = params.episodeTitle;
    bangumiName = params.bangumiName ?? '';
    httpHeaders = Map<String, String>.from(params.httpHeaders);
    playback.setReportMeta(
        anime: bangumiName, episode: currentEpisode.toString());

    KazumiLogger().i(
        'PlayerController: ${params.isLocalPlayback ? "local" : "online"} playback, url: ${params.videoUrl}');

    playback.resetForInit();
    debug.playerLogLevel = GStorage.getSetting(SettingsKeys.playerLogLevel);
    playback.playerSpeed = GStorage.getSetting(SettingsKeys.defaultPlaySpeed);
    panel.aspectRatioType =
        GStorage.getSetting(SettingsKeys.defaultAspectRatioType);

    playback.buttonSkipTime = GStorage.getSetting(SettingsKeys.buttonSkipTime);
    playback.arrowKeySkipTime =
        GStorage.getSetting(SettingsKeys.arrowKeySkipTime);
    final Player? player;
    try {
      player = await playback.createVideoController(
        params.httpHeaders,
        params.adBlockerEnabled,
        mediaUrl: params.videoUrl,
        isActive: isActive,
        offset: params.offset,
        videoSourceFormat: params.videoSourceFormat,
        androidVideoRendererOverride: softwareDecoder || fallbackRenderer
            ? 'gpu'
            : params.androidVideoRenderer,
        hardwareDecoderOverride:
            softwareDecoder ? 'no' : params.hardwareDecoder,
        hardwareAccelerationOverride:
            softwareDecoder ? false : params.hardwareAccelerationEnabled,
        startup: params.startup,
      );
    } catch (e) {
      if (!isActive()) return false;
      lastInitializationError = e is PlaybackOpenException
          ? e
          : const PlaybackOpenException('initialization');
      playback.loading = false;
      KazumiLogger()
          .e('PlayerController: failed to initialize video', error: e);
      return false;
    }
    if (player == null || !playback.isCurrentPlayer(player)) {
      return false;
    }

    // Media readiness controls presentation; volume/shader services are auxiliary.
    playback.syncPlaybackState();
    playback.loading = false;
    KazumiLogger().i('PlayerController: video ready');
    final observer = playback.monitor;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (isActive() && identical(playback.monitor, observer)) {
        observer?.markVisible();
      }
    });
    unawaited(_configureVolume(player, isActive));
    unawaited(_configureVisuals(player, isActive));
    coverUrl = params.coverUrl;
    syncplay.attachToExistingSession();

    if (syncplay.isHost &&
        (syncplay.syncplayController?.isConnected ?? false)) {
      if (!syncplay.session.currentFileName
          .startsWith("$bangumiId[$currentEpisode]")) {
        setSyncPlayPlayingBangumi(
            forceSyncPlaying: true, forceSyncPosition: 0.0);
      }
    }
    return true;
  }

  Future<void> setShader(int type,
      {bool synchronized = true, Player? player}) async {
    await playback.setShader(
      type,
      synchronized: synchronized,
      player: player,
    );
  }

  Future<void> _configureVolume(Player player, bool Function() isActive) async {
    if (isDesktop() || identical(_volumeAttachedPlayer, player)) return;
    bool current() => isActive() && playback.isCurrentPlayer(player);
    try {
      final value = await FlutterVolumeController.getVolume()
          .timeout(const Duration(seconds: 2));
      if (!current()) return;
      playback.volume = (value ?? 1.0) * 100;
      await FlutterVolumeController.updateShowSystemUI(false)
          .timeout(const Duration(seconds: 2));
      if (!current()) return;
      FlutterVolumeController.removeListener();
      FlutterVolumeController.addListener((volume) {
        if (!playback.isCurrentPlayer(player) || panel.volumeSeeking) return;
        playback.applyExternalVolume(volume * 100);
        if (!Platform.isAndroid) {
          panel.showVolume = true;
          hideVolumeUITimer?.cancel();
          hideVolumeUITimer =
              Timer(const Duration(seconds: 1), () => panel.showVolume = false);
        }
      }, category: AudioSessionCategory.playback, emitOnStart: false);
      _volumeAttachedPlayer = player;
    } catch (error) {
      KazumiLogger()
          .w('Playback: system volume integration unavailable', error: error);
    }
  }

  Future<void> _configureVisuals(
      Player player, bool Function() isActive) async {
    final shaderType = playback.superResolutionType;
    if (shaderType != 1 && !shaderAssetService.isInitialized()) {
      try {
        await _assetWarmup?.timeout(const Duration(seconds: 2));
      } catch (error) {
        KazumiLogger()
            .w('Playback: shader resources are not ready', error: error);
      }
    }
    if (!isActive()) return;
    try {
      await _mediaOperations.run(() async {
        if (!isActive() || !playback.isCurrentPlayer(player)) return;
        await playback.cachePolicy.apply(starting: false);
        if (!isActive()) return;
        if (shaderType == 1 || shaderAssetService.isInitialized()) {
          await playback.setShader(shaderType,
              player: player, isActive: isActive);
        }
      });
    } catch (error) {
      KazumiLogger()
          .w('Playback: visual configuration unavailable', error: error);
    }
  }

  Future<void>? _assetWarmup;
  void warmupAssets() {
    unawaited(PlatformEnvironmentService.getAndroidSdkVersion());
    if (GStorage.getSetting(SettingsKeys.defaultSuperResolutionType) != 1 &&
        !shaderAssetService.isInitialized()) {
      _assetWarmup ??= shaderAssetService
          .copyShadersToExternalDirectory()
          .catchError((Object error) {
        KazumiLogger().w('Playback: shader warmup failed', error: error);
        _assetWarmup = null;
      });
    }
  }

  Future<void> setPlaybackSpeed(double playerSpeed) async {
    await playback.setPlaybackSpeed(playerSpeed);
    try {
      updateDanmakuSpeed();
    } catch (_) {}
  }

  void updateDanmakuSpeed() {
    danmaku.updateDanmakuSpeed(playback.playerSpeed);
  }

  Future<void> setVolume(double value) async {
    await playback.setVolume(value);
  }

  void syncPlaybackState() {
    playback.syncPlaybackState();
  }

  Future<void> playOrPause() async {
    await playback.playOrPause(pause: pause, play: play);
  }

  Future<void> seek(Duration duration, {bool enableSync = true}) {
    if (enableSync && syncplay.isGuest) return Future<void>.value();
    return seeking.seekTo(duration, enableSync: enableSync);
  }

  bool beginInteractiveSeek() =>
      !syncplay.isGuest && seeking.beginInteractiveSeek();
  void seekFromInteraction(Duration target) {
    if (syncplay.isGuest) return;
    if (!seeking.updateInteractiveSeek(target)) unawaited(seek(target));
  }

  Future<void> seekBy(Duration offset, {bool enableSync = true}) {
    if (enableSync && syncplay.isGuest) return Future<void>.value();
    return seeking.seekBy(offset, enableSync: enableSync);
  }

  Future<void> _onSeekCompleted(bool enableSync) async {
    final player = playback.mediaPlayer;
    final generation = (player?.platform as NativePlayer?)?.mediaGeneration;
    playback.monitor?.markSeek();
    await onHistoryCheckpoint?.call();
    if (player == null ||
        !playback.isCurrentPlayer(player) ||
        generation != (player.platform as NativePlayer).mediaGeneration) {
      return;
    }
    if (syncplay.syncplayController != null) {
      setSyncPlayCurrentPosition();
      if (enableSync) {
        await requestSyncPlaySync(doSeek: true);
      }
    }
  }

  Future<void> pause({bool enableSync = true}) async {
    if (enableSync && syncplay.isGuest) return;
    playback.requestedPlay = false;
    final player = playback.mediaPlayer;
    if (player == null) return;
    final generation = (player.platform as NativePlayer).mediaGeneration;
    danmaku.canvasController.pause();
    try {
      await player.pause();
    } catch (_) {
      return;
    }
    if (!playback.isCurrentPlayer(player) ||
        generation != (player.platform as NativePlayer).mediaGeneration) {
      return;
    }
    playback.playing = false;
    await onHistoryCheckpoint?.call();
    if (!playback.isCurrentPlayer(player) ||
        generation != (player.platform as NativePlayer).mediaGeneration) {
      return;
    }
    if (syncplay.syncplayController != null) {
      setSyncPlayCurrentPosition();
      if (enableSync) {
        await requestSyncPlaySync();
      }
    }
  }

  Future<void> play({bool enableSync = true}) async {
    if (enableSync && syncplay.isGuest) return;
    if (_disposed || playback.canPlay?.call() == false) return;
    playback.requestedPlay = true;
    final player = playback.mediaPlayer;
    if (player == null) return;
    final generation = (player.platform as NativePlayer).mediaGeneration;
    danmaku.canvasController.resume();
    try {
      await player.play();
    } catch (_) {
      return;
    }
    if (!playback.isCurrentPlayer(player) ||
        generation != (player.platform as NativePlayer).mediaGeneration) {
      return;
    }
    playback.playing = true;
    if (syncplay.syncplayController != null) {
      setSyncPlayCurrentPosition();
      if (enableSync) {
        await requestSyncPlaySync();
      }
    }
  }

  Future<void> dispose({
    bool disposeSyncPlayController = true,
  }) async {
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    final checkpoint = onHistoryCheckpoint?.call();
    _initializationRevision++;
    playback.cancelSession();
    seeking.invalidateInteractiveSeek();
    final cleanup = _mediaOperations.run(() => _disposeResources(
        disposeSyncPlayController: disposeSyncPlayController));
    await Future.wait([if (checkpoint != null) checkpoint, cleanup]);
  }

  Future<void> _disposeResources(
      {required bool disposeSyncPlayController}) async {
    // Detach the old instance before any await, so a later init cannot be
    // disposed by cleanup that resumes late.
    final disposePlayback =
        playback.dispose(disposeSyncPlayController: disposeSyncPlayController);
    hideVolumeUITimer?.cancel();
    _volumeGestureSyncTimer?.cancel();
    FlutterVolumeController.removeListener();
    _volumeAttachedPlayer = null;
    if (!disposeSyncPlayController) syncplay.detach();
    try {
      if (!isDesktop()) {
        await FlutterVolumeController.updateShowSystemUI(true)
            .timeout(const Duration(seconds: 2));
      }
    } catch (error) {
      KazumiLogger()
          .w('PlayerController: volume UI cleanup failed', error: error);
    } finally {
      await disposePlayback;
    }
  }

  Future<void> stop() async {
    final checkpoint = onHistoryCheckpoint?.call();
    _initializationRevision++;
    playback.cancelSession();
    seeking.invalidateInteractiveSeek();
    final stopping = _mediaOperations.run(playback.stop);
    await Future.wait([if (checkpoint != null) checkpoint, stopping]);
  }

  Future<Uint8List?> screenshot({String format = 'image/jpeg'}) async {
    return await playback.screenshot(format: format);
  }

  Future<Uint8List?> screenshotPng() async {
    return await playback.screenshotPng();
  }

  void setButtonForwardTime(int time) {
    playback.buttonSkipTime = time;
    GStorage.putSetting(SettingsKeys.buttonSkipTime, time);
  }

  void setArrowKeyForwardTime(int time) {
    playback.arrowKeySkipTime = time;
    GStorage.putSetting(SettingsKeys.arrowKeySkipTime, time);
  }

  Future<void> launchExternalPlayer() async {
    await externalPlayback.launch();
  }

  Future<void> createSyncPlayRoom(
      String room,
      String username,
      Future<void> Function(int episode, {int currentRoad, int offset})
          changeEpisode,
      {Future<void> Function(String fileName)? changeFile,
      bool enableTLS = true,
      bool asHost = true}) async {
    await syncplay.createRoom(
      room,
      username,
      changeEpisode,
      changeFile: changeFile,
      enableTLS: enableTLS,
      asHost: asHost,
    );
    // If a room is created from an already playing page, announce the current
    // title/episode immediately.  Otherwise guests would join successfully
    // but remain on the lobby's "waiting for host" state until the next user
    // action (pause, seek or episode change).
    if (asHost && syncplay.syncplayController?.isConnected == true) {
      await setSyncPlayPlayingBangumi(
        forceSyncPlaying: playback.playing,
        forceSyncPosition: playback.currentPosition.inMilliseconds / 1000,
      );
    }
  }

  void attachSyncPlaySession({
    Future<void> Function(String fileName)? changeFile,
    Future<void> Function(int episode, {int currentRoad, int offset})?
        changeEpisode,
    bool deferAttach = false,
  }) {
    syncplay.setRemoteFileHandler(changeFile);
    if (changeEpisode != null) syncplay.setEpisodeHandler(changeEpisode);
    if (!deferAttach) {
      syncplay.attachToExistingSession();
    }
  }

  void setSyncPlayCurrentPosition(
      {bool? forceSyncPlaying, double? forceSyncPosition}) {
    syncplay.setCurrentPosition(
      forceSyncPlaying: forceSyncPlaying,
      forceSyncPosition: forceSyncPosition,
    );
  }

  Future<void> setSyncPlayPlayingBangumi(
      {bool? forceSyncPlaying, double? forceSyncPosition}) async {
    await syncplay.setPlayingBangumi(
      forceSyncPlaying: forceSyncPlaying,
      forceSyncPosition: forceSyncPosition,
    );
  }

  Future<void> requestSyncPlaySync({bool? doSeek}) async {
    await syncplay.requestSync(doSeek: doSeek);
  }

  Future<void> sendSyncPlayChatMessage(String message) async {
    await syncplay.sendChatMessage(message);
  }

  Future<void> exitSyncPlayRoom() async {
    await syncplay.exitRoom();
  }
}
