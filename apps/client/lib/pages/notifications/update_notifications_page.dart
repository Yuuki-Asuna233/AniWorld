import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/bean/appbar/sys_app_bar.dart';
import 'package:kazumi/bean/card/bangumi_history_card.dart';
import 'package:kazumi/bean/card/network_img_layer.dart';
import 'package:kazumi/modules/history/history_module.dart';
import 'package:kazumi/modules/notifications/update_notification.dart';
import 'package:kazumi/pages/notifications/update_notification_controller.dart';
import 'package:kazumi/repositories/history_repository.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';
import 'package:kazumi/utils/date_time.dart';
import 'package:kazumi/utils/root_back_navigation.dart';

class UpdateNotificationsPage extends StatefulWidget {
  const UpdateNotificationsPage({super.key});

  @override
  State<UpdateNotificationsPage> createState() =>
      _UpdateNotificationsPageState();
}

class _UpdateNotificationsPageState extends State<UpdateNotificationsPage> {
  final UpdateNotificationController notificationController =
      Modular.get<UpdateNotificationController>();
  final IHistoryRepository historyRepository =
      Modular.get<IHistoryRepository>();
  final Set<int> _openingAnimeIds = {};
  bool _allowRoutePop = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        unawaited(notificationController.checkForUpdates(force: true));
      }
    });
  }

  void _onBackPressed() {
    if (!RootBackNavigationGuard.tryClaim()) return;
    setState(() => _allowRoutePop = true);
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      final popped = await Navigator.of(context).maybePop();
      if (mounted && !popped) setState(() => _allowRoutePop = false);
    });
  }

  Future<void> _openDetails(UpdateNotificationItem notification) async {
    await notificationController.markRead(notification.animeId);
    if (!mounted) return;
    Modular.to.pushNamed('/info/', arguments: notification.bangumiItem);
  }

  Future<void> _watchNow(UpdateNotificationItem notification) async {
    if (_openingAnimeIds.contains(notification.animeId)) return;
    setState(() => _openingAnimeIds.add(notification.animeId));
    try {
      await notificationController.markRead(notification.animeId);
      if (!mounted) return;
      History? targetHistory;
      for (final history in historyRepository.getAllHistories()) {
        if (history.bangumiItem.id == notification.animeId) {
          targetHistory = history;
          break;
        }
      }
      if (targetHistory == null) {
        Modular.to.pushNamed('/info/', arguments: notification.bangumiItem);
        return;
      }
      await resumeHistoryPlayback(targetHistory);
    } finally {
      if (mounted) {
        setState(() => _openingAnimeIds.remove(notification.animeId));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: notificationController,
      builder: (context, _) {
        return PopScope(
          canPop: _allowRoutePop,
          onPopInvokedWithResult: (didPop, result) {
            if (!didPop) _onBackPressed();
          },
          child: Scaffold(
            appBar: SysAppBar(
              title: const Text('更新提醒'),
              actions: [
                if (notificationController.unreadCount > 0)
                  TextButton(
                    onPressed: notificationController.markAllRead,
                    child: const Text('全部已读'),
                  ),
              ],
            ),
            body: SafeArea(
              bottom: false,
              child: RefreshIndicator(
                onRefresh: () =>
                    notificationController.checkForUpdates(force: true),
                child: _buildBody(),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _buildBody() {
    final notifications = notificationController.notifications;
    if (notifications.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          SizedBox(height: MediaQuery.sizeOf(context).height * 0.22),
          Icon(
            Icons.notifications_none_rounded,
            size: 72,
            color: Theme.of(context).colorScheme.outline.withValues(alpha: 0.5),
          ),
          const SizedBox(height: 16),
          Text(
            notificationController.isChecking ? '正在检查追番更新…' : '暂时没有更新提醒',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  color: Theme.of(context).colorScheme.outline,
                ),
          ),
          const SizedBox(height: 8),
          Text(
            '“在看”和“想看”的更新中作品会显示在这里',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: Theme.of(context).colorScheme.outline,
                ),
          ),
        ],
      );
    }

    final children = <Widget>[];
    String? previousGroup;
    for (final notification in notifications) {
      final group = _dateGroup(notification.updatedAtMs);
      if (group != previousGroup) {
        children.add(_buildGroupHeader(group));
        previousGroup = group;
      }
      children.add(_buildNotification(notification));
    }

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(
        parent: BouncingScrollPhysics(),
      ),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 28),
      children: [
        Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 920),
            child: Column(children: children),
          ),
        ),
      ],
    );
  }

  Widget _buildGroupHeader(String label) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 14, 8, 8),
        child: Text(
          label,
          style: Theme.of(context)
              .textTheme
              .titleMedium
              ?.copyWith(fontWeight: FontWeight.w800),
        ),
      ),
    );
  }

  Widget _buildNotification(UpdateNotificationItem notification) {
    final colorScheme = Theme.of(context).colorScheme;
    final username = AniWorldApi.cachedUser?.username ?? '';
    final opening = _openingAnimeIds.contains(notification.animeId);
    return Dismissible(
      key: ValueKey('update-notification-${notification.animeId}'),
      direction: DismissDirection.endToStart,
      onDismissed: (_) {
        unawaited(
          notificationController.deleteNotification(notification.animeId),
        );
      },
      background: Container(
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.only(right: 24),
        alignment: Alignment.centerRight,
        decoration: BoxDecoration(
          color: colorScheme.errorContainer,
          borderRadius: BorderRadius.circular(20),
        ),
        child: Icon(Icons.delete_outline, color: colorScheme.onErrorContainer),
      ),
      child: Container(
        width: double.infinity,
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: notification.isRead
              ? colorScheme.surfaceContainerLow
              : colorScheme.primaryContainer.withValues(alpha: 0.52),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(
            color: notification.isRead
                ? colorScheme.outlineVariant
                : colorScheme.primary.withValues(alpha: 0.3),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (!notification.isRead) ...[
                  Container(
                    width: 8,
                    height: 8,
                    margin: const EdgeInsets.only(top: 7, right: 8),
                    decoration: BoxDecoration(
                      color: colorScheme.primary,
                      shape: BoxShape.circle,
                    ),
                  ),
                ],
                Expanded(
                  child: Text(
                    notification.messageFor(username),
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          height: 1.45,
                          fontWeight: notification.isRead
                              ? FontWeight.w500
                              : FontWeight.w700,
                        ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Material(
              color: colorScheme.surface,
              borderRadius: BorderRadius.circular(16),
              clipBehavior: Clip.antiAlias,
              child: InkWell(
                onTap: () => _openDetails(notification),
                child: Padding(
                  padding: const EdgeInsets.all(10),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      ClipRRect(
                        borderRadius: BorderRadius.circular(11),
                        child: NetworkImgLayer(
                          src: notification.bangumiItem.images['large'] ?? '',
                          fallbackSrc: notification.bangumiItem.images['fallback'],
                          width: 76,
                          height: 104,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: SizedBox(
                          height: 104,
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                notification.title,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: Theme.of(context)
                                    .textTheme
                                    .titleSmall
                                    ?.copyWith(fontWeight: FontWeight.w800),
                              ),
                              const SizedBox(height: 7),
                              Text(
                                notification.statusText,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  color: colorScheme.onSurfaceVariant,
                                ),
                              ),
                              const Spacer(),
                              Row(
                                children: [
                                  Expanded(
                                    child: Text(
                                      formatTimestampToRelativeTime(
                                        notification.updatedAtMs ~/ 1000,
                                      ),
                                      style: Theme.of(context)
                                          .textTheme
                                          .labelMedium
                                          ?.copyWith(
                                            color: colorScheme.outline,
                                          ),
                                    ),
                                  ),
                                  FilledButton.tonalIcon(
                                    onPressed: opening
                                        ? null
                                        : () => _watchNow(notification),
                                    icon: opening
                                        ? const SizedBox(
                                            width: 15,
                                            height: 15,
                                            child: CircularProgressIndicator(
                                              strokeWidth: 2,
                                            ),
                                          )
                                        : const Icon(
                                            Icons.play_arrow_rounded,
                                            size: 18,
                                          ),
                                    label: const Text('立即观看'),
                                    style: FilledButton.styleFrom(
                                      visualDensity: VisualDensity.compact,
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _dateGroup(int timestampMs) {
    final date = DateTime.fromMillisecondsSinceEpoch(timestampMs);
    final now = DateTime.now();
    if (DateUtils.isSameDay(date, now)) return '今天';
    if (DateUtils.isSameDay(date, now.subtract(const Duration(days: 1)))) {
      return '昨天';
    }
    return '更早';
  }
}
