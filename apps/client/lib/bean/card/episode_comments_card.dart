import 'package:flutter/material.dart';
import 'package:kazumi/bbcode/bbcode_widget.dart';
import 'package:kazumi/modules/comments/comment_item.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';

class EpisodeCommentsCard extends StatelessWidget {
  const EpisodeCommentsCard({
    super.key,
    required this.commentItem,
    this.onReaction,
    this.onReply,
    this.onDelete,
    this.repliesExpanded = false,
    this.replyPage = 1,
    this.replyPageCount = 1,
    this.repliesLoading = false,
    this.onToggleReplies,
    this.onReplyPageChanged,
  });

  final EpisodeCommentItem commentItem;
  final Future<void> Function(int commentId, int reaction)? onReaction;
  final void Function(int commentId, String nickname)? onReply;
  final Future<void> Function(int commentId)? onDelete;
  final bool repliesExpanded;
  final int replyPage;
  final int replyPageCount;
  final bool repliesLoading;
  final VoidCallback? onToggleReplies;
  final Future<void> Function(int rootCommentId, int page)? onReplyPageChanged;

  ImageProvider? _avatarProvider(String avatar) {
    return AniWorldApi.resolveAvatar(avatar.trim());
  }

  Widget _avatar(BuildContext context, User user, {double size = 40}) {
    final provider = _avatarProvider(user.avatar.large);
    final fallback = Container(
      color: Theme.of(context).colorScheme.primaryContainer,
      alignment: Alignment.center,
      child: Icon(
        Icons.person_rounded,
        size: size * .62,
        color: Theme.of(context).colorScheme.onPrimaryContainer,
      ),
    );
    return ClipOval(
      child: SizedBox(
        width: size,
        height: size,
        child: provider == null
            ? fallback
            : Image(
                image: provider,
                fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => fallback,
              ),
      ),
    );
  }

  String _commentDate(int timestamp) {
    final date =
        DateTime.fromMillisecondsSinceEpoch(timestamp * 1000).toLocal();
    String pad(int value) => value.toString().padLeft(2, '0');
    return '${date.year}-${pad(date.month)}-${pad(date.day)} '
        '${pad(date.hour)}:${pad(date.minute)}';
  }

  Widget _actionButton(
    BuildContext context, {
    required IconData icon,
    required Color color,
    String? label,
    required VoidCallback? onTap,
  }) {
    final muted = Theme.of(context).colorScheme.onSurfaceVariant;
    return InkWell(
      borderRadius: BorderRadius.circular(6),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 3),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 18, color: onTap == null ? muted : color),
            if (label != null) ...[
              const SizedBox(width: 3),
              Text(
                label,
                style: TextStyle(
                  fontSize: 12,
                  color: onTap == null ? muted : color,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _commentBody(
    BuildContext context,
    EpisodeComment comment, {
    required bool root,
  }) {
    final colors = Theme.of(context).colorScheme;
    final canInteract = comment.id > 0;
    final nextLike = comment.myReaction == 1 ? 0 : 1;
    final nextDislike = comment.myReaction == -1 ? 0 : -1;

    return Padding(
      padding: EdgeInsets.only(left: root ? 0 : 48, top: root ? 0 : 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!root)
            Divider(
              height: 1,
              color: colors.outlineVariant.withAlpha(80),
            ),
          const SizedBox(height: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _avatar(context, comment.user, size: root ? 40 : 32),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  comment.user.nickname,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: root ? 14 : 13,
                    color: colors.onSurfaceVariant,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
              if (!comment.isDeleted && comment.canDelete && onDelete != null)
                PopupMenuButton<String>(
                  tooltip: '更多操作',
                  padding: EdgeInsets.zero,
                  icon: Icon(
                    Icons.more_horiz,
                    size: 20,
                    color: colors.onSurfaceVariant,
                  ),
                  onSelected: (value) {
                    if (value == 'delete') onDelete!(comment.id);
                  },
                  itemBuilder: (context) => const [
                    PopupMenuItem<String>(
                      value: 'delete',
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.delete_outline),
                          SizedBox(width: 8),
                          Text('删除评论'),
                        ],
                      ),
                    ),
                  ],
                ),
            ],
          ),
          const SizedBox(height: 7),
          Padding(
            padding: EdgeInsets.only(left: root ? 48 : 40),
            child: comment.isDeleted
                ? Text(
                    '该评论已删除',
                    style: TextStyle(
                      fontSize: 13,
                      color: colors.onSurfaceVariant,
                      fontStyle: FontStyle.italic,
                    ),
                  )
                : BBCodeWidget(bbcode: comment.comment),
          ),
          Padding(
            padding: EdgeInsets.only(left: root ? 43 : 35, top: 8),
            child: Row(
              children: [
                Text(
                  _commentDate(comment.createdAt),
                  style: TextStyle(
                    fontSize: 12,
                    color: colors.onSurfaceVariant,
                  ),
                ),
                if (!comment.isDeleted) ...[
                  const SizedBox(width: 8),
                  _actionButton(
                    context,
                    icon: comment.myReaction == 1
                        ? Icons.thumb_up
                        : Icons.thumb_up_outlined,
                    color: comment.myReaction == 1
                        ? colors.primary
                        : colors.onSurfaceVariant,
                    label: '${comment.likeCount}',
                    onTap: canInteract && onReaction != null
                        ? () => onReaction!(comment.id, nextLike)
                        : null,
                  ),
                  _actionButton(
                    context,
                    icon: comment.myReaction == -1
                        ? Icons.thumb_down
                        : Icons.thumb_down_outlined,
                    color: comment.myReaction == -1
                        ? colors.primary
                        : colors.onSurfaceVariant,
                    onTap: canInteract && onReaction != null
                        ? () => onReaction!(comment.id, nextDislike)
                        : null,
                  ),
                  _actionButton(
                    context,
                    icon: Icons.reply_outlined,
                    color: colors.onSurfaceVariant,
                    label: '回复',
                    onTap: canInteract && onReply != null
                        ? () => onReply!(comment.id, comment.user.nickname)
                        : null,
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final replies = commentItem.replies;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _commentBody(
            context,
            commentItem.comment,
            root: true,
          ),
          if (!repliesExpanded && commentItem.replyCount > 0)
            Padding(
              padding: const EdgeInsets.only(left: 48, top: 8),
              child: InkWell(
                borderRadius: BorderRadius.circular(6),
                onTap: onToggleReplies,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
                  child: Text(
                    '共${commentItem.replyCount}条回复，点击查看',
                    style: TextStyle(
                      fontSize: 12,
                      color: Theme.of(context).colorScheme.primary,
                    ),
                  ),
                ),
              ),
            ),
          if (repliesExpanded) ...[
            if (repliesLoading)
              const Padding(
                padding: EdgeInsets.fromLTRB(48, 14, 0, 8),
                child: SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            ...replies.map(
              (reply) => _commentBody(
                context,
                reply,
                root: false,
              ),
            ),
            if (!repliesLoading)
              Padding(
                padding: const EdgeInsets.only(left: 44, top: 8),
                child: Row(
                  children: [
                    Text(
                      '共${replyPageCount}页',
                      style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                      decoration: BoxDecoration(
                        color: Theme.of(context).colorScheme.primary,
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        '$replyPage',
                        style: TextStyle(
                          fontSize: 12,
                          color: Theme.of(context).colorScheme.onPrimary,
                        ),
                      ),
                    ),
                    if (replyPage > 1)
                      TextButton(
                        onPressed: onReplyPageChanged == null
                            ? null
                            : () => onReplyPageChanged!(
                                  commentItem.comment.id,
                                  replyPage - 1,
                                ),
                        child: const Text('上一页'),
                      ),
                    if (replyPage < replyPageCount)
                      TextButton(
                        onPressed: onReplyPageChanged == null
                            ? null
                            : () => onReplyPageChanged!(
                                  commentItem.comment.id,
                                  replyPage + 1,
                                ),
                        child: const Text('下一页'),
                      ),
                    TextButton(
                      onPressed: onToggleReplies,
                      child: const Text('收起'),
                    ),
                  ],
                ),
              ),
          ],
          Divider(
            height: 20,
            color: Theme.of(context).colorScheme.outlineVariant.withAlpha(90),
          ),
        ],
      ),
    );
  }
}
