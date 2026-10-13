// ignore_for_file: library_private_types_in_public_api

import 'dart:async';
import 'package:kazumi/modules/roads/road_module.dart';
import 'package:kazumi/plugins/plugins_controller.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/plugins/plugins.dart';
import 'package:kazumi/pages/history/history_controller.dart';
import 'package:kazumi/pages/player/player_controller.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/modules/download/download_module.dart';
import 'package:kazumi/modules/history/history_module.dart';
import 'package:kazumi/repositories/download_repository.dart';
import 'package:kazumi/services/download/download_manager.dart';
import 'package:kazumi/services/video_source/services.dart';
import 'package:kazumi/services/video_source/video_source_format.dart';
import 'package:kazumi/bean/dialog/dialog_helper.dart';
import 'package:mobx/mobx.dart';
import 'package:kazumi/services/logging/logger.dart';
import 'package:window_manager/window_manager.dart';
import 'package:kazumi/modules/bangumi/episode_item.dart';
import 'package:kazumi/modules/comments/comment_item.dart';
import 'package:kazumi/modules/comments/comment_response.dart';
import 'package:kazumi/request/apis/bangumi_api.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';
import 'package:dio/dio.dart';
import 'package:media_kit/media_kit.dart' show Player;
import 'package:kazumi/services/storage/storage.dart';
import 'package:kazumi/services/access/access_gate_service.dart';
import 'package:kazumi/utils/device.dart';
import 'package:kazumi/utils/episode_url.dart';
import 'package:kazumi/utils/http_headers.dart';
import 'package:kazumi/utils/media.dart';
import 'package:kazumi/services/platform/display_mode_service.dart';
import 'package:kazumi/services/platform/fullscreen_orientation_policy.dart';
import 'package:kazumi/services/player/playback_startup_trace.dart';

part 'video_controller.g.dart';

class VideoPageController = _VideoPageController with _$VideoPageController;

// Controller-local ownership token for async work. Keep it private so playback
// and comment freshness checks stay inside VideoPageController instead of
// leaking through player, danmaku, or widget APIs.
class _AsyncSessionOwner {
  int _version = 0;

  _AsyncSession begin() {
    return _AsyncSession(this, ++_version);
  }

  void cancel() {
    _version++;
  }

  bool owns(_AsyncSession session) {
    return identical(session.owner, this) && session.version == _version;
  }
}

class _AsyncSession {
  _AsyncSession(this.owner, this.version);
  final PlaybackStartupTrace startup = PlaybackStartupTrace();

  final _AsyncSessionOwner owner;
  final int version;

  bool get isActive => owner.owns(this);

  bool get isStale => !isActive;
}

class VideoEpisodeSelection {
  const VideoEpisodeSelection({
    required this.episode,
    required this.road,
  });

  final int episode;
  final int road;

  @override
  bool operator ==(Object other) {
    return other is VideoEpisodeSelection &&
        other.episode == episode &&
        other.road == road;
  }

  @override
  int get hashCode => Object.hash(episode, road);

  @override
  String toString() {
    return 'VideoEpisodeSelection(episode: $episode, road: $road)';
  }
}

abstract class _VideoPageController with Store {
  late BangumiItem bangumiItem;
  EpisodeInfo episodeInfo = EpisodeInfo.fromTemplate();

  @observable
  var episodeCommentsList = ObservableList<EpisodeCommentItem>();

  @observable
  bool loading = true;

  @observable
  String? errorMessage;

  @observable
  VideoEpisodeSelection selectedEpisode =
      const VideoEpisodeSelection(episode: 1, road: 0);

  @observable
  VideoEpisodeSelection? playingEpisode;

  @observable
  int commentsEpisode = 1;

  void resetEpisodeState({int episode = 1, int road = 0}) {
    final selection = VideoEpisodeSelection(episode: episode, road: road);
    selectedEpisode = selection;
    playingEpisode = null;
    commentsEpisode = commentEpisodeForSelection(selection);
  }

  VideoEpisodeSelection get playbackEpisode =>
      playingEpisode ?? selectedEpisode;

  @observable
  bool isFullscreen = false;

  // Explicit fullscreen requests lock the app to landscape. During the short
  // Android configuration transition the widget may still report portrait;
  // that intermediate frame must not be interpreted as an exit request.
  bool _explicitLandscapeFullscreen = false;
  bool _suppressLandscapeAutoEnter = false;

  bool get shouldAutoExitFullscreenForPortrait =>
      shouldExitFullscreenForPortrait(
        isFullscreen: isFullscreen,
        explicitLandscapeFullscreen: _explicitLandscapeFullscreen,
      );

  bool get shouldAutoEnterFullscreenForLandscape =>
      shouldEnterFullscreenForLandscape(
        isFullscreen: isFullscreen,
        suppressAutoEnter: _suppressLandscapeAutoEnter,
      );

  void handlePortraitOrientationObserved() {
    if (!isFullscreen) {
      _suppressLandscapeAutoEnter = false;
    }
  }

  @observable
  bool isCommentsAscending = false;

  // Playback, automatic danmaku loading, and comment loading have separate
  // owners. Manual danmaku selection can cancel auto danmaku without touching
  // playback; comment refreshes never cancel playback.
  final _AsyncSessionOwner _playbackSessions = _AsyncSessionOwner();
  final _AsyncSessionOwner _remoteFileSessions = _AsyncSessionOwner();
  bool _disposed = false;
  CancelToken? _aniWorldResolutionCancel;
  int _recoveryAttempts = 0;
  int? _recoveryOffset;
  Object? _recoveryToken;
  final _AsyncSessionOwner _danmakuSessions = _AsyncSessionOwner();
  final _AsyncSessionOwner _commentSessions = _AsyncSessionOwner();

  @observable
  bool isPip = false;

  @observable
  bool showTabBody = true;

  @observable
  int historyOffset = 0;

  /// Set by SyncPlay when a guest opens the room owner's current episode.
  /// It is consumed by VideoPage before normal history-resume logic runs.
  int? syncPlayInitialEpisode;
  String? syncPlayInitialFileName;
  ({int? episode, bool resume})? _playbackStartRequest;

  void requestPlaybackStart({int? episode, bool resume = false}) {
    if (episode != null && (episode < 1 || episode > 999 || resume)) {
      throw ArgumentError('Invalid playback start request');
    }
    _playbackStartRequest = (episode: episode, resume: resume);
  }

  ({int? episode, bool resume})? consumePlaybackStartRequest() {
    final request = _playbackStartRequest;
    _playbackStartRequest = null;
    return request;
  }

  void bindSyncPlayRoute(PlayerController controller) {
    controller.bangumiId = bangumiItem.id;
    controller.bangumiName =
        bangumiItem.nameCn.isNotEmpty ? bangumiItem.nameCn : bangumiItem.name;
    controller.currentEpisode = selectedEpisode.episode;
    controller.currentRoad = selectedEpisode.road;
    controller.playbackSourceName = activePluginName;
    _bindSyncPlayCallbacks(controller);
  }

  void _bindSyncPlayCallbacks(PlayerController controller,
      {bool deferAttach = false}) {
    controller.attachSyncPlaySession(
      deferAttach: deferAttach,
      changeFile: (file) =>
          syncToSyncPlayFile(file, playerController: controller),
      changeEpisode: (episode, {currentRoad = 0, offset = 0}) => changeEpisode(
          episode,
          currentRoad: currentRoad,
          offset: offset,
          fromSyncPlay: true,
          playerController: controller),
    );
  }

  @observable
  bool isOfflineMode = false;

  PlaybackHistoryIdentity? _playbackHistoryIdentity;
  bool _resumeFromHistoryRequested = false;
  final Map<int, DownloadEpisode> _offlineEpisodesByNumber = {};
  final Map<int, int> _offlineDisplayRoadToOriginalRoad = {};
  final Map<int, int> _offlineOriginalRoadToDisplayRoad = {};

  /// 和 bangumiItem 中的标题不同，此标题来自于视频源
  String title = '';

  String src = '';

  @observable
  var roadList = ObservableList<Road>();

  late Plugin currentPlugin;

  String _offlinePluginName = '';

  CancelToken? _queryRoadsCancelToken;
  Future<void>? _pendingRoadQuery;
  Object? _pendingRoadQueryError;
  int _roadQueryGeneration = 0;

  final PluginsController pluginsController = Modular.get<PluginsController>();
  final HistoryController historyController = Modular.get<HistoryController>();
  final IDownloadRepository downloadRepository =
      Modular.get<IDownloadRepository>();
  final IDownloadManager downloadManager = Modular.get<IDownloadManager>();

  WebViewVideoSourceService? _videoSourceService;

  final StreamController<String> _logStreamController =
      StreamController<String>.broadcast();

  Stream<String> get logStream => _logStreamController.stream;

  StreamSubscription<String>? _logSubscription;

  void initForOfflinePlayback({
    required BangumiItem bangumiItem,
    required String pluginName,
    required int episodeNumber,
    required int road,
    required List<DownloadEpisode> downloadedEpisodes,
  }) {
    this.bangumiItem = bangumiItem;
    _offlinePluginName = pluginName;
    title =
        bangumiItem.nameCn.isNotEmpty ? bangumiItem.nameCn : bangumiItem.name;
    isOfflineMode = true;
    loading = false;

    _buildOfflineRoadList(downloadedEpisodes);

    final target = _findOfflineEpisodeByNumber(
      episodeNumber,
      preferredOriginalRoad: road,
    );
    final selected = VideoEpisodeSelection(
      episode: target?.listIndex ?? 1,
      road: target?.roadIndex ?? 0,
    );
    selectedEpisode = selected;
    playingEpisode = null;
    commentsEpisode = commentEpisodeForSelection(selected);
    final resolvedEpisode = _resolveOfflineEpisode(
      selected.episode,
      road: selected.road,
    );
    if (resolvedEpisode != null) {
      _setOfflineHistoryIdentity(resolvedEpisode);
    } else {
      _playbackHistoryIdentity = null;
    }
    KazumiLogger().i(
        'VideoPageController: initialized for offline playback, episode $episodeNumber (position: ${selected.episode})');
  }

  void _buildOfflineRoadList(List<DownloadEpisode> episodes) {
    final snapshot = buildOfflineRoadListSnapshot(episodes);
    roadList.clear();
    roadList.addAll(snapshot.roads);
    _offlineEpisodesByNumber.clear();
    _offlineEpisodesByNumber.addAll(snapshot.episodesByNumber);
    _offlineDisplayRoadToOriginalRoad.clear();
    _offlineDisplayRoadToOriginalRoad
        .addAll(snapshot.displayRoadToOriginalRoad);
    _offlineOriginalRoadToDisplayRoad.clear();
    _offlineOriginalRoadToDisplayRoad
        .addAll(snapshot.originalRoadToDisplayRoad);
  }

  void resetOfflineMode() {
    isOfflineMode = false;
    _offlinePluginName = '';
    _offlineEpisodesByNumber.clear();
    _offlineDisplayRoadToOriginalRoad.clear();
    _offlineOriginalRoadToDisplayRoad.clear();
    _playbackHistoryIdentity = null;
  }

  String get offlinePluginName => _offlinePluginName;

  PlaybackHistoryIdentity? get currentHistoryIdentity =>
      _playbackHistoryIdentity;

  bool get isAniWorldPlayback => roadList.any(
        (road) => road.data.any((url) => url.startsWith('aniworld://')),
      );

  String get activePluginName => isOfflineMode
      ? _offlinePluginName
      : (isAniWorldPlayback ? 'AniWorld' : currentPlugin.name);

  ({int listIndex, int roadIndex})? _findOfflineEpisodeByNumber(
    int episodeNumber, {
    required int preferredOriginalRoad,
  }) {
    if (episodeNumber <= 0 || roadList.isEmpty) {
      return null;
    }
    final preferredDisplayRoad =
        _offlineOriginalRoadToDisplayRoad[preferredOriginalRoad];
    final roadIndices = <int>[
      if (preferredDisplayRoad != null) preferredDisplayRoad,
      for (var i = 0; i < roadList.length; i++)
        if (i != preferredDisplayRoad) i,
    ];
    for (final roadIndex in roadIndices) {
      final match = _findOfflineEpisodeInDisplayRoad(episodeNumber, roadIndex);
      if (match != null) {
        return match;
      }
    }
    return null;
  }

  ({int listIndex, int roadIndex})? _findOfflineEpisodeInDisplayRoad(
    int episodeNumber,
    int roadIndex,
  ) {
    if (roadIndex < 0 || roadIndex >= roadList.length) {
      return null;
    }
    final index = roadList[roadIndex].data.indexOf(episodeNumber.toString());
    if (index < 0) {
      return null;
    }
    return (listIndex: index + 1, roadIndex: roadIndex);
  }

  void requestHistoryResume() {
    _resumeFromHistoryRequested = true;
  }

  bool consumeHistoryResumeRequest() {
    final requested = _resumeFromHistoryRequested;
    _resumeFromHistoryRequested = false;
    return requested;
  }

  int getHistoryOffsetFor(
    PlaybackHistoryIdentity identity, {
    bool force = false,
  }) {
    final playResume = GStorage.getSetting(SettingsKeys.playResume);
    if (!force && playResume != true) {
      return 0;
    }
    return historyController
            .findProgress(
              identity.bangumiItem,
              identity.pluginName,
              identity.episodeNumber,
              entryKind: identity.entryKind,
            )
            ?.progress
            .inSeconds ??
        0;
  }

  void _setOnlineHistoryIdentity(EpisodeRef episode) {
    _playbackHistoryIdentity = PlaybackHistoryIdentity.online(
      bangumiItem: bangumiItem,
      pluginName: currentPlugin.name,
      episodeNumber: episode.historyEpisodeNumber,
      episodeTitle: episode.displayTitle,
      road: episode.originalRoadIndex,
      onlineBangumiSrc: src,
      episodePageUrl: episode.pageUrl,
    );
  }

  void _setOfflineHistoryIdentity(EpisodeRef episode) {
    _playbackHistoryIdentity = PlaybackHistoryIdentity.offline(
      bangumiItem: bangumiItem,
      pluginName: _offlinePluginName,
      episodeNumber: episode.historyEpisodeNumber,
      episodeTitle: episode.displayTitle,
      road: episode.originalRoadIndex,
      episodePageUrl: episode.pageUrl,
    );
  }

  EpisodeRef? _resolveOnlineEpisode(int episode, {int? road}) {
    final targetRoad = road ?? selectedEpisode.road;
    if (roadList.isEmpty || targetRoad < 0 || targetRoad >= roadList.length) {
      return null;
    }
    final roadData = roadList[targetRoad];
    final index = episode - 1;
    if (index < 0 ||
        index >= roadData.data.length ||
        index >= roadData.identifier.length) {
      return null;
    }
    final displayTitle = roadData.identifier[index];
    return EpisodeRef.online(
      listIndex: episode,
      roadIndex: targetRoad,
      displayTitle: displayTitle,
      pageUrl: roadData.data[index],
    );
  }

  /// Resolve a persisted episode page URL back to its current display index.
  /// This matters for sources such as DM84 whose historical page order was
  /// newest-first: the old history key is a list index, while the normalized
  /// road now displays the same episode at a different index.
  VideoEpisodeSelection? findOnlineEpisodeByPageUrl(
    String pageUrl, {
    int preferredRoad = 0,
  }) {
    final target = pageUrl.trim();
    if (target.isEmpty || roadList.isEmpty) return null;

    final roads = <int>[
      if (preferredRoad >= 0 && preferredRoad < roadList.length) preferredRoad,
      for (var road = 0; road < roadList.length; road++)
        if (road != preferredRoad) road,
    ];
    for (final roadIndex in roads) {
      final index =
          roadList[roadIndex].data.indexWhere((url) => url.trim() == target);
      if (index >= 0) {
        return VideoEpisodeSelection(episode: index + 1, road: roadIndex);
      }
    }
    return null;
  }

  /// Match actual episode numbers, rather than assuming the list index is the number.
  VideoEpisodeSelection? findOnlineEpisodeByNumber(int number) {
    for (var road = 0; road < roadList.length; road++) {
      for (var index = 1; index <= roadList[road].data.length; index++) {
        final episode = _resolveOnlineEpisode(index, road: road);
        if (episode == null) continue;
        final uri = Uri.tryParse(episode.pageUrl);
        final structuredNumber = uri?.scheme == 'aniworld'
            ? int.tryParse(uri!.queryParameters['j'] ?? '')
            : null;
        if ((structuredNumber ?? episode.sortNumber) == number) {
          return VideoEpisodeSelection(episode: index, road: road);
        }
      }
    }
    return null;
  }

  EpisodeRef? _resolveOfflineEpisode(int episode, {int? road}) {
    final targetRoad = road ?? selectedEpisode.road;
    if (roadList.isEmpty || targetRoad < 0 || targetRoad >= roadList.length) {
      return null;
    }
    final roadData = roadList[targetRoad];
    final index = episode - 1;
    if (index < 0 ||
        index >= roadData.data.length ||
        index >= roadData.identifier.length) {
      return null;
    }
    final episodeNumber = int.tryParse(roadData.data[index]);
    if (episodeNumber == null) {
      return null;
    }
    final downloadEpisode = _offlineEpisodesByNumber[episodeNumber];
    final titleFromRoad = roadData.identifier[index];
    final episodeTitle = downloadEpisode?.episodeName.isNotEmpty == true
        ? downloadEpisode!.episodeName
        : (titleFromRoad.isNotEmpty ? titleFromRoad : '第$episodeNumber集');
    return EpisodeRef.offline(
      listIndex: episode,
      roadIndex: targetRoad,
      displayTitle: episodeTitle,
      pageUrl: downloadEpisode?.episodePageUrl ?? '',
      episodeNumber: episodeNumber,
      originalRoadIndex: downloadEpisode?.road ??
          _offlineDisplayRoadToOriginalRoad[targetRoad] ??
          targetRoad,
    );
  }

  EpisodeRef? resolveEpisode(VideoEpisodeSelection selection) {
    return isOfflineMode
        ? _resolveOfflineEpisode(selection.episode, road: selection.road)
        : _resolveOnlineEpisode(selection.episode, road: selection.road);
  }

  int commentEpisodeForSelection(VideoEpisodeSelection selection) {
    final resolvedEpisode = resolveEpisode(selection);
    return resolvedEpisode?.danmakuEpisodeNumber ?? selection.episode;
  }

  Future<void> changeEpisode(
    int episode, {
    int currentRoad = 0,
    int offset = 0,
    bool fromSyncPlay = false,
    bool recovering = false,
    required PlayerController playerController,
  }) async {
    if (playerController.syncplay.isGuest &&
        !fromSyncPlay &&
        playerController.playback.mediaPlayer != null) {
      KazumiDialog.showToast(message: '当前由房主控制播放');
      return;
    }
    _bindSyncPlayCallbacks(playerController, deferAttach: true);
    final checkpoint = playerController.onHistoryCheckpoint?.call();
    _aniWorldResolutionCancel?.cancel('Playback selection changed');
    _aniWorldResolutionCancel = CancelToken();
    if (!recovering) {
      _recoveryAttempts = 0;
      _recoveryOffset = null;
      _recoveryToken = null;
      playerController.playback.requestedPlay =
          GStorage.getSetting(SettingsKeys.autoPlay);
    } else {
      _recoveryOffset = offset;
    }
    final session = _playbackSessions.begin();
    final selection = VideoEpisodeSelection(
      episode: episode,
      road: currentRoad,
    );
    playerController.playback.onRecovery = (player, reason) =>
        _recoverPlayback(playerController, player, selection, session, reason);
    selectedEpisode = selection;
    playingEpisode = null;
    commentsEpisode = commentEpisodeForSelection(selection);
    resetEpisodeComments();
    _danmakuSessions.cancel();
    playerController.danmaku.finishDanmakuLoad();
    _videoSourceService?.cancel();
    loading = true;
    errorMessage = null;

    final prepared = Future.wait<void>([
      if (checkpoint != null) checkpoint,
      playerController.stop(),
    ]).then<void>((_) {
      session.startup.mark('prepareMs');
    });
    // Attach an error handler immediately while resolution proceeds in parallel.
    unawaited(prepared.catchError((Object error) {
      KazumiLogger().w('Playback: transition preparation failed', error: error);
    }));
    playerController.warmupAssets();

    if (isOfflineMode) {
      await prepared;
      if (session.isStale) return;
      await _changeOfflineEpisode(
        selection,
        offset,
        session: session,
        playerController: playerController,
      );
      return;
    }

    final resolvedEpisode = _resolveOnlineEpisode(episode, road: currentRoad);
    if (resolvedEpisode == null) {
      loading = false;
      KazumiLogger().e(
          'VideoPageController: failed to resolve online episode. road=$currentRoad, episode=$episode');
      KazumiDialog.showToast(message: '集数解析失败');
      return;
    }

    selectedEpisode = VideoEpisodeSelection(
      episode: resolvedEpisode.listIndex,
      road: resolvedEpisode.roadIndex,
    );
    commentsEpisode = commentEpisodeForSelection(selectedEpisode);
    if (resolvedEpisode.pageUrl.startsWith('aniworld://')) {
      await _resolveWithAniWorldOi(
        resolvedEpisode,
        offset,
        prepared: prepared,
        session: session,
        playerController: playerController,
      );
      return;
    }
    _setOnlineHistoryIdentity(resolvedEpisode);

    KazumiLogger()
        .i('VideoPageController: changed to ${resolvedEpisode.displayTitle}');
    final urlItem = normalizeEpisodeUrl(
      currentPlugin.baseUrl,
      resolvedEpisode.pageUrl,
    );

    await _resolveWithVideoSourceService(
      urlItem,
      offset,
      prepared: prepared,
      resolvedEpisode: resolvedEpisode,
      session: session,
      playerController: playerController,
    );
  }

  /// Applies the room owner's current file. Same-series changes reuse the
  /// existing episode pipeline; a different series opens a new video route so
  /// all source resolution and player initialization remain centralized.
  Future<void> syncToSyncPlayFile(
    String fileName, {
    required PlayerController playerController,
  }) async {
    final session = _remoteFileSessions.begin();
    final connection = playerController.syncplay.session.client;
    bool current() =>
        !_disposed &&
        session.isActive &&
        connection != null &&
        identical(connection, playerController.syncplay.session.client) &&
        playerController.syncplay.isGuest &&
        playerController.syncplay.session.currentFileName == fileName;
    if (!current()) return;
    final match = RegExp(r'^(\d+)\[(\d+)\](?:\|(.*))?$').firstMatch(fileName);
    if (match == null) return;
    final id = int.tryParse(match.group(1) ?? '') ?? 0;
    final episode = int.tryParse(match.group(2) ?? '') ?? 0;
    if (id <= 0 || episode <= 0) return;

    final payload = (match.group(3) ?? '').trim();
    final separator = payload.indexOf('|');
    final encodedSource = separator < 0 ? '' : payload.substring(0, separator);
    final encodedTitle =
        separator < 0 ? payload : payload.substring(separator + 1);
    final String source;
    final String title;
    try {
      source = Uri.decodeComponent(encodedSource);
      title = Uri.decodeComponent(encodedTitle);
    } on FormatException {
      return;
    }

    if (source.isEmpty || source.toLowerCase() == 'aniworld') {
      KazumiDialog.showToast(message: '房主使用的源不可用，请房主选择 AGE、DM84 或 enlie');
      return;
    }

    if (id == bangumiItem.id &&
        (source.isEmpty ||
            source.toLowerCase() == activePluginName.toLowerCase())) {
      if (playingEpisode?.episode == episode &&
          !playerController.playback.loading &&
          playerController.playback.mediaPlayer != null) {
        return;
      }
      await changeEpisode(
        episode,
        currentRoad: 0,
        fromSyncPlay: true,
        playerController: playerController,
      );
      return;
    }

    // A room is source-authoritative. If the host uses another source, reload
    // this controller's episode list from that source before changing episode.
    if (id == bangumiItem.id &&
        source.isNotEmpty &&
        source.toLowerCase() != activePluginName.toLowerCase()) {
      final plugin = pluginsController.pluginList.cast<Plugin?>().firstWhere(
          (item) => item?.name.toLowerCase() == source.toLowerCase(),
          orElse: () => null);
      if (plugin == null) {
        KazumiDialog.showToast(message: '找不到房主使用的播放源：$source');
        return;
      }
      currentPlugin = plugin;
      src = plugin.baseUrl;
      beginQueryRoads(plugin.baseUrl, plugin.name);
      try {
        await waitForPendingRoadQuery();
        if (!current()) return;
      } catch (error) {
        if (!current()) return;
        KazumiDialog.showToast(message: '无法加载房主使用的播放源：$error');
        return;
      }
      if (roadList.isEmpty) {
        KazumiDialog.showToast(message: '房主使用的播放源暂无可播放剧集');
        return;
      }
      if (!current()) return;
      await changeEpisode(episode,
          currentRoad: 0,
          fromSyncPlay: true,
          playerController: playerController);
      return;
    }
    BangumiItem? target;
    if (title.isNotEmpty) {
      try {
        final candidates = await AniWorldApi.searchOi(title);
        if (!current()) return;
        for (final candidate in candidates) {
          if (candidate.id == id) {
            target = candidate;
            break;
          }
        }
        final exact = candidates
            .where((item) =>
                (item.nameCn.isNotEmpty ? item.nameCn : item.name).trim() ==
                title)
            .toList();
        if (target == null && exact.length == 1) target = exact.single;
      } catch (error) {
        KazumiLogger()
            .w('SyncPlay: failed to resolve host title', error: error);
      }
    }
    if (target == null) {
      if (!current()) return;
      KazumiDialog.showToast(message: '无法解析房主正在播放的动漫');
      return;
    }

    if (!current()) return;
    final next = VideoPageController();
    next.bangumiItem = target;
    next.title = target.nameCn.isNotEmpty ? target.nameCn : target.name;
    next.src = source;
    final plugin = pluginsController.pluginList.cast<Plugin?>().firstWhere(
        (item) => item?.name.toLowerCase() == source.toLowerCase(),
        orElse: () => null);
    if (plugin == null) {
      KazumiDialog.showToast(message: '找不到房主使用的播放源：$source');
      return;
    }
    next.currentPlugin = plugin;
    next.syncPlayInitialEpisode = episode;
    next.syncPlayInitialFileName = fileName;
    next.resetEpisodeState(episode: episode, road: 0);
    next.beginQueryRoads(next.currentPlugin.baseUrl, source);
    _playbackSessions.cancel();
    playerController.playback.cancelSession();
    playerController.syncplay.detach();
    await Modular.to.pushReplacementNamed('/video/', arguments: next);
  }

  Future<void> _changeOfflineEpisode(
    VideoEpisodeSelection selection,
    int offset, {
    required _AsyncSession session,
    required PlayerController playerController,
  }) async {
    final resolvedEpisode =
        _resolveOfflineEpisode(selection.episode, road: selection.road);
    if (resolvedEpisode == null) {
      loading = false;
      KazumiLogger().e(
          'VideoPageController: failed to resolve offline episode. road=${selection.road}, episode=${selection.episode}');
      KazumiDialog.showToast(message: '集数解析失败');
      return;
    }

    final localPath = _getLocalVideoPath(
      bangumiItem.id,
      _offlinePluginName,
      resolvedEpisode.historyEpisodeNumber,
    );
    if (localPath == null) {
      loading = false;
      KazumiDialog.showToast(message: '该集数未下载');
      return;
    }
    selectedEpisode = VideoEpisodeSelection(
      episode: resolvedEpisode.listIndex,
      road: resolvedEpisode.roadIndex,
    );
    commentsEpisode = commentEpisodeForSelection(selectedEpisode);
    _setOfflineHistoryIdentity(resolvedEpisode);
    if (session.isStale) {
      return;
    }
    loading = false;
    final resolvedOffset = offset > 0
        ? offset
        : _recoveryOffset ?? getHistoryOffsetFor(_playbackHistoryIdentity!);

    KazumiLogger().i(
        'VideoPageController: offline episode changed to ${resolvedEpisode.historyEpisodeNumber} (index: ${selection.episode}), path: $localPath');

    final params = PlaybackInitParams(
      videoUrl: localPath,
      startup: session.startup,
      offset: resolvedOffset,
      isLocalPlayback: true,
      bangumiId: bangumiItem.id,
      pluginName: _offlinePluginName,
      episode: resolvedEpisode.listIndex,
      danmakuEpisodeNumber: resolvedEpisode.danmakuEpisodeNumber,
      pageUrl: resolvedEpisode.pageUrl,
      sortNumber: resolvedEpisode.sortNumber,
      httpHeaders: {},
      adBlockerEnabled: false,
      episodeTitle: resolvedEpisode.displayTitle,
      referer: '',
      currentRoad: resolvedEpisode.roadIndex,
      coverUrl: bangumiItem.images['large'],
      bangumiName:
          bangumiItem.nameCn.isNotEmpty ? bangumiItem.nameCn : bangumiItem.name,
      androidVideoRenderer: null,
      hardwareDecoder: null,
      hardwareAccelerationEnabled: null,
    );

    final initialized =
        await playerController.init(params, isActive: () => session.isActive);
    if (session.isActive && initialized) {
      playingEpisode = selection;
      unawaited(_loadPlaybackDanmaku(playerController, params, session));
    } else if (session.isActive) {
      _playbackSessions.cancel();
    }
  }

  int _danmakuEpisodeForPlayback(PlaybackInitParams params) {
    return params.danmakuEpisodeNumber;
  }

  Future<void> _loadPlaybackDanmaku(
    PlayerController playerController,
    PlaybackInitParams params,
    _AsyncSession session,
  ) async {
    final danmakuSession = _danmakuSessions.begin();
    playerController.danmaku.beginDanmakuLoad();
    try {
      final result = await playerController.danmaku.fetchDanmaku(
        params.bangumiId,
        params.bangumiName ?? '',
        params.pluginName,
        _danmakuEpisodeForPlayback(params),
      );
      if (session.isActive && danmakuSession.isActive) {
        if (result.hasDanmakus) {
          final bool enableDanmaku =
              GStorage.getSetting(SettingsKeys.danmakuEnabledByDefault);
          playerController.danmaku.applyDanmakuLoad(
            result,
            enableDanmaku: enableDanmaku,
          );
        } else {
          playerController.danmaku.applyUnavailableDanmakuLoad(result);
          if (result.isFailed) {
            KazumiDialog.showToast(message: '弹幕加载失败，可手动检索');
          }
        }
      }
    } catch (e) {
      if (session.isActive && danmakuSession.isActive) {
        playerController.danmaku.finishDanmakuLoad(disableDanmaku: true);
        KazumiDialog.showToast(message: '弹幕加载失败，可手动检索');
      }
      KazumiLogger().w('VideoPageController: failed to load danmaku', error: e);
    }
  }

  void cancelAutomaticDanmakuLoad() {
    _danmakuSessions.cancel();
  }

  String? _getLocalVideoPath(
      int bangumiId, String pluginName, int episodeNumber) {
    final episode =
        downloadRepository.getEpisode(bangumiId, pluginName, episodeNumber);
    return downloadManager.getLocalVideoPath(episode);
  }

  Future<void> _resolveWithVideoSourceService(
    String url,
    int offset, {
    required EpisodeRef resolvedEpisode,
    required Future<void> prepared,
    required _AsyncSession session,
    required PlayerController playerController,
  }) async {
    _videoSourceService ??= WebViewVideoSourceService();

    await _logSubscription?.cancel();
    _logSubscription = _videoSourceService!.onLog.listen((log) {
      if (!_logStreamController.isClosed) {
        _logStreamController.add(log);
      }
    });

    try {
      final source = await _videoSourceService!.resolve(
        url,
        useLegacyParser: currentPlugin.useLegacyParser,
        offset: offset,
      );
      session.startup.mark('resolveMs');

      if (session.isStale) {
        return;
      }
      loading = false;
      KazumiLogger()
          .i('VideoPageController: resolved video URL: ${source.url}');

      final bool forceAdBlocker =
          GStorage.getSetting(SettingsKeys.forceAdBlocker);

      final params = PlaybackInitParams(
        videoUrl: AccessGateService.addMediaToken(source.url),
        startup: session.startup,
        offset: source.offset,
        isLocalPlayback: false,
        bangumiId: bangumiItem.id,
        pluginName: currentPlugin.name,
        episode: resolvedEpisode.listIndex,
        danmakuEpisodeNumber: resolvedEpisode.danmakuEpisodeNumber,
        pageUrl: resolvedEpisode.pageUrl,
        sortNumber: resolvedEpisode.sortNumber,
        videoSourceFormat: source.format,
        httpHeaders: {
          'user-agent': currentPlugin.userAgent.isEmpty
              ? getRandomUA()
              : currentPlugin.userAgent,
          if (currentPlugin.referer.isNotEmpty)
            'referer': currentPlugin.referer,
        },
        adBlockerEnabled: forceAdBlocker || currentPlugin.adBlocker,
        episodeTitle: resolvedEpisode.displayTitle,
        referer: currentPlugin.referer,
        currentRoad: resolvedEpisode.roadIndex,
        coverUrl: bangumiItem.images['large'],
        bangumiName: bangumiItem.nameCn.isNotEmpty
            ? bangumiItem.nameCn
            : bangumiItem.name,
        androidVideoRenderer: null,
        hardwareDecoder: null,
        hardwareAccelerationEnabled: null,
      );

      await prepared.timeout(const Duration(seconds: 20));
      if (session.isStale) return;
      final initialized =
          await playerController.init(params, isActive: () => session.isActive);
      if (session.isActive && initialized) {
        playingEpisode = VideoEpisodeSelection(
          episode: resolvedEpisode.listIndex,
          road: resolvedEpisode.roadIndex,
        );
        unawaited(_loadPlaybackDanmaku(playerController, params, session));
      } else if (session.isActive) {
        errorMessage = '播放未能开始，请重试或切换其他来源';
        _playbackSessions.cancel();
      }
    } on VideoSourceTimeoutException {
      if (session.isStale) {
        return;
      }
      loading = false;
      errorMessage = '视频解析超时，请重试';
    } on VideoSourceCancelledException {
      KazumiLogger().i('VideoPageController: video URL resolution cancelled');
    } catch (e) {
      if (session.isStale) {
        return;
      }
      loading = false;
      errorMessage = '视频解析失败：${e.toString()}';
    }
  }

  Future<void> _resolveWithAniWorldOi(
    EpisodeRef resolvedEpisode,
    int offset, {
    required Future<void> prepared,
    required _AsyncSession session,
    required PlayerController playerController,
  }) async {
    try {
      final source = await AniWorldApi.resolveVideoSource(
          resolvedEpisode.pageUrl,
          cancelToken: _aniWorldResolutionCancel);
      session.startup.mark('resolveMs');
      // 直连模式：直接使用上游返回的播放地址。源可能是 HLS，也可能是
      // 实际返回 video/mp4 的直连文件；格式必须沿用解析结果，不能统一强制 HLS。
      final videoUrl = source.directUrl;
      if (session.isStale) return;

      // OIAPI labels this source family as H265/HEVC. Try hardware first;
      // software decoding remains the fallback for devices whose MediaCodec
      // cannot open these `hev1` files.
      _playbackHistoryIdentity = PlaybackHistoryIdentity.online(
        bangumiItem: bangumiItem,
        pluginName: 'AniWorld',
        episodeNumber: resolvedEpisode.historyEpisodeNumber,
        episodeTitle: resolvedEpisode.displayTitle,
        road: resolvedEpisode.originalRoadIndex,
        onlineBangumiSrc: src,
        episodePageUrl: resolvedEpisode.pageUrl,
      );
      final resolvedOffset = offset > 0
          ? offset
          : _recoveryOffset ?? getHistoryOffsetFor(_playbackHistoryIdentity!);

      loading = false;
      PlaybackInitParams buildParams() {
        return PlaybackInitParams(
          videoUrl: videoUrl,
          startup: session.startup,
          offset: resolvedOffset,
          isLocalPlayback: false,
          // 直连文件（包括扩展名异常但 MIME 为 video/mp4 的地址）交给 FFmpeg
          // 自动探测；只有真正的 m3u8/HLS 源才强制使用 HLS demuxer。
          videoSourceFormat: source.isDirectFile
              ? VideoSourceFormat.auto
              : VideoSourceFormat.hls,
          bangumiId: bangumiItem.id,
          pluginName: 'AniWorld',
          episode: resolvedEpisode.listIndex,
          danmakuEpisodeNumber: resolvedEpisode.danmakuEpisodeNumber,
          pageUrl: resolvedEpisode.pageUrl,
          sortNumber: resolvedEpisode.sortNumber,
          // 注意：不向 libmpv 下发自定义 httpHeaders。
          // 旧版 libmpv 在含换行的多 header 下可能生成畸形请求；
          // 这里保持空 header，让直连源按默认请求打开。
          httpHeaders: const {},
          adBlockerEnabled: false,
          episodeTitle: resolvedEpisode.displayTitle,
          referer: '',
          currentRoad: resolvedEpisode.roadIndex,
          coverUrl: bangumiItem.images['large'],
          bangumiName: bangumiItem.nameCn.isNotEmpty
              ? bangumiItem.nameCn
              : bangumiItem.name,
          androidVideoRenderer: null,
          // Engine fallback is owned centrally by PlayerController, with one budget.
          hardwareDecoder: null,
          hardwareAccelerationEnabled: null,
        );
      }

      final params = buildParams();
      await prepared.timeout(const Duration(seconds: 20));
      if (session.isStale) return;
      final initialized =
          await playerController.init(params, isActive: () => session.isActive);
      if (session.isStale) return;
      if (session.isActive && initialized) {
        playingEpisode = VideoEpisodeSelection(
          episode: resolvedEpisode.listIndex,
          road: resolvedEpisode.roadIndex,
        );
        unawaited(_loadPlaybackDanmaku(playerController, params, session));
      } else if (session.isActive) {
        loading = false;
        errorMessage = '播放未能开始，请重试或切换其他来源';
        _playbackSessions.cancel();
      }
    } catch (e) {
      if (session.isStale) return;
      loading = false;
      errorMessage = '视频地址获取失败：${e.toString()}';
    }
  }

  void cancelVideoSourceResolution() {
    cancelQueryRoads();
    _disposed = true;
    _remoteFileSessions.cancel();
    _aniWorldResolutionCancel?.cancel('Playback route disposed');
    _aniWorldResolutionCancel = null;
    _playbackSessions.cancel();
    _danmakuSessions.cancel();
    _logSubscription?.cancel();
    _logSubscription = null;
    if (!_logStreamController.isClosed) {
      _logStreamController.close();
    }
    final videoSourceService = _videoSourceService;
    _videoSourceService = null;
    if (videoSourceService != null) {
      unawaited(videoSourceService.dispose());
    }
  }

  Future<bool> _recoverPlayback(
      PlayerController controller,
      Player player,
      VideoEpisodeSelection selection,
      _AsyncSession session,
      String reason) async {
    if (session.isStale ||
        !controller.playback.isCurrentPlayer(player) ||
        controller.syncplay.isGuest ||
        isOfflineMode) {
      return false;
    }
    if (_recoveryAttempts >= 2) {
      errorMessage = '播放源暂时无法恢复，请手动重试或切换其他来源';
      return false;
    }
    _recoveryAttempts++;
    final token = Object();
    _recoveryToken = token;
    final position = controller.playback.playerPosition;
    final speed = controller.playback.playerSpeed;
    KazumiLogger().w(
        'Playback: refresh same episode ($_recoveryAttempts/2), reason=$reason');
    await changeEpisode(selection.episode,
        currentRoad: selection.road,
        offset: position.inSeconds,
        recovering: true,
        playerController: controller);
    if (!identical(_recoveryToken, token)) return false;
    final recoveredPlayer = controller.playback.mediaPlayer;
    if (playingEpisode?.episode != selection.episode ||
        playingEpisode?.road != selection.road ||
        recoveredPlayer == null) {
      return false;
    }
    await controller.setPlaybackSpeed(speed);
    if (!identical(_recoveryToken, token) ||
        !controller.playback.isCurrentPlayer(recoveredPlayer)) {
      return false;
    }
    if (controller.playback.requestedPlay == false) {
      await controller.pause(enableSync: false);
    }
    return true;
  }

  void resetEpisodeComments() {
    _commentSessions.cancel();
    episodeInfo.reset();
    episodeCommentsList.clear();
  }

  Future<bool> queryBangumiEpisodeCommentsByID(int id, int episode) async {
    final session = _commentSessions.begin();
    final EpisodeInfo latestEpisodeInfo;
    try {
      latestEpisodeInfo = await BangumiApi.getBangumiEpisodeByID(id, episode);
    } catch (_) {
      if (session.isStale) {
        return false;
      }
      rethrow;
    }
    if (session.isStale) {
      return false;
    }
    final EpisodeCommentResponse value;
    try {
      value =
          await BangumiApi.getBangumiCommentsByEpisodeID(latestEpisodeInfo.id);
    } catch (_) {
      if (session.isStale) {
        return false;
      }
      rethrow;
    }
    if (session.isStale) {
      return false;
    }
    commentsEpisode = episode;
    episodeInfo = latestEpisodeInfo;
    final commentsList = value.commentList;
    if (!isCommentsAscending) {
      commentsList
          .sort((a, b) => b.comment.createdAt.compareTo(a.comment.createdAt));
    } else {
      commentsList
          .sort((a, b) => a.comment.createdAt.compareTo(b.comment.createdAt));
    }
    episodeCommentsList = ObservableList.of(commentsList);
    KazumiLogger().i(
        'VideoPageController: loaded comments list length ${episodeCommentsList.length}');
    return true;
  }

  Future<void> queryRoads(String url, String pluginName,
      {CancelToken? cancelToken}) async {
    final generation = ++_roadQueryGeneration;
    if (cancelToken != null) {
      _queryRoadsCancelToken?.cancel();
      _queryRoadsCancelToken = cancelToken;
    } else {
      _queryRoadsCancelToken?.cancel();
      _queryRoadsCancelToken = CancelToken();
      cancelToken = _queryRoadsCancelToken;
    }

    roadList.clear();
    if (pluginName.toLowerCase() == 'aniworld' || url == 'AniWorld') {
      throw StateError('公开版已移除内置播放源，请返回详情页重新选源');
    }
    final PluginsController pluginsController =
        Modular.get<PluginsController>();
    for (Plugin plugin in pluginsController.pluginList) {
      if (plugin.name == pluginName) {
        var detailUrl = url;
        if (url == plugin.baseUrl) {
          final search = await plugin.queryBangumi(title, shouldRethrow: true);
          if (generation != _roadQueryGeneration) return;
          final exact = search.data
              .where((item) => item.name.trim() == title.trim())
              .toList();
          if (exact.length != 1) throw StateError('无法唯一匹配房主作品，请在详情页重新选源');
          detailUrl = exact.single.src;
          src = detailUrl;
        }
        final roads =
            await plugin.querychapterRoads(detailUrl, cancelToken: cancelToken);
        if (generation != _roadQueryGeneration) return;
        _normalizeDm84RoadOrder(plugin.name, roads);
        roadList.addAll(roads);
      }
    }
    KazumiLogger()
        .i('VideoPageController: road list length ${roadList.length}');
    if (roadList.isNotEmpty) {
      KazumiLogger().i(
          'VideoPageController: first road episode count ${roadList[0].data.length}');
    }
  }

  /// DM84 currently renders its chapter anchors newest-first.  Keep the
  /// source URL and display title paired while exposing the same first-to-last
  /// order as AniWorld and the rest of the player UI.  The direction check
  /// makes this resilient if DM84 changes its page order later.
  void _normalizeDm84RoadOrder(String pluginName, List<Road> roads) {
    if (pluginName.trim().toLowerCase() != 'dm84') return;

    for (final road in roads) {
      final length = road.data.length < road.identifier.length
          ? road.data.length
          : road.identifier.length;
      if (length < 2) continue;

      final entries = List.generate(
        length,
        (index) => (
          url: road.data[index],
          title: road.identifier[index],
          number: extractEpisodeNumber(road.identifier[index]),
        ),
      );
      final numbers = entries.map((entry) => entry.number).toList();
      final numericCount = numbers.where((number) => number > 0).length;
      if (numericCount < 2) continue;

      final first = numbers.firstWhere((number) => number > 0);
      final last = numbers.lastWhere((number) => number > 0);
      if (first <= last) continue;

      entries.sort((a, b) {
        if (a.number == b.number) return 0;
        if (a.number == 0) return 1;
        if (b.number == 0) return -1;
        return a.number.compareTo(b.number);
      });
      road.data = entries.map((entry) => entry.url).toList();
      road.identifier = entries.map((entry) => entry.title).toList();
    }
  }

  void beginQueryRoads(String url, String pluginName) {
    loading = true;
    errorMessage = null;
    _pendingRoadQueryError = null;
    _pendingRoadQuery = queryRoads(url, pluginName).catchError(
      (Object error) {
        _pendingRoadQueryError = error;
      },
    );
  }

  Future<void> waitForPendingRoadQuery() async {
    final query = _pendingRoadQuery;
    _pendingRoadQuery = null;
    if (query != null) await query;
    final error = _pendingRoadQueryError;
    _pendingRoadQueryError = null;
    if (error != null) throw error;
  }

  void toggleSortOrder() {
    isCommentsAscending = !isCommentsAscending;
    episodeCommentsList.sort(
      (a, b) => isCommentsAscending
          ? a.comment.createdAt.compareTo(b.comment.createdAt)
          : b.comment.createdAt.compareTo(a.comment.createdAt),
    );
  }

  void cancelQueryRoads() {
    _roadQueryGeneration++;
    if (_queryRoadsCancelToken != null) {
      if (!_queryRoadsCancelToken!.isCancelled) {
        _queryRoadsCancelToken!.cancel();
      }
    }
    _pendingRoadQuery = null;
    _pendingRoadQueryError = null;
  }

  void enterFullScreen({bool lockOrientation = false}) {
    _explicitLandscapeFullscreen = lockOrientation;
    _suppressLandscapeAutoEnter = false;
    isFullscreen = true;
    unawaited(
      DisplayModeService.enterFullScreen(lockOrientation: lockOrientation),
    );
  }

  void exitFullScreen({bool lockOrientation = true}) {
    _explicitLandscapeFullscreen = false;
    _suppressLandscapeAutoEnter = lockOrientation;
    isFullscreen = false;
    unawaited(
      DisplayModeService.exitFullScreen(lockOrientation: lockOrientation),
    );
  }

  void isDesktopFullscreen() async {
    if (isDesktop()) {
      _explicitLandscapeFullscreen = false;
      _suppressLandscapeAutoEnter = false;
      isFullscreen = await windowManager.isFullScreen();
    }
  }

  void handleOnEnterFullScreen() async {
    _explicitLandscapeFullscreen = false;
    _suppressLandscapeAutoEnter = false;
    isFullscreen = true;
  }

  void handleOnExitFullScreen() async {
    _explicitLandscapeFullscreen = false;
    _suppressLandscapeAutoEnter = false;
    isFullscreen = false;
  }
}

class OfflineRoadListSnapshot {
  const OfflineRoadListSnapshot({
    required this.roads,
    required this.episodesByNumber,
    required this.displayRoadToOriginalRoad,
    required this.originalRoadToDisplayRoad,
  });

  final List<Road> roads;
  final Map<int, DownloadEpisode> episodesByNumber;
  final Map<int, int> displayRoadToOriginalRoad;
  final Map<int, int> originalRoadToDisplayRoad;
}

OfflineRoadListSnapshot buildOfflineRoadListSnapshot(
  List<DownloadEpisode> episodes,
) {
  final groupedEpisodes = <int, List<DownloadEpisode>>{};
  final episodesByNumber = <int, DownloadEpisode>{};

  for (final episode in episodes) {
    episodesByNumber[episode.episodeNumber] = episode;
    groupedEpisodes.putIfAbsent(episode.road, () => []).add(episode);
  }

  final originalRoads = groupedEpisodes.keys.toList()..sort();
  final roads = <Road>[];
  final displayRoadToOriginalRoad = <int, int>{};
  final originalRoadToDisplayRoad = <int, int>{};

  for (final originalRoad in originalRoads) {
    final roadEpisodes = groupedEpisodes[originalRoad]!
      ..sort((a, b) => a.episodeNumber.compareTo(b.episodeNumber));
    final displayRoad = roads.length;
    displayRoadToOriginalRoad[displayRoad] = originalRoad;
    originalRoadToDisplayRoad[originalRoad] = displayRoad;
    roads.add(Road(
      name: originalRoad >= 0
          ? '播放列表${originalRoad + 1}'
          : '播放列表${displayRoad + 1}',
      data: roadEpisodes.map((e) => e.episodeNumber.toString()).toList(),
      identifier: roadEpisodes
          .map((e) =>
              e.episodeName.isNotEmpty ? e.episodeName : '第${e.episodeNumber}集')
          .toList(),
    ));
  }

  return OfflineRoadListSnapshot(
    roads: roads,
    episodesByNumber: episodesByNumber,
    displayRoadToOriginalRoad: displayRoadToOriginalRoad,
    originalRoadToDisplayRoad: originalRoadToDisplayRoad,
  );
}

class EpisodeRef {
  const EpisodeRef({
    required this.listIndex,
    required this.roadIndex,
    required this.displayTitle,
    required this.pageUrl,
    required this.sortNumber,
    required this.historyEpisodeNumber,
    required this.danmakuEpisodeNumber,
    required this.originalRoadIndex,
  });

  final int listIndex;
  final int roadIndex;
  final String displayTitle;
  final String pageUrl;

  /// 集数排序号。
  /// - 在线：从 [displayTitle] 解析（[extractEpisodeNumber]），无法解析时为 null。
  /// - 离线：恒等于下载数据的 episodeNumber。
  final int? sortNumber;
  final int historyEpisodeNumber;
  final int danmakuEpisodeNumber;
  final int originalRoadIndex;

  factory EpisodeRef.online({
    required int listIndex,
    required int roadIndex,
    required String displayTitle,
    required String pageUrl,
  }) {
    final parsedEpisodeNumber = extractEpisodeNumber(displayTitle);
    return EpisodeRef(
      listIndex: listIndex,
      roadIndex: roadIndex,
      displayTitle: displayTitle,
      pageUrl: pageUrl,
      sortNumber: parsedEpisodeNumber > 0 ? parsedEpisodeNumber : null,
      historyEpisodeNumber: listIndex,
      danmakuEpisodeNumber:
          parsedEpisodeNumber > 0 ? parsedEpisodeNumber : listIndex,
      originalRoadIndex: roadIndex,
    );
  }

  const factory EpisodeRef.offline({
    required int listIndex,
    required int roadIndex,
    required String displayTitle,
    required String pageUrl,
    required int episodeNumber,
    required int originalRoadIndex,
  }) = _OfflineEpisodeRef;
}

class _OfflineEpisodeRef extends EpisodeRef {
  const _OfflineEpisodeRef({
    required super.listIndex,
    required super.roadIndex,
    required super.displayTitle,
    required super.pageUrl,
    required int episodeNumber,
    required super.originalRoadIndex,
  }) : super(
          sortNumber: episodeNumber,
          historyEpisodeNumber: episodeNumber,
          danmakuEpisodeNumber: episodeNumber,
        );
}
