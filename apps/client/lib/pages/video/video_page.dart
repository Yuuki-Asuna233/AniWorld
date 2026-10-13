import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:canvas_danmaku/models/danmaku_content_item.dart';
import 'package:flutter/material.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/bean/card/bangumi_card.dart';
import 'package:kazumi/pages/player/player_controller.dart';
import 'package:kazumi/pages/video/video_controller.dart';
import 'package:kazumi/pages/history/history_controller.dart';
import 'package:kazumi/services/logging/logger.dart';
import 'package:kazumi/pages/player/player_item.dart';
import 'package:flutter_mobx/flutter_mobx.dart';
import 'package:kazumi/services/storage/storage.dart';
import 'package:kazumi/services/player/pip_utils.dart';
import 'package:kazumi/bean/appbar/drag_to_move_bar.dart' as dtb;
import 'package:kazumi/bean/dialog/dialog_helper.dart';
import 'package:screen_brightness_platform_interface/screen_brightness_platform_interface.dart';
import 'package:scrollview_observer/scrollview_observer.dart';
import 'package:kazumi/pages/player/episode_comments_sheet.dart';
import 'package:window_manager/window_manager.dart';
import 'package:kazumi/bean/widget/embedded_native_control_area.dart';
import 'package:kazumi/pages/download/download_controller.dart';
import 'package:kazumi/pages/download/download_episode_sheet.dart';
import 'package:kazumi/modules/download/download_module.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';
import 'package:kazumi/request/apis/bangumi_api.dart';
import 'package:kazumi/services/player/timed_shutdown_service.dart';
import 'package:kazumi/utils/device.dart';
import 'package:kazumi/services/platform/display_mode_service.dart';
import 'package:kazumi/utils/root_back_navigation.dart';

class VideoPage extends StatefulWidget {
  const VideoPage({
    super.key,
    required this.videoPageController,
  });

  final VideoPageController videoPageController;

  @override
  State<VideoPage> createState() => _VideoPageState();
}

class _VideoPageState extends State<VideoPage>
    with TickerProviderStateMixin, WindowListener {
  late final VideoPageController videoPageController =
      widget.videoPageController;
  PlayerController? _playerController;
  final HistoryController historyController = Modular.get<HistoryController>();
  final DownloadController downloadController =
      Modular.get<DownloadController>();
  late bool playResume;
  bool showDebugLog = false;
  List<String> webviewLogLines = [];
  StreamSubscription<String>? _logSubscription;
  final FocusNode keyboardFocus = FocusNode();

  ScrollController scrollController = ScrollController();
  late GridObserverController observerController;
  late AnimationController animation;
  late Animation<Offset> _rightOffsetAnimation;
  late Animation<double> _maskOpacityAnimation;
  late TabController tabController;

  int visibleRoad = 0;
  bool _tabBodyTargetVisible = true;
  int _tabBodyAnimationRun = 0;
  bool _relatedSectionsLoading = false;
  bool _openingRelatedBangumi = false;
  bool _isClosing = false;
  late final bool Function() _backNavigationHandler =
      _handleBackFromRetainedRoute;
  List<BangumiItem> _seriesItems = [];
  List<BangumiItem> _hotRecommendItems = [];

  late final bool disableAnimations;

  StreamSubscription<SyncPlayChatMessage>? _syncChatSubscription;

  static const Duration _sideTabAnimationDuration = Duration(milliseconds: 120);

  @override
  void initState() {
    super.initState();
    VideoBackNavigation.register(_backNavigationHandler);
    windowManager.addListener(this);
    // Window fullscreen can be changed outside this page through system chrome.
    videoPageController.isDesktopFullscreen();
    tabController = TabController(length: 2, vsync: this);
    observerController = GridObserverController(controller: scrollController);
    animation = AnimationController(
      duration: _sideTabAnimationDuration,
      vsync: this,
    );
    _rightOffsetAnimation = Tween<Offset>(
      begin: const Offset(1.0, 0.0),
      end: const Offset(0.0, 0.0),
    ).animate(CurvedAnimation(
      parent: animation,
      curve: Curves.easeOut,
    ));
    _maskOpacityAnimation = Tween<double>(
      begin: 0.0,
      end: 1.0,
    ).animate(CurvedAnimation(
      parent: animation,
      curve: Curves.easeIn,
    ));

    playResume = GStorage.getSetting(SettingsKeys.playResume);
    disableAnimations =
        GStorage.getSetting(SettingsKeys.playerDisableAnimations);

    // Each playback route owns its player. A singleton here lets a newly
    // opened recommendation overwrite the still-mounted previous video page.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _loadPlayerController();
    });
  }

  void _loadPlayerController() {
    if (!mounted) {
      return;
    }

    try {
      _playerController = PlayerController();
    } catch (e) {
      KazumiLogger().e(
        'VideoPage: failed to load PlayerController',
        error: e,
      );
      if (mounted) {
        videoPageController.loading = false;
        videoPageController.errorMessage = '播放器初始化失败，请返回重试';
      }
      return;
    }

    if (!mounted) {
      return;
    }

    setState(() {});
    final playerController = _playerController!;

    if (videoPageController.isOfflineMode) {
      _initOfflineMode(playerController);
    } else {
      unawaited(_initOnlineMode(playerController));
    }
    unawaited(_loadRelatedSections());

    _syncChatSubscription =
        playerController.syncplay.chatStream.listen((event) {
      final localUsername =
          playerController.syncplay.syncplayController?.username ?? '';
      final String displayText = '${event.username}：${event.message}';

      if (playerController.danmaku.danmakuOn &&
          event.username != localUsername &&
          event.fromRemote) {
        playerController.danmaku.canvasController.addDanmaku(
          DanmakuContentItem(
            displayText,
            color: Colors.orange,
            isColorful: true,
            type: DanmakuItemType.bottom,
            extra: DateTime.now().millisecondsSinceEpoch,
          ),
        );
      }
    });
  }

  Future<void> _loadRelatedSections() async {
    if (_relatedSectionsLoading) {
      return;
    }
    _relatedSectionsLoading = true;
    try {
      final current = videoPageController.bangumiItem;
      final results = await Future.wait([
        AniWorldApi.getOiFranchise(current),
        BangumiApi.getAniWorldSection(type: 'newseason', limit: 18),
      ]);
      if (!mounted) {
        return;
      }
      final series = _dedupeSeriesItems(
        _sortSeriesItems(
          _uniqueBangumiItems([
            current,
            ...results[0],
          ]),
        ),
        current,
      );
      final hot = _uniqueBangumiItems(results[1])
          .where((item) => !_isSameBangumiTitle(item, current))
          .toList();
      setState(() {
        _seriesItems = series;
        _hotRecommendItems = hot;
      });
    } catch (e) {
      KazumiLogger().w('VideoPage: failed to load related sections', error: e);
    } finally {
      _relatedSectionsLoading = false;
    }
  }

  List<BangumiItem> _uniqueBangumiItems(List<BangumiItem> items) {
    final seen = <String>{};
    final unique = <BangumiItem>[];
    for (final item in items) {
      final titleKey = _normalizedBangumiTitle(item);
      final key = titleKey.isNotEmpty ? 'title:$titleKey' : 'id:${item.id}';
      if (seen.add(key)) {
        unique.add(item);
      }
    }
    return unique;
  }

  List<BangumiItem> _dedupeSeriesItems(
    List<BangumiItem> items,
    BangumiItem current,
  ) {
    final result = <BangumiItem>[];
    final seenTitle = <String>{};
    final seenImage = <String>{};
    var currentAdded = false;
    for (final item in items) {
      final isCurrent = _isSameBangumiTitle(item, current);
      if (isCurrent) {
        if (currentAdded) continue;
        currentAdded = true;
      }
      final titleKey = _normalizedBangumiTitle(item);
      final imageKey = (item.images['large'] ?? item.images['grid'] ?? '')
          .trim()
          .toLowerCase();
      if (titleKey.isNotEmpty && !seenTitle.add(titleKey)) continue;
      if (imageKey.isNotEmpty && !seenImage.add(imageKey)) continue;
      result.add(isCurrent ? current : item);
    }
    return result;
  }

  String _normalizedBangumiTitle(BangumiItem item) {
    return (item.nameCn.isNotEmpty ? item.nameCn : item.name)
        .replaceAll(RegExp(r'\s+'), '')
        .replaceAll('：', ':')
        .replaceAll('（', '(')
        .replaceAll('）', ')')
        .replaceAll('【', '[')
        .replaceAll('】', ']')
        .toLowerCase();
  }

  List<BangumiItem> _sortSeriesItems(List<BangumiItem> items) {
    int valueOf(BangumiItem item) {
      final date = DateTime.tryParse(item.airDate);
      if (date != null) {
        return date.millisecondsSinceEpoch;
      }
      final year = RegExp(r'(19|20)\d{2}').firstMatch(item.airDate);
      if (year != null) {
        return int.parse(year.group(0)!) * 10000;
      }
      return 90000000 + _seasonOrder(item);
    }

    items.sort((a, b) {
      final byDate = valueOf(a).compareTo(valueOf(b));
      if (byDate != 0) return byDate;
      return a.id.compareTo(b.id);
    });
    return items;
  }

  int _seasonOrder(BangumiItem item) {
    final title = item.nameCn.isNotEmpty ? item.nameCn : item.name;
    const zh = {
      '一': 1,
      '二': 2,
      '三': 3,
      '四': 4,
      '五': 5,
      '六': 6,
      '七': 7,
      '八': 8,
      '九': 9,
      '十': 10,
    };
    final match = RegExp(r'第?([一二三四五六七八九十0-9]+)[季期部]').firstMatch(title);
    if (match == null) return 1;
    final raw = match.group(1) ?? '';
    return int.tryParse(raw) ?? zh[raw] ?? 1;
  }

  bool _isSameBangumiTitle(BangumiItem a, BangumiItem b) {
    return a.id == b.id ||
        _normalizedBangumiTitle(a) == _normalizedBangumiTitle(b);
  }

  String _episodeCountLabel(int total) {
    if (total <= 0) return '集全';
    try {
      final data = jsonDecode(videoPageController.bangumiItem.info);
      final status =
          '${data['aniStatus'] ?? data['status'] ?? ''}'.trim().toUpperCase();
      final nextEpisode = '${data['nextAiringEpisode'] ?? ''}'.trim();
      final nextAt = int.tryParse('${data['nextAiringAt'] ?? 0}') ?? 0;
      if (status == 'FINISHED') return '$total集全';
      if (status == 'RELEASING' || nextEpisode.isNotEmpty || nextAt > 0) {
        return '连载中 · 共$total集 >';
      }
    } catch (_) {}
    return '$total集 >';
  }

  void _initOfflineMode(PlayerController playerController) {
    _showTabBodyImmediately(locateEpisode: false);
    final forceHistoryResume =
        videoPageController.consumeHistoryResumeRequest();
    final identity = videoPageController.currentHistoryIdentity;
    videoPageController.historyOffset = identity == null
        ? 0
        : videoPageController.getHistoryOffsetFor(
            identity,
            force: forceHistoryResume,
          );
    visibleRoad = videoPageController.selectedEpisode.road;

    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) {
        return;
      }

      await changeEpisode(
        videoPageController.selectedEpisode.episode,
        currentRoad: videoPageController.selectedEpisode.road,
        offset: videoPageController.historyOffset,
      );
    });
  }

  Future<void> _initOnlineMode(PlayerController playerController) async {
    final startRequest = videoPageController.consumePlaybackStartRequest();
    final openingRoomFile = videoPageController.syncPlayInitialFileName ??
        playerController.syncplay.session.currentFileName;
    final forceHistoryResume =
        videoPageController.consumeHistoryResumeRequest();
    try {
      await videoPageController.waitForPendingRoadQuery();
    } catch (e) {
      KazumiLogger().e('VideoPage: failed to load playlist', error: e);
      if (mounted) {
        videoPageController.loading = false;
        videoPageController.errorMessage = '播放列表加载失败，请返回重试';
      }
      return;
    }
    if (!mounted) return;
    if (videoPageController.roadList.isEmpty ||
        videoPageController.roadList.first.data.isEmpty) {
      videoPageController.loading = false;
      videoPageController.errorMessage = '暂时没有可播放剧集';
      return;
    }
    final syncPlayEpisode = videoPageController.syncPlayInitialEpisode;
    if (syncPlayEpisode != null && !playerController.syncplay.isGuest) {
      videoPageController.loading = false;
      videoPageController.errorMessage = '一起看会话已结束，请重新选择播放';
      return;
    }
    videoPageController.syncPlayInitialEpisode = null;
    videoPageController.resetEpisodeState(episode: syncPlayEpisode ?? 1);
    videoPageController.historyOffset = 0;
    if (syncPlayEpisode == null && startRequest?.episode != null) {
      final requested =
          videoPageController.findOnlineEpisodeByNumber(startRequest!.episode!);
      if (requested == null) {
        videoPageController.loading = false;
        videoPageController.errorMessage =
            '指定的第${startRequest.episode}集暂不可用，请选择其他剧集';
        return;
      }
      videoPageController.resetEpisodeState(
          episode: requested.episode, road: requested.road);
    }
    _showTabBodyImmediately(locateEpisode: false);

    final activePluginName = videoPageController.activePluginName;
    final shouldReadHistory = syncPlayEpisode == null &&
        (startRequest == null || startRequest.resume);
    var progress = shouldReadHistory
        ? historyController.lastWatching(
            videoPageController.bangumiItem,
            activePluginName,
          )
        : null;
    var historyApplied = false;
    if (progress != null) {
      var resumeEpisode = progress.episode;
      var resumeRoad = progress.road;

      // A source may have changed its chapter order since the history entry
      // was written. Prefer the persisted page URL when available, so an old
      // DM84 newest-first index still resumes the same actual episode after
      // the list is normalized to first-to-last.
      final historyEntry = historyController.getHistory(
        videoPageController.bangumiItem,
        activePluginName,
      );
      final mappedSelection = historyEntry == null
          ? null
          : videoPageController.findOnlineEpisodeByPageUrl(
              historyEntry.episodePageUrl,
              preferredRoad: progress.road,
            );
      if (mappedSelection != null) {
        resumeEpisode = mappedSelection.episode;
        resumeRoad = mappedSelection.road;
      }

      if (resumeRoad >= 0 &&
          resumeEpisode >= 1 &&
          videoPageController.roadList.length > resumeRoad) {
        if (videoPageController.roadList[resumeRoad].data.length >=
            resumeEpisode) {
          videoPageController.resetEpisodeState(
            episode: resumeEpisode,
            road: resumeRoad,
          );
          historyApplied = true;
          if (playResume ||
              forceHistoryResume ||
              startRequest?.resume == true) {
            videoPageController.historyOffset = progress.progress.inSeconds;
          }
        }
      }
    }
    if (syncPlayEpisode == null && startRequest?.resume == true) {
      if (progress != null && !historyApplied) {
        videoPageController.loading = false;
        videoPageController.errorMessage = '历史集数暂不可用，请选择其他剧集';
        return;
      }
      if (progress == null) {
        KazumiDialog.showToast(message: '没有可用观看历史，将从头播放');
      }
    }
    visibleRoad = videoPageController.selectedEpisode.road;

    videoPageController.bindSyncPlayRoute(playerController);
    if (syncPlayEpisode != null &&
        openingRoomFile != playerController.syncplay.session.currentFileName) {
      return; // The bound file listener is resolving the latest room selection.
    }

    _logSubscription = videoPageController.logStream.listen((log) {
      if (mounted) {
        setState(() {
          webviewLogLines.add(log);
          if (webviewLogLines.length > 100) {
            webviewLogLines.removeAt(0);
          }
        });
      }
    });

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) {
        return;
      }
      changeEpisode(videoPageController.selectedEpisode.episode,
          currentRoad: videoPageController.selectedEpisode.road,
          offset: videoPageController.historyOffset);
    });
  }

  @override
  void dispose() {
    VideoBackNavigation.unregister(_backNavigationHandler);
    try {
      windowManager.removeListener(this);
    } catch (_) {}
    try {
      scrollController.dispose();
    } catch (_) {}
    try {
      animation.dispose();
    } catch (_) {}
    try {
      _syncChatSubscription?.cancel();
    } catch (_) {}
    try {
      _logSubscription?.cancel();
    } catch (_) {}
    videoPageController.cancelVideoSourceResolution();
    try {
      // Keep the global SyncPlay room alive while leaving the player route;
      // the Together Watch tab owns the room connection.
      _playerController?.dispose(disposeSyncPlayController: false);
    } catch (e) {
      KazumiLogger().e(
          'VideoPageController: failed to dispose playerController',
          error: e);
    }
    if (!isDesktop()) {
      try {
        ScreenBrightnessPlatform.instance.resetApplicationScreenBrightness();
      } catch (_) {}
    }
    videoPageController.resetEpisodeComments();
    videoPageController.resetOfflineMode();
    DisplayModeService.unlockScreenRotation();
    keyboardFocus.dispose();
    tabController.dispose();
    TimedShutdownService().cancel();
    super.dispose();
  }

  @override
  void onWindowEnterFullScreen() {
    _hideTabBodyImmediately();
    videoPageController.handleOnEnterFullScreen();
  }

  @override
  void onWindowLeaveFullScreen() {
    videoPageController.handleOnExitFullScreen();
  }

  void showDebugConsole() {
    setState(() {
      showDebugLog = true;
    });
  }

  void hideDebugConsole() {
    setState(() {
      showDebugLog = false;
    });
  }

  void switchDebugConsole() {
    setState(() {
      showDebugLog = !showDebugLog;
    });
  }

  void clearWebviewLog() {
    setState(() {
      webviewLogLines.clear();
    });
  }

  Future<void> changeEpisode(int episode,
      {int currentRoad = 0, int offset = 0}) async {
    final playerController = _playerController;
    if (playerController == null) {
      return;
    }
    if (!mounted) {
      return;
    }
    clearWebviewLog();
    hideDebugConsole();
    await videoPageController.changeEpisode(episode,
        currentRoad: currentRoad,
        offset: offset,
        playerController: playerController);
  }

  void menuJumpToCurrentEpisode() {
    Future.delayed(const Duration(milliseconds: 20), () async {
      if (!mounted) {
        return;
      }
      await observerController.jumpTo(
          index: videoPageController.selectedEpisode.episode > 1
              ? videoPageController.selectedEpisode.episode - 1
              : videoPageController.selectedEpisode.episode);
    });
  }

  bool get _isSideTabLayout =>
      MediaQuery.sizeOf(context).width > MediaQuery.sizeOf(context).height;

  bool get _canAnimateSideTab =>
      mounted && _isSideTabLayout && !disableAnimations;

  void _openTabBodyAnimated() {
    _setTabBodyVisible(true, animated: true);
    menuJumpToCurrentEpisode();
  }

  void _closeTabBodyAnimated() {
    _setTabBodyVisible(false, animated: true);
    keyboardFocus.requestFocus();
  }

  void _toggleTabBodyAnimated() {
    if (_tabBodyTargetVisible) {
      _closeTabBodyAnimated();
    } else {
      _openTabBodyAnimated();
    }
  }

  void _showTabBodyImmediately({bool locateEpisode = true}) {
    _setTabBodyVisible(true, animated: false);
    if (locateEpisode) {
      menuJumpToCurrentEpisode();
    }
  }

  void _hideTabBodyImmediately() {
    _setTabBodyVisible(false, animated: false);
  }

  void _setTabBodyVisible(bool visible, {required bool animated}) {
    _tabBodyTargetVisible = visible;
    final int animationRun = ++_tabBodyAnimationRun;

    if (visible) {
      if (!videoPageController.showTabBody) {
        animation.value = 0.0;
        videoPageController.showTabBody = true;
      }
      if (_canAnimateSideTab && animated) {
        animation.forward(from: animation.value);
      } else {
        animation.value = 1.0;
      }
      return;
    }

    if (!videoPageController.showTabBody) {
      animation.value = 0.0;
      return;
    }

    if (_canAnimateSideTab && animated && animation.value > 0.0) {
      animation.reverse().whenComplete(() {
        if (!mounted || animationRun != _tabBodyAnimationRun) {
          return;
        }
        videoPageController.showTabBody = false;
        animation.value = 0.0;
      });
      return;
    }

    videoPageController.showTabBody = false;
    animation.value = 0.0;
  }

  void _syncTabBodyAnimationAfterLayout() {
    if (!_tabBodyTargetVisible) {
      if (!videoPageController.showTabBody) {
        animation.value = 0.0;
      }
      return;
    }
    if (!videoPageController.showTabBody) {
      animation.value = 0.0;
      return;
    }
    if (!_isSideTabLayout || disableAnimations) {
      animation.value = 1.0;
      return;
    }
    if (animation.value == 0.0 && animation.status != AnimationStatus.reverse) {
      animation.forward();
    }
  }

  void onBackPressed(BuildContext context) async {
    if (!RootBackNavigationGuard.tryClaim()) {
      return;
    }
    if (KazumiDialog.observer.hasKazumiDialog) {
      KazumiDialog.dismiss();
      return;
    }
    if (videoPageController.isPip && isDesktop()) {
      PipUtils.exitDesktopPIPWindow();
      videoPageController.isPip = false;
      return;
    }
    if (videoPageController.isFullscreen && !isTablet()) {
      menuJumpToCurrentEpisode();
      videoPageController.exitFullScreen();
      _hideTabBodyImmediately();
      return;
    }
    if (videoPageController.isFullscreen) {
      videoPageController.exitFullScreen();
    }
    if (_isClosing) return;
    _isClosing = true;
    // The player is pushed as a root-level route.  Its own context can resolve
    // that Navigator reliably; a retained history/My context cannot.
    final navigator = Navigator.of(context, rootNavigator: true);
    if (navigator.canPop()) {
      navigator.pop();
    } else {
      _isClosing = false;
    }
  }

  /// Invoked when Android delivered the edge-back gesture to the retained tab
  /// below this root video route.  Reuse the exact handler used by the visible
  /// back arrow so a gesture and a tap cannot diverge.
  bool _handleBackFromRetainedRoute() {
    if (!mounted) return false;
    onBackPressed(context);
    return true;
  }

  void pauseForTimedShutdown() {
    final playerController = _playerController;
    if (playerController != null && playerController.playback.playing) {
      playerController.pause();
    }
  }

  void sendDanmaku(String msg) async {
    final playerController = _playerController;
    if (playerController == null) {
      return;
    }
    keyboardFocus.requestFocus();
    if (playerController.danmaku.danDanmakus.isEmpty) {
      KazumiDialog.showToast(
        message: '当前剧集不支持弹幕发送',
      );
      return;
    }
    if (msg.isEmpty) {
      KazumiDialog.showToast(message: '弹幕内容为空');
      return;
    } else if (msg.length > 100) {
      KazumiDialog.showToast(message: '弹幕内容过长');
      return;
    }

    final destination = playerController.danmaku.danmakuDestination;

    if (destination == DanmakuDestination.chatRoom) {
      if (playerController.syncplay.syncplayRoom.isEmpty) {
        KazumiDialog.showToast(message: '你还没有加入一起看，无法发送聊天室弹幕');
        return;
      }

      final sender =
          playerController.syncplay.syncplayController?.username ?? '我';
      final String displayText = '$sender：$msg';

      playerController.danmaku.canvasController.addDanmaku(
        DanmakuContentItem(
          displayText,
          color: Colors.orange,
          isColorful: true,
          type: DanmakuItemType.bottom,
          extra: DateTime.now().millisecondsSinceEpoch,
        ),
      );

      playerController.sendSyncPlayChatMessage(msg);
    } else {
      // The remote danmaku provider does not expose a send API here; render the
      // local echo so the user still sees their message immediately.
      playerController.danmaku.canvasController
          .addDanmaku(DanmakuContentItem(msg, selfSend: true));
    }
  }

  void toggleDanmakuFromPortraitChip() {
    final playerController = _playerController;
    if (playerController == null || videoPageController.loading) {
      KazumiDialog.showToast(message: '请等待视频加载完成');
      return;
    }
    if (playerController.danmaku.danmakuOn) {
      showMobileDanmakuInput();
      return;
    }
    if (playerController.danmaku.danDanmakus.isEmpty) {
      KazumiDialog.showToast(message: '当前剧集未匹配到弹幕，可在播放器更多菜单里使用“弹幕切换”');
      return;
    }
    playerController.danmaku.setDanmakuEnabled(true);
    GStorage.putSetting(SettingsKeys.danmakuEnabledByDefault, true);
    KazumiDialog.showToast(message: '弹幕已打开');
    setState(() {});
  }

  void showMobileDanmakuInput() {
    String danmakuText = '';
    showModalBottomSheet(
      shape: const BeveledRectangleBorder(),
      isScrollControlled: true,
      context: context,
      builder: (context) {
        return StatefulBuilder(
          builder: (context, setModalState) {
            return Padding(
              padding: EdgeInsets.only(
                bottom: MediaQuery.of(context).viewInsets.bottom,
                left: 8,
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Expanded(
                    child: Container(
                      constraints: const BoxConstraints(maxHeight: 34),
                      child: TextField(
                        style: const TextStyle(fontSize: 15),
                        autofocus: true,
                        textAlignVertical: TextAlignVertical.center,
                        onChanged: (value) => danmakuText = value,
                        decoration: const InputDecoration(
                          filled: true,
                          floatingLabelBehavior: FloatingLabelBehavior.never,
                          hintText: '发个友善的弹幕见证当下',
                          hintStyle: TextStyle(fontSize: 14),
                          alignLabelWithHint: true,
                          contentPadding:
                              EdgeInsets.symmetric(vertical: 8, horizontal: 12),
                          border: OutlineInputBorder(
                            borderSide: BorderSide.none,
                            borderRadius: BorderRadius.all(Radius.circular(20)),
                          ),
                        ),
                        onSubmitted: (msg) {
                          showDanmakuDestinationPickerAndSend(msg);
                          Navigator.pop(context);
                        },
                      ),
                    ),
                  ),
                  IconButton(
                    onPressed: () {
                      Navigator.pop(context);
                      showDanmakuDestinationPickerAndSend(danmakuText);
                    },
                    icon: Icon(
                      Icons.send_rounded,
                      color: Theme.of(context).colorScheme.primary,
                    ),
                  )
                ],
              ),
            );
          },
        );
      },
    );
  }

  void showDanmakuDestinationPickerAndSend(String msg) async {
    final playerController = _playerController;
    if (playerController == null) {
      return;
    }
    if (msg.trim().isEmpty) {
      KazumiDialog.showToast(message: '弹幕内容为空');
      return;
    }

    final DanmakuDestination? result =
        await showModalBottomSheet<DanmakuDestination>(
      context: context,
      shape: const BeveledRectangleBorder(),
      builder: (context) {
        return SafeArea(
          left: false,
          right: false,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                title: const Text('发送到聊天室'),
                onTap: () =>
                    Navigator.of(context).pop(DanmakuDestination.chatRoom),
              ),
              ListTile(
                title: const Text('发送到远程弹幕库'),
                onTap: () =>
                    Navigator.of(context).pop(DanmakuDestination.remoteDanmaku),
              ),
              const SizedBox(height: 8),
            ],
          ),
        );
      },
    );

    if (result != null) {
      if (!mounted) {
        return;
      }
      setState(() {});
      playerController.danmaku.danmakuDestination = result;
      sendDanmaku(msg);
    }
  }

  @override
  Widget build(BuildContext context) {
    final bool isLandscape =
        MediaQuery.sizeOf(context).width > MediaQuery.sizeOf(context).height;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) {
        return;
      }
      _syncTabBodyAnimationAfterLayout();
    });
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (bool didPop, Object? result) {
        if (didPop) {
          return;
        }
        onBackPressed(context);
      },
      child: OrientationBuilder(builder: (context, orientation) {
        if (!isDesktop()) {
          if (orientation == Orientation.landscape &&
              videoPageController.shouldAutoEnterFullscreenForLandscape) {
            _hideTabBodyImmediately();
            videoPageController.enterFullScreen(lockOrientation: false);
          } else if (orientation == Orientation.portrait) {
            videoPageController.handlePortraitOrientationObserved();
            if (videoPageController.shouldAutoExitFullscreenForPortrait) {
              videoPageController.exitFullScreen(lockOrientation: false);
              _showTabBodyImmediately();
            }
          }
        }
        return Observer(builder: (context) {
          return Scaffold(
            appBar: null,
            body: SafeArea(
                top: !videoPageController.isFullscreen,
                // set iOS and Android navigation bar to immersive
                bottom: false,
                left: !videoPageController.isFullscreen,
                right: !videoPageController.isFullscreen,
                child: Stack(
                  alignment: Alignment.centerRight,
                  children: [
                    Column(
                      children: [
                        Flexible(
                          flex: isLandscape ? 1 : 0,
                          child: Container(
                            color: Colors.black,
                            height: isLandscape
                                ? MediaQuery.sizeOf(context).height
                                : MediaQuery.sizeOf(context).width * 9 / 16,
                            width: MediaQuery.sizeOf(context).width,
                            child: playerBody,
                          ),
                        ),
                        if (!isLandscape) Expanded(child: tabBody),
                      ],
                    ),
                    if (isLandscape && videoPageController.showTabBody) ...[
                      if (disableAnimations) ...[
                        sideTabMask,
                        sideTabBody,
                      ] else ...[
                        FadeTransition(
                          opacity: _maskOpacityAnimation,
                          child: sideTabMask,
                        ),
                        SlideTransition(
                          position: _rightOffsetAnimation,
                          child: sideTabBody,
                        ),
                      ],
                    ],
                  ],
                )),
          );
        });
      }),
    );
  }

  Widget get sideTabBody {
    return SizedBox(
      height: MediaQuery.sizeOf(context).height,
      width: (!isDesktop() && !isTablet())
          ? MediaQuery.sizeOf(context).height
          : (MediaQuery.sizeOf(context).width / 3 > 420
              ? 420
              : MediaQuery.sizeOf(context).width / 3),
      child: Container(
        color: Theme.of(context).canvasColor,
        child: GridViewObserver(
          controller: observerController,
          child: (isDesktop() || isTablet())
              ? tabBody
              : Column(
                  children: [
                    _playbackDetailHeader,
                    _playbackDetailBody,
                  ],
                ),
        ),
      ),
    );
  }

  Widget get sideTabMask {
    return GestureDetector(
      onTap: _closeTabBodyAnimated,
      child: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.centerLeft,
            end: Alignment.centerRight,
            colors: [
              Colors.black.withValues(alpha: 0.5),
              Colors.transparent,
            ],
          ),
        ),
        width: double.infinity,
        height: double.infinity,
      ),
    );
  }

  Widget get playerBody {
    final playerController = _playerController;
    final bool playerLoading = playerController?.playback.loading ?? true;
    return Stack(
      children: [
        Positioned.fill(
          child: Stack(
            children: [
              if (videoPageController.loading ||
                  playerLoading ||
                  videoPageController.errorMessage != null)
                Container(
                  color: Colors.black,
                  child: Observer(builder: (context) {
                    return Center(
                      child: videoPageController.errorMessage != null
                          ? Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Icon(Icons.error_outline,
                                    color: Theme.of(context).colorScheme.error,
                                    size: 48),
                                const SizedBox(height: 16),
                                Padding(
                                  padding: const EdgeInsets.symmetric(
                                      horizontal: 32),
                                  child: Text(
                                    videoPageController.errorMessage!,
                                    style: const TextStyle(
                                        color: Colors.white, fontSize: 16),
                                    textAlign: TextAlign.center,
                                  ),
                                ),
                              ],
                            )
                          : Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                CircularProgressIndicator(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .tertiaryContainer),
                                const SizedBox(height: 10),
                                Text(
                                  videoPageController.loading
                                      ? '视频资源解析中'
                                      : '视频资源解析成功，播放器加载中',
                                  style: const TextStyle(color: Colors.white),
                                ),
                              ],
                            ),
                    );
                  }),
                ),
              Visibility(
                visible: (videoPageController.loading || playerLoading) &&
                    showDebugLog,
                child: Container(
                  color: Colors.black,
                  child: Align(
                    alignment: Alignment.center,
                    child: ListView.builder(
                      shrinkWrap: true,
                      itemCount: webviewLogLines.length,
                      itemBuilder: (context, index) {
                        return Text(
                          webviewLogLines.isEmpty ? '' : webviewLogLines[index],
                          style: const TextStyle(
                            color: Colors.white,
                          ),
                          textAlign: TextAlign.center,
                        );
                      },
                    ),
                  ),
                ),
              ),
              Stack(
                children: [
                  Positioned(
                    top: 0,
                    left: 0,
                    right: 0,
                    child: EmbeddedNativeControlArea(
                      requireOffset: !videoPageController.isFullscreen,
                      child: Row(
                        children: [
                          IconButton(
                            icon: const Icon(Icons.arrow_back,
                                color: Colors.white),
                            onPressed: () => onBackPressed(context),
                          ),
                          const Expanded(
                              child: dtb.DragToMoveArea(
                                  child: SizedBox(height: 40))),
                          IconButton(
                            icon: const Icon(Icons.refresh_outlined,
                                color: Colors.white),
                            onPressed: () {
                              changeEpisode(
                                  videoPageController.selectedEpisode.episode,
                                  currentRoad:
                                      videoPageController.selectedEpisode.road);
                            },
                          ),
                          Visibility(
                            visible: MediaQuery.sizeOf(context).width >
                                MediaQuery.sizeOf(context).height,
                            child: IconButton(
                              onPressed: () {
                                _toggleTabBodyAnimated();
                              },
                              icon: Icon(
                                _tabBodyTargetVisible
                                    ? Icons.menu_open
                                    : Icons.menu_open_outlined,
                                color: Colors.white,
                              ),
                            ),
                          ),
                          IconButton(
                            icon: Icon(
                                showDebugLog
                                    ? Icons.bug_report
                                    : Icons.bug_report_outlined,
                                color: Colors.white),
                            onPressed: () {
                              switchDebugConsole();
                            },
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        Positioned.fill(
          child: playerController == null || playerController.playback.loading
              ? Container()
              : PlayerItem(
                  playerController: playerController,
                  videoPageController: videoPageController,
                  toggleMenu: _toggleTabBodyAnimated,
                  showMenuImmediately: _showTabBodyImmediately,
                  hideMenuImmediately: _hideTabBodyImmediately,
                  changeEpisode: changeEpisode,
                  onBackPressed: onBackPressed,
                  keyboardFocus: keyboardFocus,
                  sendDanmaku: sendDanmaku,
                  disableAnimations: disableAnimations,
                  showDanmakuDestinationPickerAndSend:
                      showDanmakuDestinationPickerAndSend,
                  pauseForTimedShutdown: pauseForTimedShutdown,
                ),
        ),
      ],
    );
  }

  Widget get menuBar {
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 10, 14, 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          const Text(' 正在播放 '),
          Expanded(
            child: Text(
              videoPageController.title,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12,
                color: Theme.of(context).colorScheme.outline,
              ),
            ),
          ),
          const SizedBox(width: 10),
          MenuAnchor(
            consumeOutsideTap: true,
            builder: (_, MenuController controller, __) {
              return SizedBox(
                height: 34,
                child: TextButton(
                  style: ButtonStyle(
                    padding: WidgetStateProperty.all(EdgeInsets.zero),
                  ),
                  onPressed: () {
                    if (controller.isOpen) {
                      controller.close();
                    } else {
                      controller.open();
                    }
                  },
                  child: Text(
                    visibleRoad >= 0 &&
                            visibleRoad < videoPageController.roadList.length
                        ? '${videoPageController.roadList[visibleRoad].name} '
                        : '播放线路${visibleRoad + 1} ',
                    style: const TextStyle(fontSize: 13),
                  ),
                ),
              );
            },
            menuChildren: List<MenuItemButton>.generate(
              videoPageController.roadList.length,
              (int i) => MenuItemButton(
                onPressed: () {
                  setState(() {
                    visibleRoad = i;
                  });
                },
                child: Container(
                  height: 48,
                  constraints: BoxConstraints(minWidth: 112),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      videoPageController.roadList[i].name,
                      style: TextStyle(
                        color: i == visibleRoad
                            ? Theme.of(context).colorScheme.primary
                            : null,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  DownloadEpisode? _getEpisodeFromRecords(
      int episodeNumber, String episodePageUrl) {
    final bangumiId = videoPageController.bangumiItem.id;
    final pluginName = videoPageController.activePluginName;

    for (final record in downloadController.records) {
      if (record.bangumiId == bangumiId && record.pluginName == pluginName) {
        if (episodePageUrl.isNotEmpty) {
          for (final episode in record.episodes.values) {
            if (episode.episodePageUrl == episodePageUrl) {
              return episode;
            }
          }
        }
        return record.episodes[episodeNumber];
      }
    }
    return null;
  }

  Widget _buildDownloadStatusIcon(int episodeNumber, String episodePageUrl) {
    // 显示下载状态图标，离线模式下不显示

    final episode = _getEpisodeFromRecords(episodeNumber, episodePageUrl);
    if (episode == null) return const SizedBox.shrink();
    switch (episode.status) {
      case DownloadStatus.completed:
        return Icon(Icons.offline_pin,
            size: 16, color: Theme.of(context).colorScheme.primary);
      case DownloadStatus.downloading:
        return SizedBox(
          width: 16,
          height: 16,
          child: CircularProgressIndicator(
            value: episode.progressPercent,
            strokeWidth: 2,
          ),
        );
      case DownloadStatus.failed:
        return Icon(Icons.error_outline,
            size: 16, color: Theme.of(context).colorScheme.error);
      case DownloadStatus.paused:
        return Icon(Icons.pause_circle_outline,
            size: 16, color: Theme.of(context).colorScheme.outline);
      case DownloadStatus.pending:
      case DownloadStatus.resolving:
        return SizedBox(
          width: 16,
          height: 16,
          child: CircularProgressIndicator(strokeWidth: 2),
        );
      default:
        return const SizedBox.shrink();
    }
  }

  Widget get menuBody {
    return Observer(
      builder: (context) {
        var cardList = <Widget>[];
        if (visibleRoad >= 0 &&
            visibleRoad < videoPageController.roadList.length) {
          final road = videoPageController.roadList[visibleRoad];
          int count = 1;
          for (var urlItem in road.data) {
            int count0 = count;
            final episodeName = count0 - 1 < road.identifier.length
                ? road.identifier[count0 - 1]
                : '第$count0集';
            cardList.add(Container(
              margin: const EdgeInsets.only(bottom: 4),
              child: Material(
                color: Theme.of(context).colorScheme.onInverseSurface,
                borderRadius: BorderRadius.circular(6),
                clipBehavior: Clip.hardEdge,
                child: InkWell(
                  onTap: () async {
                    if (count0 == videoPageController.selectedEpisode.episode &&
                        videoPageController.selectedEpisode.road ==
                            visibleRoad) {
                      return;
                    }
                    KazumiLogger()
                        .i('VideoPageController: video URL is $urlItem');
                    _closeTabBodyAnimated();
                    changeEpisode(count0, currentRoad: visibleRoad);
                  },
                  child: Padding(
                    padding:
                        const EdgeInsets.symmetric(vertical: 8, horizontal: 10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Row(
                          children: [
                            if (count0 ==
                                    (videoPageController
                                        .selectedEpisode.episode) &&
                                visibleRoad ==
                                    videoPageController
                                        .selectedEpisode.road) ...<Widget>[
                              Image.asset(
                                'assets/images/playing.gif',
                                color: Theme.of(context).colorScheme.primary,
                                height: 12,
                              ),
                              const SizedBox(width: 6)
                            ],
                            Expanded(
                                child: Text(
                              episodeName,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                  fontSize: 13,
                                  color: (count0 ==
                                              videoPageController
                                                  .selectedEpisode.episode &&
                                          visibleRoad ==
                                              videoPageController
                                                  .selectedEpisode.road)
                                      ? Theme.of(context).colorScheme.primary
                                      : Theme.of(context)
                                          .colorScheme
                                          .onSurface),
                            )),
                            _buildDownloadStatusIcon(count0, urlItem),
                            const SizedBox(width: 2),
                          ],
                        ),
                        const SizedBox(height: 3),
                      ],
                    ),
                  ),
                ),
              ),
            ));
            count++;
          }
        }
        return Expanded(
          child: Padding(
            padding: const EdgeInsets.only(top: 0, right: 8, left: 8),
            child: GridView.builder(
              scrollDirection: Axis.vertical,
              controller: scrollController,
              gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 3,
                crossAxisSpacing: 10,
                mainAxisSpacing: 5,
                mainAxisExtent: 70,
              ),
              itemCount: cardList.length,
              itemBuilder: (context, index) {
                return cardList[index];
              },
            ),
          ),
        );
      },
    );
  }

  Widget get _playbackDetailHeader {
    return Observer(builder: (context) {
      final totalEpisodes =
          visibleRoad >= 0 && visibleRoad < videoPageController.roadList.length
              ? videoPageController.roadList[visibleRoad].data.length
              : 0;
      return Padding(
        padding: const EdgeInsets.fromLTRB(18, 10, 14, 4),
        child: Row(
          children: [
            const Text(
              '正在播放',
              style: TextStyle(fontWeight: FontWeight.w700),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                videoPageController.title,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 12,
                  color: Theme.of(context).colorScheme.outline,
                ),
              ),
            ),
            _buildRoadMenu(),
            TextButton(
              onPressed: totalEpisodes == 0 ? null : _showEpisodeGridSheet,
              style: TextButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 6),
                minimumSize: const Size(0, 34),
              ),
              child: Text(
                _episodeCountLabel(totalEpisodes),
                style: const TextStyle(fontSize: 13),
              ),
            ),
          ],
        ),
      );
    });
  }

  Widget _buildRoadMenu() {
    return MenuAnchor(
      consumeOutsideTap: true,
      builder: (_, MenuController controller, __) {
        return SizedBox(
          height: 34,
          child: TextButton(
            style: ButtonStyle(
              padding: WidgetStateProperty.all(EdgeInsets.zero),
            ),
            onPressed: () {
              if (controller.isOpen) {
                controller.close();
              } else {
                controller.open();
              }
            },
            child: Text(
              visibleRoad >= 0 &&
                      visibleRoad < videoPageController.roadList.length
                  ? '${videoPageController.roadList[visibleRoad].name} '
                  : '播放线路${visibleRoad + 1} ',
              style: const TextStyle(fontSize: 13),
            ),
          ),
        );
      },
      menuChildren: List<MenuItemButton>.generate(
        videoPageController.roadList.length,
        (int i) => MenuItemButton(
          onPressed: () {
            setState(() {
              visibleRoad = i;
            });
          },
          child: SizedBox(
            height: 48,
            width: 112,
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                videoPageController.roadList[i].name,
                style: TextStyle(
                  color: i == visibleRoad
                      ? Theme.of(context).colorScheme.primary
                      : null,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget get _playbackDetailBody {
    return Observer(
      builder: (context) {
        return Expanded(
          child: SingleChildScrollView(
            controller: scrollController,
            physics: const BouncingScrollPhysics(),
            child: Padding(
              padding: const EdgeInsets.only(bottom: 24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _buildEpisodeStrip(),
                  _buildRelatedSection(
                    '系列作品',
                    _seriesItems,
                    highlightCurrent: true,
                  ),
                  _buildRelatedSection('热门推荐', _hotRecommendItems),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  String _episodeTitle(int episodeIndex) {
    if (visibleRoad < 0 || visibleRoad >= videoPageController.roadList.length) {
      return '第$episodeIndex集';
    }
    final road = videoPageController.roadList[visibleRoad];
    return episodeIndex - 1 < road.identifier.length
        ? road.identifier[episodeIndex - 1]
        : '第$episodeIndex集';
  }

  String _episodeUrl(int episodeIndex) {
    if (visibleRoad < 0 || visibleRoad >= videoPageController.roadList.length) {
      return '';
    }
    final road = videoPageController.roadList[visibleRoad];
    return episodeIndex - 1 < road.data.length
        ? road.data[episodeIndex - 1]
        : '';
  }

  bool _isCurrentEpisode(int episodeIndex) {
    return episodeIndex == videoPageController.selectedEpisode.episode &&
        visibleRoad == videoPageController.selectedEpisode.road;
  }

  Widget _buildEpisodeButton(
    int episodeIndex, {
    double width = 76,
    bool closeOnTap = false,
  }) {
    final selected = _isCurrentEpisode(episodeIndex);
    final colorScheme = Theme.of(context).colorScheme;
    final title = _episodeTitle(episodeIndex);
    final url = _episodeUrl(episodeIndex);
    return SizedBox(
      width: width,
      height: 58,
      child: Material(
        color: selected
            ? colorScheme.primary
            : colorScheme.surfaceContainerHighest.withValues(alpha: 0.65),
        borderRadius: BorderRadius.circular(18),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: selected
              ? null
              : () {
                  KazumiLogger().i('VideoPageController: video URL is $url');
                  if (closeOnTap) {
                    Navigator.of(context).pop();
                  }
                  changeEpisode(episodeIndex, currentRoad: visibleRoad);
                },
          child: Center(
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (selected) ...[
                  Image.asset(
                    'assets/images/playing.gif',
                    color: colorScheme.onPrimary,
                    height: 12,
                  ),
                  const SizedBox(width: 5),
                ],
                Flexible(
                  child: Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                      color: selected
                          ? colorScheme.onPrimary
                          : colorScheme.onSurface,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildEpisodeStrip() {
    if (visibleRoad < 0 || visibleRoad >= videoPageController.roadList.length) {
      return const SizedBox.shrink();
    }
    final total = videoPageController.roadList[visibleRoad].data.length;
    return SizedBox(
      height: 78,
      child: ListView.separated(
        padding: const EdgeInsets.fromLTRB(18, 8, 18, 12),
        scrollDirection: Axis.horizontal,
        physics: const BouncingScrollPhysics(),
        itemCount: total,
        separatorBuilder: (_, __) => const SizedBox(width: 10),
        itemBuilder: (context, index) => _buildEpisodeButton(index + 1),
      ),
    );
  }

  void _showEpisodeGridSheet() {
    if (visibleRoad < 0 || visibleRoad >= videoPageController.roadList.length) {
      return;
    }
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) {
        final total = videoPageController.roadList[visibleRoad].data.length;
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 0, 18, 18),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        '正在播放 选集 ${videoPageController.title}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context)
                            .textTheme
                            .titleMedium
                            ?.copyWith(fontWeight: FontWeight.w700),
                      ),
                    ),
                    Text(_episodeCountLabel(total).replaceAll(' >', '')),
                  ],
                ),
                const SizedBox(height: 14),
                SizedBox(
                  height: MediaQuery.sizeOf(context).height * 0.45,
                  child: GridView.builder(
                    physics: const BouncingScrollPhysics(),
                    gridDelegate:
                        const SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: 5,
                      mainAxisSpacing: 10,
                      crossAxisSpacing: 10,
                      mainAxisExtent: 58,
                    ),
                    itemCount: total,
                    itemBuilder: (context, index) => _buildEpisodeButton(
                      index + 1,
                      width: 64,
                      closeOnTap: true,
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _buildRelatedSection(
    String title,
    List<BangumiItem> items, {
    bool highlightCurrent = false,
  }) {
    if (items.isEmpty) {
      return const SizedBox.shrink();
    }
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18),
            child: Text(
              title,
              style: Theme.of(context)
                  .textTheme
                  .titleMedium
                  ?.copyWith(fontWeight: FontWeight.w800),
            ),
          ),
          const SizedBox(height: 10),
          SizedBox(
            height: 218,
            child: ListView.separated(
              padding: const EdgeInsets.symmetric(horizontal: 18),
              scrollDirection: Axis.horizontal,
              physics: const BouncingScrollPhysics(),
              itemCount: items.length,
              separatorBuilder: (_, __) => const SizedBox(width: 12),
              itemBuilder: (context, index) {
                final item = items[index];
                final isCurrent =
                    highlightCurrent && _isCurrentBangumiItem(item);
                return _buildRelatedCard(item, isCurrent: isCurrent);
              },
            ),
          ),
        ],
      ),
    );
  }

  bool _isCurrentBangumiItem(BangumiItem item) {
    return _isSameBangumiTitle(item, videoPageController.bangumiItem);
  }

  Future<void> _openRelatedBangumi(BangumiItem item) async {
    if (_playerController?.syncplay.isGuest ?? false) {
      KazumiDialog.showToast(message: '当前由房主控制播放');
      return;
    }
    if (_openingRelatedBangumi) return;
    _openingRelatedBangumi = true;
    try {
      // The current route remains mounted underneath the related title. Pause
      // its own player before navigating so only the new playback route can
      // produce audio. Its episode and exact position remain in memory.
      await _playerController?.pause();
      if (!mounted) return;
      await Modular.to.pushNamed('/info/', arguments: item);
    } finally {
      _openingRelatedBangumi = false;
    }
  }

  Widget _buildRelatedCard(BangumiItem item, {required bool isCurrent}) {
    final colorScheme = Theme.of(context).colorScheme;
    final card = SizedBox(
      width: 116,
      child: BangumiCardV(
        bangumiItem: item,
        enableHero: false,
        onTap: () => _openRelatedBangumi(item),
      ),
    );
    if (!isCurrent) {
      return card;
    }
    return Stack(
      children: [
        IgnorePointer(
          child: Container(
            width: 116,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: colorScheme.primary, width: 2),
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: card,
            ),
          ),
        ),
        Positioned(
          top: 6,
          left: 6,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
            decoration: BoxDecoration(
              color: colorScheme.primary,
              borderRadius: BorderRadius.circular(999),
            ),
            child: Text(
              '当前',
              style: TextStyle(
                color: colorScheme.onPrimary,
                fontSize: 11,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget get tabBody {
    final playerController = _playerController;
    final bool danmakuOn = playerController?.danmaku.danmakuOn ?? false;
    final int episodeNum = max(1, videoPageController.commentsEpisode);

    return Container(
      color: Theme.of(context).canvasColor,
      child: DefaultTabController(
        length: 2,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                TabBar(
                  controller: tabController,
                  dividerHeight: 0,
                  isScrollable: true,
                  tabAlignment: TabAlignment.start,
                  labelPadding:
                      const EdgeInsetsDirectional.only(start: 30, end: 30),
                  onTap: (index) {
                    if (index == 0) {
                      menuJumpToCurrentEpisode();
                    }
                  },
                  tabs: const [
                    Tab(text: '选集'),
                    Tab(text: '评论'),
                  ],
                ),
                if (MediaQuery.sizeOf(context).width <=
                    MediaQuery.sizeOf(context).height) ...[
                  const Spacer(),
                  Container(
                    padding: EdgeInsets.symmetric(horizontal: 5, vertical: 2),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(25),
                      border: Border.all(
                        color: danmakuOn
                            ? Theme.of(context).hintColor
                            : Theme.of(context).disabledColor,
                        width: 0.5,
                      ),
                    ),
                    child: GestureDetector(
                      onTap: toggleDanmakuFromPortraitChip,
                      child: Row(
                        children: [
                          Text(
                            danmakuOn ? '  点我发弹幕  ' : '  已关闭弹幕  ',
                            softWrap: false,
                            overflow: TextOverflow.clip,
                            style: TextStyle(
                              color: danmakuOn
                                  ? Theme.of(context).hintColor
                                  : Theme.of(context).disabledColor,
                            ),
                          ),
                          if (danmakuOn)
                            Icon(
                              Icons.send_rounded,
                              size: 20,
                              color: Theme.of(context).hintColor,
                            ),
                        ],
                      ),
                    ),
                  ),
                ],
                const SizedBox(width: 8),
              ],
            ),
            Divider(height: isDesktop() ? 0.5 : 0.2),
            Expanded(
              child: TabBarView(
                controller: tabController,
                children: [
                  Stack(
                    children: [
                      GridViewObserver(
                        controller: observerController,
                        child: Column(
                          children: [
                            _playbackDetailHeader,
                            _playbackDetailBody,
                          ],
                        ),
                      ),
                      if (!videoPageController.isOfflineMode)
                        Positioned(
                          right: 16,
                          bottom: 16,
                          child: FloatingActionButton(
                            child: const Icon(Icons.download_rounded),
                            onPressed: () {
                              showModalBottomSheet(
                                context: context,
                                isScrollControlled: true,
                                builder: (context) => DownloadEpisodeSheet(
                                  road: visibleRoad,
                                  videoPageController: videoPageController,
                                ),
                              );
                            },
                          ),
                        ),
                    ],
                  ),
                  EpisodeInfoWidget(
                    episode: episodeNum,
                    child: EpisodeCommentsSheet(
                      videoPageController: videoPageController,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
