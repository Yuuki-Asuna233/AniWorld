import 'package:flutter/material.dart';
import 'package:flutter_mobx/flutter_mobx.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/bean/card/network_img_layer.dart';
import 'package:kazumi/bean/dialog/dialog_helper.dart';
import 'package:kazumi/bean/widget/collect_button.dart';
import 'package:kazumi/modules/download/download_module.dart';
import 'package:kazumi/modules/history/history_module.dart';
import 'package:kazumi/pages/collect/collect_controller.dart';
import 'package:kazumi/pages/download/download_controller.dart';
import 'package:kazumi/pages/video/video_controller.dart';
import 'package:kazumi/plugins/plugins.dart';
import 'package:kazumi/plugins/plugins_controller.dart';
import 'package:kazumi/utils/date_time.dart';

String historySourceText(String entryKind) {
  return HistoryEntryKind.normalize(entryKind) == HistoryEntryKind.offline
      ? '缓存'
      : '在线';
}

Future<HistoryPlaybackOpenResult> openHistoryPlaybackForEntry({
  required String entryKind,
  required Future<bool> Function() openOnlinePlayback,
  required Future<bool> Function() openOfflinePlayback,
}) async {
  if (HistoryEntryKind.normalize(entryKind) == HistoryEntryKind.offline) {
    final opened = await openOfflinePlayback();
    return HistoryPlaybackOpenResult(
      opened: opened,
      failureMessage: opened ? null : '未找到可用缓存',
    );
  }

  final opened = await openOnlinePlayback();
  return HistoryPlaybackOpenResult(
    opened: opened,
    failureMessage: opened ? null : '在线源不可用，请重新选择播放源',
  );
}

class HistoryPlaybackOpenResult {
  const HistoryPlaybackOpenResult({
    required this.opened,
    required this.failureMessage,
  });

  final bool opened;
  final String? failureMessage;
}

/// Opens a history entry through the exact same path used by the history card.
///
/// Other entry points, such as update reminders, call this function instead of
/// rebuilding source selection and resume behavior independently.
Future<void> resumeHistoryPlayback(History historyItem) async {
  final pluginsController = Modular.get<PluginsController>();
  final downloadController = Modular.get<DownloadController>();

  // History cards can be tapped before the delayed startup plugin task has
  // finished.  In that window pluginList is still empty, so a DM84 history
  // entry was incorrectly treated as an unavailable source and sent back to
  // the detail page.  Ensure the bundled playback sources are present before
  // resolving the history entry.
  try {
    await pluginsController.preparePlaybackSources();
  } catch (_) {
    // The individual opener below still reports a normal unavailable-source
    // result if plugin initialization genuinely failed.
  }

  final videoPageController = VideoPageController();
  final result = await openHistoryPlaybackForEntry(
    entryKind: historyItem.entryKind,
    openOnlinePlayback: () => _openOnlineHistoryPlayback(
      historyItem,
      videoPageController,
      pluginsController,
    ),
    openOfflinePlayback: () => _openOfflineHistoryPlayback(
      historyItem,
      videoPageController,
      downloadController,
    ),
  );
  if (result.opened) {
    Modular.to.pushNamed('/video/', arguments: videoPageController);
    return;
  }
  Modular.to.pushNamed('/info/', arguments: historyItem.bangumiItem);
  KazumiDialog.showToast(message: result.failureMessage ?? '已打开番剧详情');
}

Future<bool> _openOnlineHistoryPlayback(
  History historyItem,
  VideoPageController videoPageController,
  PluginsController pluginsController,
) async {
  final adapterName = historyItem.adapterName.trim();
  final isAniWorldSource = adapterName.toLowerCase() == 'aniworld';
  final historyTitle = historyItem.bangumiItem.nameCn == ''
      ? historyItem.bangumiItem.name
      : historyItem.bangumiItem.nameCn;

  // AniWorld is a built-in OI source, not an installed Kazumi plugin. OI roads
  // can be rebuilt from the subject even for legacy entries without lastSrc.
  if (isAniWorldSource) {
    videoPageController.bangumiItem = historyItem.bangumiItem;
    videoPageController.title = historyTitle;
    videoPageController.src =
        historyItem.lastSrc.isNotEmpty ? historyItem.lastSrc : historyTitle;
    videoPageController.requestHistoryResume();
    videoPageController.beginQueryRoads('AniWorld', 'AniWorld');
    return true;
  }

  if (historyItem.lastSrc.isEmpty) return false;
  Plugin? targetPlugin;
  for (final plugin in pluginsController.pluginList) {
    if (plugin.name.toLowerCase() == adapterName.toLowerCase()) {
      targetPlugin = plugin;
      break;
    }
  }
  if (targetPlugin == null) return false;
  videoPageController.bangumiItem = historyItem.bangumiItem;
  videoPageController.currentPlugin = targetPlugin;
  videoPageController.title = historyTitle;
  videoPageController.src = historyItem.lastSrc;
  videoPageController.requestHistoryResume();
  videoPageController.beginQueryRoads(
    historyItem.lastSrc,
    targetPlugin.name,
  );
  return true;
}

Future<bool> _openOfflineHistoryPlayback(
  History historyItem,
  VideoPageController videoPageController,
  DownloadController downloadController,
) async {
  final downloadedEpisodes = downloadController.getCompletedEpisodes(
    historyItem.bangumiItem.id,
    historyItem.adapterName,
  );
  if (downloadedEpisodes.isEmpty) return false;

  DownloadEpisode? targetEpisode;
  if (historyItem.episodePageUrl.isNotEmpty) {
    for (final episode in downloadedEpisodes) {
      if (episode.episodePageUrl == historyItem.episodePageUrl) {
        targetEpisode = episode;
        break;
      }
    }
  }
  targetEpisode ??= _historyEpisodeByNumber(
    downloadedEpisodes,
    historyItem.lastWatchEpisode,
  );
  if (targetEpisode == null) return false;

  final localPath = downloadController.getLocalVideoPath(
    historyItem.bangumiItem.id,
    historyItem.adapterName,
    targetEpisode.episodeNumber,
  );
  if (localPath == null) return false;

  videoPageController.initForOfflinePlayback(
    bangumiItem: historyItem.bangumiItem,
    pluginName: historyItem.adapterName,
    episodeNumber: targetEpisode.episodeNumber,
    road: targetEpisode.road,
    downloadedEpisodes: downloadedEpisodes,
  );
  videoPageController.requestHistoryResume();
  return true;
}

DownloadEpisode? _historyEpisodeByNumber(
  List<DownloadEpisode> episodes,
  int episodeNumber,
) {
  for (final episode in episodes) {
    if (episode.episodeNumber == episodeNumber) return episode;
  }
  return null;
}

// 视频历史记录卡片 - 水平布局
class BangumiHistoryCardV extends StatefulWidget {
  const BangumiHistoryCardV({
    super.key,
    required this.historyItem,
    this.showDelete = false,
    this.onDeleted,
  });

  final History historyItem;
  final bool showDelete;
  final VoidCallback? onDeleted;

  @override
  State<BangumiHistoryCardV> createState() => _BangumiHistoryCardVState();
}

class _BangumiHistoryCardVState extends State<BangumiHistoryCardV> {
  final CollectController collectController = Modular.get<CollectController>();

  Future<void> _resumePlayback() async {
    if (widget.showDelete) {
      KazumiDialog.showToast(message: '编辑模式');
      return;
    }
    await resumeHistoryPlayback(widget.historyItem);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final double imageWidth = 80;
    final double imageHeight = 108;
    final String title = widget.historyItem.bangumiItem.nameCn == ''
        ? widget.historyItem.bangumiItem.name
        : widget.historyItem.bangumiItem.nameCn;
    final String episodeText = widget.historyItem.lastWatchEpisodeName.isEmpty
        ? '第${widget.historyItem.lastWatchEpisode}话'
        : widget.historyItem.lastWatchEpisodeName;
    final String sourceText = historySourceText(widget.historyItem.entryKind);

    return Dismissible(
      key: ValueKey(widget.historyItem.key),
      direction: DismissDirection.endToStart,
      onDismissed: (_) {
        widget.onDeleted?.call();
      },
      background: Container(
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 24),
        margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 8),
        decoration: BoxDecoration(
          color: colorScheme.errorContainer,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Icon(
          Icons.delete_outline,
          color: colorScheme.onErrorContainer,
        ),
      ),
      child: Card(
        elevation: 0,
        margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 8),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
        ),
        clipBehavior: Clip.antiAlias,
        color: colorScheme.surfaceContainerLow,
        child: InkWell(
          onTap: _resumePlayback,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: NetworkImgLayer(
                    src: widget.historyItem.bangumiItem.images['large'] ?? '',
                    fallbackSrc:
                        widget.historyItem.bangumiItem.images['fallback'],
                    width: imageWidth,
                    height: imageHeight,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: SizedBox(
                    height: imageHeight,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          style: theme.textTheme.titleSmall?.copyWith(
                            color: colorScheme.onSurface,
                            fontWeight: FontWeight.w600,
                          ),
                          overflow: TextOverflow.ellipsis,
                          maxLines: 1,
                        ),
                        const SizedBox(height: 6),
                        Row(
                          children: [
                            Icon(
                              Icons.play_circle_outline,
                              size: 14,
                              color: colorScheme.onSurfaceVariant,
                            ),
                            const SizedBox(width: 4),
                            Flexible(
                              child: Text(
                                episodeText,
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: colorScheme.onSurfaceVariant,
                                ),
                                overflow: TextOverflow.ellipsis,
                                maxLines: 1,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 4),
                        Row(
                          children: [
                            Icon(
                              Icons.extension_outlined,
                              size: 14,
                              color: colorScheme.onSurfaceVariant,
                            ),
                            const SizedBox(width: 4),
                            Flexible(
                              child: Text(
                                '$sourceText · ${widget.historyItem.adapterName}',
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: colorScheme.onSurfaceVariant,
                                ),
                                overflow: TextOverflow.ellipsis,
                                maxLines: 1,
                              ),
                            ),
                          ],
                        ),
                        const Spacer(),
                        Row(
                          children: [
                            Icon(
                              Icons.access_time,
                              size: 12,
                              color: colorScheme.outline,
                            ),
                            const SizedBox(width: 4),
                            Text(
                              formatTimestampToRelativeTime(widget.historyItem
                                      .lastWatchTime.millisecondsSinceEpoch ~/
                                  1000),
                              style: theme.textTheme.labelSmall?.copyWith(
                                color: colorScheme.outline,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
                Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (!widget.showDelete) ...[
                      Observer(
                        builder: (context) {
                          collectController.collectibles.length;
                          return CollectButton(
                            onClose: () {
                              FocusScope.of(context).unfocus();
                            },
                            bangumiItem: widget.historyItem.bangumiItem,
                            color: colorScheme.onSurfaceVariant,
                          );
                        },
                      ),
                      IconButton(
                        icon: Icon(
                          Icons.open_in_new,
                          size: 20,
                          color: colorScheme.onSurfaceVariant,
                        ),
                        tooltip: '番剧详情',
                        onPressed: () {
                          Modular.to.pushNamed(
                            '/info/',
                            arguments: widget.historyItem.bangumiItem,
                          );
                        },
                      ),
                      IconButton(
                        icon: Icon(
                          Icons.play_arrow_rounded,
                          size: 22,
                          color: colorScheme.primary,
                        ),
                        tooltip: '继续播放',
                        onPressed: _resumePlayback,
                      ),
                    ],
                    if (widget.showDelete)
                      IconButton(
                        icon: Icon(
                          Icons.delete_outline,
                          color: colorScheme.error,
                        ),
                        tooltip: '删除记录',
                        onPressed: () {
                          widget.onDeleted?.call();
                        },
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
