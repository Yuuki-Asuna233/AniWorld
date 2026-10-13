// ignore_for_file: library_private_types_in_public_api

import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_volume_controller/flutter_volume_controller.dart';
import 'package:kazumi/bean/dialog/dialog_helper.dart';
import 'package:kazumi/pages/player/controller/player_debug_controller.dart';
import 'package:kazumi/services/shaders/shader_asset_service.dart';
import 'package:kazumi/utils/constants.dart';
import 'package:kazumi/services/logging/logger.dart';
import 'package:kazumi/services/player/player_screenshot_service.dart';
import 'package:kazumi/services/player/playback_cache_policy.dart';
import 'package:kazumi/services/player/playback_session_monitor.dart';
import 'package:kazumi/services/player/playback_instance_config.dart';
import 'package:kazumi/services/player/playback_startup_trace.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';
import 'package:kazumi/services/storage/storage.dart';
import 'package:media_kit/media_kit.dart';
import 'package:media_kit_video/media_kit_video.dart';
import 'package:mobx/mobx.dart';
import 'package:kazumi/utils/device.dart';
import 'package:path/path.dart' as path;
import 'package:kazumi/services/video_source/video_source_format.dart';
import 'dart:async';
import 'package:flutter/foundation.dart';

part 'player_playback_controller.g.dart';

class PlayerPlaybackController = _PlayerPlaybackController
    with _$PlayerPlaybackController;

abstract class _PlayerPlaybackController with Store {
  _PlayerPlaybackController({
    required this.shaderAssetService,
    required this.debug,
    required this.videoUrl,
    required this.onExitSyncPlayRoom,
    required this.isLocalPlayback,
  });

  final ShaderAssetService shaderAssetService;
  final PlayerDebugController debug;
  final String Function() videoUrl;
  bool Function()? _playerIsActive;
  final Future<void> Function() onExitSyncPlayRoom;
  final bool Function() isLocalPlayback;
  late final PlaybackCachePolicy cachePolicy = PlaybackCachePolicy(
    currentPlayer: () => mediaPlayer,
    isLocalPlayback: isLocalPlayback,
  );
  final PlayerScreenshotService screenshotService =
      const PlayerScreenshotService();

  /// 播放上报用元数据，由 PlayerController.init 拿到番剧信息后填充。
  String anime = '';
  String episode = '';

  Player? mediaPlayer;
  VideoController? videoController;
  PlaybackSessionMonitor? monitor;
  Future<bool> Function(Player player, String reason)? onRecovery;
  bool? requestedPlay;
  bool Function()? canPlay;
  PlaybackInstanceConfig? _instanceConfig;
  VideoSourceFormat? _instanceFormat;
  bool _shadersApplied = false;

  bool hAenable = true;
  late String hardwareDecoder;
  bool androidEnableOpenSLES = true;
  bool autoPlay = true;
  bool playerDebugMode = false;
  int buttonSkipTime = 80;
  int arrowKeySkipTime = 10;

  /// 视频超分
  /// 1. OFF
  /// 2. Anime4K Efficiency
  /// 3. Anime4K Quality
  @observable
  int superResolutionType = 1;

  @observable
  double volume = -1;

  /// 手势调节时的精确音量，避免 UI 节流导致累计误差
  double preciseVolume = -1;

  @observable
  bool loading = true;
  @observable
  bool playing = false;
  @observable
  bool isBuffering = true;
  @observable
  bool completed = false;
  @observable
  Duration currentPosition = Duration.zero;
  @observable
  Duration buffer = Duration.zero;
  @observable
  Duration duration = Duration.zero;
  @observable
  double playerSpeed = 1.0;

  bool isCurrentPlayer(Player player) {
    return identical(mediaPlayer, player) && (_playerIsActive?.call() ?? true);
  }

  Future<Player?> _discardIfNotCurrent(Player player) async {
    if (isCurrentPlayer(player)) {
      return player;
    }
    if (identical(mediaPlayer, player)) {
      monitor?.dispose();
      monitor = null;
      cachePolicy.stopWatching();
      mediaPlayer = null;
      videoController = null;
      _instanceConfig = null;
      _instanceFormat = null;
      _shadersApplied = false;
      _playerIsActive = null;
    }
    try {
      await player.dispose();
    } catch (_) {}
    return null;
  }

  @action
  void resetForInit() {
    playing = false;
    loading = true;
    isBuffering = true;
    currentPosition = Duration.zero;
    buffer = Duration.zero;
    duration = Duration.zero;
    completed = false;
  }

  bool get playerPlaying {
    try {
      return mediaPlayer?.state.playing ?? false;
    } catch (_) {
      return false;
    }
  }

  bool get playerBuffering {
    try {
      return mediaPlayer?.state.buffering ?? false;
    } catch (_) {
      return false;
    }
  }

  bool get playerCompleted {
    try {
      return mediaPlayer?.state.completed ?? false;
    } catch (_) {
      return false;
    }
  }

  double get playerVolume {
    try {
      return mediaPlayer?.state.volume ?? volume;
    } catch (_) {
      return volume;
    }
  }

  Duration get playerPosition {
    try {
      return mediaPlayer?.state.position ?? currentPosition;
    } catch (_) {
      return currentPosition;
    }
  }

  Duration get playerBuffer {
    try {
      return monitor?.bufferedPosition ?? mediaPlayer?.state.buffer ?? buffer;
    } catch (_) {
      return buffer;
    }
  }

  Duration get playerDuration {
    try {
      return mediaPlayer?.state.duration ?? duration;
    } catch (_) {
      return duration;
    }
  }

  int _preferredBufferSize() => cachePolicy.bufferSize;

  /// Android may block network access while the app is backgrounded. Stop
  /// demuxer readahead while paused so failed background requests do not burn
  /// through HLS retries and leave the foreground player stuck at EOF.
  Future<void> setPrefetchSuspended(bool suspended) async {
    try {
      await cachePolicy.setPrefetchSuspended(suspended);
    } catch (_) {
      // Policy failures are already logged. Lifecycle callbacks must complete
      // even if the native player is being replaced or disposed.
    }
  }

  Future<void> _openRawMedia(
    Player player,
    Map<String, String> httpHeaders, {
    required int offset,
    required String mediaUrl,
    bool? play,
  }) async {
    if (!isCurrentPlayer(player)) return;
    final allowed = canPlay?.call() ?? true;
    if (!allowed) requestedPlay = false;
    await player.open(
      Media(
        mediaUrl,
        start: offset > 0 ? Duration(seconds: offset) : null,
        httpHeaders: httpHeaders,
      ),
      play: allowed && (play ?? requestedPlay ?? autoPlay),
    );
    if (!isCurrentPlayer(player)) return;
    if (canPlay?.call() == false) {
      requestedPlay = false;
      await player.pause();
    }
  }

  Future<Player?> createVideoController(
      Map<String, String> httpHeaders, bool adBlockerEnabled,
      {required String mediaUrl,
      required bool Function() isActive,
      int offset = 0,
      VideoSourceFormat videoSourceFormat = VideoSourceFormat.auto,
      String? androidVideoRendererOverride,
      String? hardwareDecoderOverride,
      bool? hardwareAccelerationOverride,
      PlaybackStartupTrace? startup}) async {
    final config = await PlaybackInstanceConfig.read(
        adBlocker: adBlockerEnabled,
        logLevel: debug.playerLogLevel,
        renderer: androidVideoRendererOverride,
        decoder: hardwareDecoderOverride,
        hardware: hardwareAccelerationOverride);
    if (!isActive()) return null;
    final retained = mediaPlayer;
    final reused = retained != null &&
        videoController != null &&
        _instanceConfig?.identity == config.identity &&
        _instanceFormat == videoSourceFormat &&
        !(retained.platform as NativePlayer).disposed &&
        (retained.platform as NativePlayer).supportsMediaEntryIds;
    if (!reused) {
      await dispose(disposeSyncPlayController: false);
      if (!isActive()) return null;
    }
    final player = mediaPlayer ??
        Player(
            configuration: PlayerConfiguration(
                bufferSize: _preferredBufferSize(),
                osc: false,
                adBlocker: config.adBlocker,
                logLevel: MPVLogLevel.values[
                    config.logLevel.clamp(0, MPVLogLevel.values.length - 1)]));
    mediaPlayer = player;
    _instanceConfig = config;
    _instanceFormat = videoSourceFormat;
    _playerIsActive = isActive;
    hardwareDecoder = config.decoder;
    hAenable = config.hardware;
    androidEnableOpenSLES = config.audioOutput == 'opensles';
    autoPlay = GStorage.getSetting(SettingsKeys.autoPlay);
    playerDebugMode = GStorage.getSetting(SettingsKeys.playerDebugMode);
    superResolutionType = config.renderer == 'mediacodec_embed'
        ? 1
        : GStorage.getSetting(SettingsKeys.defaultSuperResolutionType);
    final native = player.platform as NativePlayer;
    try {
      if (!reused) {
        debug.playerLog.clear();
        await debug.setup(player,
            isCurrentPlayer: isCurrentPlayer, playerDebugMode: playerDebugMode);
        if (!isActive()) return await _discardIfNotCurrent(player);
        await cachePolicy.configureDiskDirectory();
        await _optionalProperty(native, 'af', 'scaletempo2=max-speed=8');
        if (Platform.isAndroid) {
          await _optionalProperty(native, 'volume-max', '100');
          await native.setProperty('ao', config.audioOutput);
        }
        if (config.proxy.isNotEmpty) {
          await native.setProperty('http-proxy', config.proxy);
        }
        if (!isActive()) return await _discardIfNotCurrent(player);
        videoController = VideoController(player,
            configuration: VideoControllerConfiguration(
                vo: config.renderer,
                enableAndroidSurfaceProducer: false,
                enableHardwareAcceleration: config.hardware,
                hwdec: config.hardware ? config.decoder : 'no',
                androidAttachSurfaceAfterVideoParameters: false));
      }
      if (!isActive()) return await _discardIfNotCurrent(player);
      await cachePolicy.apply(starting: true);
      cachePolicy.startWatching();
      await _optionalProperty(native, 'network-timeout', '15');
      // Rebuild when the hint changes: an auto file uses the engine default,
      // independent of whether this libmpv supports resetting a live HLS hint.
      if (videoSourceFormat == VideoSourceFormat.hls) {
        await native.setProperty('demuxer-lavf-format', 'hls');
      }
      await player.setPlaylistMode(PlaylistMode.none);
      await setPlaybackSpeed(playerSpeed);
      if (isDesktop()) await player.setVolume(volume < 0 ? 100 : volume);
      if (!isActive()) return await _discardIfNotCurrent(player);
      startup?.mark('engineReadyMs');
      final observer = PlaybackSessionMonitor(
          player: player,
          startup: startup,
          isCurrent: () => isActive() && isCurrentPlayer(player),
          canRecover: () =>
              !isLocalPlayback() &&
              !cachePolicy.prefetchSuspended &&
              (requestedPlay ?? autoPlay) &&
              onRecovery != null,
          onRecover: (reason) =>
              onRecovery?.call(player, reason) ?? Future.value(false),
          onTerminalError: (kind) {
            if (isActive() &&
                GStorage.getSetting(SettingsKeys.showPlayerError)) {
              KazumiDialog.showToast(
                  message: '播放已中断，请重试或切换播放源', showActionButton: true);
            }
          },
          metadata: {
            'sourceHost': Uri.tryParse(mediaUrl)?.host ?? '',
            'anime': anime,
            'episode': episode,
            'videoType': videoSourceFormat.name,
            'player': 'mpv',
            'os': Platform.operatingSystem,
            'osVersion': Platform.operatingSystemVersion,
            'instanceReused': reused,
            'diskCache': cachePolicy.diskAvailable
          },
          report: (event) {
            KazumiLogger().i('Playback: ${event.toString()}');
            if (!isLocalPlayback()) {
              unawaited(AniWorldApi.reportPlayback(event));
            }
          });
      monitor = observer;
      await observer.open(
          videoController!,
          () => _openRawMedia(player, httpHeaders,
              offset: offset, mediaUrl: mediaUrl),
          newSurface: !reused);
      if (!isActive()) return await _discardIfNotCurrent(player);
      return player;
    } catch (_) {
      if (identical(monitor?.player, player)) {
        monitor?.dispose();
        monitor = null;
      }
      await _discardPlayer(player);
      rethrow;
    }
  }

  Future<void> _optionalProperty(
      NativePlayer native, String name, String value) async {
    try {
      await native.setProperty(name, value);
    } catch (error) {
      KazumiLogger()
          .w('Playback: optional property $name unavailable', error: error);
    }
  }

  Future<void> setShader(int type,
      {bool synchronized = true,
      Player? player,
      bool Function()? isActive}) async {
    final currentPlayer = player ?? mediaPlayer;
    if (currentPlayer == null || !(isActive?.call() ?? true)) return;
    if (type == 1 && !_shadersApplied) return;

    // Guard: ensure shader assets are initialized (skip when turning off)
    if (type != 1 && !shaderAssetService.isInitialized()) {
      try {
        await shaderAssetService.copyShadersToExternalDirectory();
        // Double-check: verify the directory actually has shader files
        final files = shaderAssetService.shadersDirectory.listSync();
        final hasGlsl = files.any((f) => f.path.endsWith('.glsl'));
        if (!hasGlsl) {
          KazumiDialog.showToast(message: '超分辨率资源文件缺失，无法启用');
          return;
        }
      } catch (e) {
        KazumiLogger()
            .w('PlayerController: shader assets init failed', error: e);
        KazumiDialog.showToast(message: '超分辨率资源初始化失败: $e');
        return;
      }
    }

    try {
      var pp = currentPlayer.platform as NativePlayer;
      await pp.waitForPlayerInitialization;
      // Wait for video controller init only if attached; guard with timeout
      if (videoController != null) {
        try {
          await pp.waitForVideoControllerInitializationIfAttached.timeout(
            const Duration(seconds: 5),
            onTimeout: () => KazumiLogger().w(
                'PlayerController: timeout waiting for video controller init'),
          );
        } catch (e) {
          KazumiLogger().w(
              'PlayerController: waitForVideoControllerInit failed',
              error: e);
        }
      }
      if (!identical(mediaPlayer, currentPlayer) ||
          !(isActive?.call() ?? true)) {
        return;
      }

      // Helper: append each shader file individually so mpv reports which one fails
      Future<void> applyShaders(List<String> shaderNames) async {
        // First clear existing shaders (clr requires empty value argument)
        await pp.command(['change-list', 'glsl-shaders', 'clr', '']);
        final base = shaderAssetService.shadersDirectory.path;
        for (final name in shaderNames) {
          if (!(isActive?.call() ?? true) ||
              !identical(mediaPlayer, currentPlayer)) {
            return;
          }
          final fullPath = path.join(base, name);
          KazumiLogger().i('PlayerController: loading shader $fullPath');
          try {
            await pp.command([
              'change-list',
              'glsl-shaders',
              'append',
              fullPath,
            ]);
          } catch (e) {
            KazumiLogger()
                .w('PlayerController: failed to load shader $name', error: e);
            // Continue loading other shaders instead of aborting
          }
        }
      }

      if (type == 2) {
        await applyShaders(mpvAnime4KShadersLite);
        if (!(isActive?.call() ?? true)) return;
        _shadersApplied = true;
        superResolutionType = 2;
        KazumiDialog.showToast(message: '已开启超分辨率（效率档）');
        return;
      }
      if (type == 3) {
        await applyShaders(mpvAnime4KShaders);
        if (!(isActive?.call() ?? true)) return;
        _shadersApplied = true;
        superResolutionType = 3;
        KazumiDialog.showToast(message: '已开启超分辨率（质量档）');
        return;
      }
      await pp.command(['change-list', 'glsl-shaders', 'clr', '']);
      _shadersApplied = false;
      superResolutionType = 1;
      KazumiDialog.showToast(message: '已关闭超分辨率');
    } catch (e) {
      KazumiLogger().w('PlayerController: failed to set shader', error: e);
      KazumiDialog.showToast(
        message: '超分辨率设置失败: $e',
      );
    }
  }

  Future<void> setPlaybackSpeed(double playerSpeed) async {
    this.playerSpeed = playerSpeed;
    final player = mediaPlayer;
    if (player == null) return;
    try {
      await player.setRate(playerSpeed);
    } catch (e) {
      KazumiLogger()
          .e('PlayerController: failed to set playback speed', error: e);
    }
  }

  Future<void> setVolume(double value) async {
    updateVolume(value);
    await syncVolumeToDevice(preciseVolume >= 0 ? preciseVolume : volume);
  }

  @action
  void updateVolume(double value) {
    value = value.clamp(0.0, 100.0);
    preciseVolume = value;
    if (volume.toInt() == value.toInt()) {
      return;
    }
    volume = value;
  }

  /// 外部来源（硬件键、系统面板等）变更音量时同步，并清除手势缓存
  @action
  void applyExternalVolume(double value) {
    value = value.clamp(0.0, 100.0);
    preciseVolume = -1;
    volume = value;
  }

  void invalidatePreciseVolume() {
    preciseVolume = -1;
  }

  Future<void> syncVolumeToDevice([double? value]) async {
    final vol = (value ?? volume).clamp(0.0, 100.0);
    try {
      if (isDesktop()) {
        await mediaPlayer!.setVolume(vol);
      } else {
        await FlutterVolumeController.setVolume(vol / 100);
      }
    } catch (_) {}
  }

  @action
  void syncPlaybackState() {
    final player = mediaPlayer;
    if (player == null) return;

    final PlayerState state;
    try {
      state = player.state;
    } catch (_) {
      return;
    }
    if (playing != state.playing) {
      playing = state.playing;
    }
    if (isBuffering != state.buffering) {
      isBuffering = state.buffering;
    }
    if (currentPosition != state.position) {
      currentPosition = state.position;
    }
    final buffered = monitor?.bufferedPosition ?? state.buffer;
    if (buffer != buffered) {
      buffer = buffered;
    }
    if (duration != state.duration) {
      duration = state.duration;
    }
    if (completed != state.completed) {
      completed = state.completed;
    }
  }

  Future<void> playOrPause({
    required Future<void> Function() pause,
    required Future<void> Function() play,
  }) async {
    if (playerPlaying) {
      await pause();
    } else {
      await play();
    }
  }

  Future<void> dispose({
    bool disposeSyncPlayController = true,
  }) async {
    monitor?.dispose();
    monitor = null;
    final player = mediaPlayer;
    mediaPlayer = null;
    videoController = null;
    _instanceConfig = null;
    _instanceFormat = null;
    _shadersApplied = false;
    _playerIsActive = null;
    cachePolicy.stopWatching();
    final cancelDebugInfoFuture = debug.cancel();
    if (disposeSyncPlayController) {
      try {
        await onExitSyncPlayRoom();
      } catch (_) {}
    }
    try {
      await cancelDebugInfoFuture;
    } catch (_) {}
    await _releasePlayer(player);
  }

  void cancelSession() {
    monitor?.dispose();
    monitor = null;
    _playerIsActive = () => false;
    resetForInit();
  }

  Future<void> stop() async {
    cancelSession();
    final player = mediaPlayer;
    try {
      await player?.stop();
    } catch (error) {
      KazumiLogger().w('Player: stop failed; releasing instance', error: error);
      if (player != null) await _discardPlayer(player);
    }
  }

  Future<void> _discardPlayer(Player player) async {
    if (identical(mediaPlayer, player)) {
      mediaPlayer = null;
      videoController = null;
      _instanceConfig = null;
      _instanceFormat = null;
      _shadersApplied = false;
      _playerIsActive = null;
      cachePolicy.stopWatching();
    }
    await _releasePlayer(player);
  }

  Future<void> _releasePlayer(Player? player) async {
    if (player == null) return;
    try {
      await player.dispose();
    } catch (error, stackTrace) {
      KazumiLogger().w('Player: resource release failed',
          error: error, stackTrace: stackTrace);
    }
  }

  Future<Uint8List?> screenshot({String format = 'image/jpeg'}) async {
    return await mediaPlayer!.screenshot(format: format);
  }

  Future<Uint8List?> screenshotPng() async {
    final player = mediaPlayer;
    if (player == null) {
      return null;
    }
    return await screenshotService.capturePng(player);
  }

  /// 由 PlayerController 在 init 拿到番剧信息后填充上报元数据。
  void setReportMeta({String anime = '', String episode = ''}) {
    this.anime = anime;
    this.episode = episode;
  }
}
