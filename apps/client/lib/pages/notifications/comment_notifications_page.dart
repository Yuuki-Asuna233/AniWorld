import 'package:flutter/material.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/bean/appbar/sys_app_bar.dart';
import 'package:kazumi/bean/dialog/dialog_helper.dart';
import 'package:kazumi/modules/notifications/comment_notification.dart';
import 'package:kazumi/pages/notifications/comment_notification_controller.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';

class CommentNotificationsPage extends StatefulWidget {
  const CommentNotificationsPage({super.key});

  @override
  State<CommentNotificationsPage> createState() =>
      _CommentNotificationsPageState();
}

class _CommentNotificationsPageState extends State<CommentNotificationsPage> {
  final CommentNotificationController controller =
      Modular.get<CommentNotificationController>();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  Future<void> _refresh() async {
    final account = AniWorldAccountSnapshot();
    if (!account.isLoggedIn) return;
    try {
      await controller.refresh(force: true);
      if (!mounted || !account.isCurrent) return;
      await controller.markAllRead();
    } catch (e) {
      if (mounted && account.isCurrent) {
        KazumiDialog.showToast(message: _errorMessage(e));
      }
    }
  }

  String _errorMessage(Object error) {
    return error
        .toString()
        .replaceFirst('Bad state: ', '')
        .replaceFirst('Exception: ', '');
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        return Scaffold(
          appBar: SysAppBar(
            title: const Text('消息通知'),
            actions: [
              if (controller.unreadCount > 0)
                TextButton(
                  onPressed: () => controller.markAllRead(),
                  child: const Text('全部已读'),
                ),
            ],
          ),
          body: !AniWorldApi.isLoggedIn
              ? _buildLoginHint()
              : DefaultTabController(
                  length: 2,
                  child: Column(
                    children: [
                      Material(
                        color: Theme.of(context).colorScheme.surface,
                        child: const TabBar(
                          tabs: [
                            Tab(text: '谁赞了我'),
                            Tab(text: '谁回复了我'),
                          ],
                        ),
                      ),
                      Expanded(
                        child: TabBarView(
                          children: [
                            _buildNotificationList(controller.likes, true),
                            _buildNotificationList(controller.replies, false),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
        );
      },
    );
  }

  Widget _buildLoginHint() {
    return Center(
      child: Text(
        '登录后可以查看评论互动消息',
        style: TextStyle(color: Theme.of(context).colorScheme.outline),
      ),
    );
  }

  Widget _buildNotificationList(
    List<CommentNotification> notifications,
    bool isLike,
  ) {
    if (controller.isLoading && notifications.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (notifications.isEmpty) {
      return RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            SizedBox(height: MediaQuery.sizeOf(context).height * 0.22),
            Icon(
              isLike ? Icons.thumb_up_alt_outlined : Icons.reply_outlined,
              size: 64,
              color:
                  Theme.of(context).colorScheme.outline.withValues(alpha: 0.5),
            ),
            const SizedBox(height: 14),
            Text(
              isLike ? '暂时没有点赞消息' : '暂时没有回复消息',
              textAlign: TextAlign.center,
              style: TextStyle(color: Theme.of(context).colorScheme.outline),
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView.separated(
        physics: const AlwaysScrollableScrollPhysics(
          parent: BouncingScrollPhysics(),
        ),
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 28),
        itemCount: notifications.length,
        separatorBuilder: (_, __) => const SizedBox(height: 8),
        itemBuilder: (context, index) =>
            _buildNotification(notifications[index]),
      ),
    );
  }

  Widget _buildNotification(CommentNotification notification) {
    final colors = Theme.of(context).colorScheme;
    final avatar = AniWorldApi.resolveAvatar(notification.actor.avatar.large);
    final actionText = notification.isLike ? '赞了你的评论' : '回复了你的评论';
    final detail = notification.isLike
        ? notification.targetContent
        : notification.eventContent;
    final episode = notification.episodeNumber.isEmpty
        ? ''
        : '第${notification.episodeNumber}集';
    final metadata = [
      if (notification.animeTitle.isNotEmpty) notification.animeTitle,
      if (episode.isNotEmpty) episode,
      _formatDate(notification.createdAt),
    ].join(' · ');

    return Container(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 12),
      decoration: BoxDecoration(
        color: notification.isRead
            ? colors.surfaceContainerHighest.withValues(alpha: 0.42)
            : colors.primaryContainer.withValues(alpha: 0.26),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _avatar(avatar),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                RichText(
                  text: TextSpan(
                    style: TextStyle(color: colors.onSurface, fontSize: 14),
                    children: [
                      TextSpan(
                        text: notification.actor.nickname,
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                      TextSpan(text: ' $actionText'),
                    ],
                  ),
                ),
                const SizedBox(height: 8),
                Container(
                  width: double.infinity,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  decoration: BoxDecoration(
                    color: colors.surface.withValues(alpha: 0.72),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    detail.isEmpty ? '该评论已删除' : detail,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ),
                const SizedBox(height: 7),
                Text(
                  metadata,
                  style: TextStyle(
                    fontSize: 12,
                    color: colors.outline,
                  ),
                ),
              ],
            ),
          ),
          if (!notification.isRead) ...[
            const SizedBox(width: 8),
            Padding(
              padding: const EdgeInsets.only(top: 5),
              child: Icon(Icons.circle, size: 8, color: colors.primary),
            ),
          ],
        ],
      ),
    );
  }

  Widget _avatar(ImageProvider? provider) {
    final fallback = CircleAvatar(
      backgroundColor: Theme.of(context).colorScheme.primaryContainer,
      child: Icon(
        Icons.person_rounded,
        color: Theme.of(context).colorScheme.onPrimaryContainer,
      ),
    );
    return ClipOval(
      child: SizedBox(
        width: 42,
        height: 42,
        child: provider == null
            ? fallback
            : Image(
                image: provider,
                fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => fallback),
      ),
    );
  }

  String _formatDate(int timestamp) {
    final date =
        DateTime.fromMillisecondsSinceEpoch(timestamp * 1000).toLocal();
    String pad(int value) => value.toString().padLeft(2, '0');
    return '${date.year}-${pad(date.month)}-${pad(date.day)} '
        '${pad(date.hour)}:${pad(date.minute)}';
  }
}
