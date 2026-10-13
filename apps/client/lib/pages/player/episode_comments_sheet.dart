import 'dart:math';
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter_mobx/flutter_mobx.dart';
import 'package:kazumi/bean/dialog/dialog_helper.dart';
import 'package:kazumi/bean/card/episode_comments_card.dart';
import 'package:kazumi/bean/widget/error_widget.dart';
import 'package:kazumi/modules/comments/comment_item.dart';
import 'package:kazumi/modules/bangumi/episode_item.dart';
import 'package:kazumi/pages/video/video_controller.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';
import 'package:kazumi/request/apis/bangumi_api.dart';

class EpisodeInfoWidget extends InheritedWidget {
  const EpisodeInfoWidget(
      {super.key, required this.episode, required super.child});

  final int episode;

  @override
  bool updateShouldNotify(covariant InheritedWidget oldWidget) => true;

  static EpisodeInfoWidget? of(BuildContext context) {
    return context.dependOnInheritedWidgetOfExactType<EpisodeInfoWidget>();
  }
}

class EpisodeCommentsSheet extends StatefulWidget {
  const EpisodeCommentsSheet({
    super.key,
    required this.videoPageController,
  });

  final VideoPageController videoPageController;

  @override
  State<EpisodeCommentsSheet> createState() => _EpisodeCommentsSheetState();
}

class _EpisodeCommentsSheetState extends State<EpisodeCommentsSheet> {
  late final VideoPageController videoPageController =
      widget.videoPageController;
  bool commentsQueryTimeout = false;
  bool commentsIsEmpty = false;
  bool commentsIsLoading = false;
  bool postingComment = false;
  List<EpisodeCommentItem> siteComments = [];
  final TextEditingController commentController = TextEditingController();
  final FocusNode commentFocusNode = FocusNode();
  final GlobalKey<RefreshIndicatorState> _refreshIndicatorKey =
      GlobalKey<RefreshIndicatorState>();
  final Set<int> reactingCommentIds = <int>{};
  final Set<int> deletingCommentIds = <int>{};
  final Set<int> expandedCommentIds = <int>{};
  final Set<int> loadingReplyIds = <int>{};
  final Map<int, int> replyPages = <int, int>{};
  final Map<int, int> replyPageCounts = <int, int>{};

  int? replyingToCommentId;
  String? replyingToNickname;

  int ep = 0;

  int get activeEpisode {
    final inherited = EpisodeInfoWidget.of(context)?.episode ?? 1;
    final selected = ep == 0 ? inherited : ep;
    return max(1, selected);
  }

  String get activeEpisodeTitle {
    final episode = activeEpisode;
    final roadIndex = videoPageController.selectedEpisode.road;
    if (roadIndex >= 0 && roadIndex < videoPageController.roadList.length) {
      final road = videoPageController.roadList[roadIndex];
      final idx = episode - 1;
      if (idx >= 0 && idx < road.identifier.length) {
        final name = road.identifier[idx].trim();
        if (name.isNotEmpty) return name;
      }
    }
    return '第${episode.toString().padLeft(2, '0')}集';
  }

  Future<void> loadComments(int episode) async {
    commentsQueryTimeout = false;
    commentsIsEmpty = false;
    commentsIsLoading = true;
    try {
      final list = await AniWorldApi.getEpisodeComments(
        item: videoPageController.bangumiItem,
        episode: episode,
      );
      if (!mounted) return;
      setState(() {
        siteComments = list;
        expandedCommentIds.clear();
        loadingReplyIds.clear();
        replyPages.clear();
        replyPageCounts.clear();
      });
      if (siteComments.isEmpty) {
        setState(() {
          commentsIsEmpty = true;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          commentsQueryTimeout = true;
        });
      }
    }
    if (mounted) {
      setState(() {
        commentsIsLoading = false;
      });
    }
  }

  Future<void> submitComment() async {
    final content = commentController.text.trim();
    if (content.isEmpty || postingComment) return;
    if (!AniWorldApi.isLoggedIn) {
      KazumiDialog.showToast(message: '请先登录后再发表评论');
      return;
    }
    setState(() => postingComment = true);
    try {
      final episode = activeEpisode;
      final msg = await AniWorldApi.postEpisodeComment(
        item: videoPageController.bangumiItem,
        episode: episode,
        content: content,
        parentId: replyingToCommentId,
      );
      commentController.clear();
      if (mounted) {
        setState(() {
          replyingToCommentId = null;
          replyingToNickname = null;
        });
      }
      KazumiDialog.showToast(message: msg);
      await loadComments(episode);
    } catch (e) {
      final msg = e
          .toString()
          .replaceFirst('Bad state: ', '')
          .replaceFirst('Exception: ', '');
      KazumiDialog.showToast(message: msg.isEmpty ? '评论发送失败' : msg);
    } finally {
      if (mounted) setState(() => postingComment = false);
    }
  }

  void toggleSortOrder() {
    videoPageController.toggleSortOrder();
  }

  Future<void> _loadReplies(int rootCommentId, int page) async {
    if (loadingReplyIds.contains(rootCommentId)) return;
    setState(() => loadingReplyIds.add(rootCommentId));
    try {
      final result = await AniWorldApi.getEpisodeCommentReplies(
        commentId: rootCommentId,
        page: page,
        limit: 10,
      );
      if (!mounted) return;
      final index = siteComments.indexWhere(
        (item) => item.comment.id == rootCommentId,
      );
      if (index < 0) return;
      setState(() {
        siteComments[index] = siteComments[index].copyWith(
          replies: result.replies,
          replyCount: result.total,
        );
        replyPages[rootCommentId] = result.page;
        replyPageCounts[rootCommentId] = result.totalPages;
      });
    } catch (e) {
      if (mounted) {
        KazumiDialog.showToast(message: '回复加载失败');
      }
    } finally {
      if (mounted) setState(() => loadingReplyIds.remove(rootCommentId));
    }
  }

  Future<void> _toggleReplies(int rootCommentId) async {
    if (expandedCommentIds.contains(rootCommentId)) {
      setState(() => expandedCommentIds.remove(rootCommentId));
      return;
    }
    setState(() => expandedCommentIds.add(rootCommentId));
    await _loadReplies(rootCommentId, 1);
  }

  void _replaceCommentReaction(
    int commentId,
    Map<String, int> reaction,
  ) {
    siteComments = siteComments.map((item) {
      if (item.comment.id == commentId) {
        return item.copyWith(
          comment: item.comment.copyWith(
            likeCount: reaction['likes'],
            dislikeCount: reaction['dislikes'],
            myReaction: reaction['myReaction'],
          ),
        );
      }
      final replies = item.replies.map((reply) {
        if (reply.id != commentId) return reply;
        return reply.copyWith(
          likeCount: reaction['likes'],
          dislikeCount: reaction['dislikes'],
          myReaction: reaction['myReaction'],
        );
      }).toList();
      return item.copyWith(replies: replies);
    }).toList();
  }

  Future<void> _handleReaction(int commentId, int reaction) async {
    if (!AniWorldApi.isLoggedIn) {
      KazumiDialog.showToast(message: '请先登录后再操作评论');
      return;
    }
    if (reactingCommentIds.contains(commentId)) return;
    setState(() => reactingCommentIds.add(commentId));
    try {
      final result = await AniWorldApi.reactToEpisodeComment(
        commentId: commentId,
        reaction: reaction,
      );
      if (mounted) {
        setState(() => _replaceCommentReaction(commentId, result));
      }
    } catch (e) {
      final msg = e
          .toString()
          .replaceFirst('Bad state: ', '')
          .replaceFirst('Exception: ', '');
      if (mounted) {
        KazumiDialog.showToast(message: msg.isEmpty ? '操作失败' : msg);
      }
    } finally {
      if (mounted) setState(() => reactingCommentIds.remove(commentId));
    }
  }

  List<EpisodeCommentItem> _removeComment(
    List<EpisodeCommentItem> items,
    int commentId,
  ) {
    return items
        .where((item) => item.comment.id != commentId)
        .map(
          (item) {
            final nextReplies = item.replies
                .where((reply) => reply.id != commentId)
                .toList();
            final removedReply = nextReplies.length != item.replies.length;
            return item.copyWith(
              replies: nextReplies,
              replyCount: removedReply
                  ? max(0, item.replyCount - 1)
                  : item.replyCount,
            );
          },
        )
        .toList();
  }

  Future<void> _handleDelete(int commentId) async {
    if (!AniWorldApi.isLoggedIn || deletingCommentIds.contains(commentId)) {
      return;
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('删除评论'),
        content: const Text('删除后将保留评论楼层，但该评论下的所有回复都会隐藏。确定删除吗？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => deletingCommentIds.add(commentId));
    try {
      await AniWorldApi.deleteEpisodeComment(commentId: commentId);
      if (mounted) {
        setState(() {
          siteComments = _removeComment(siteComments, commentId);
        });
      }
      KazumiDialog.showToast(message: '评论已删除');
    } catch (e) {
      final msg = e
          .toString()
          .replaceFirst('Bad state: ', '')
          .replaceFirst('Exception: ', '');
      if (mounted) {
        KazumiDialog.showToast(message: msg.isEmpty ? '删除失败' : msg);
      }
    } finally {
      if (mounted) setState(() => deletingCommentIds.remove(commentId));
    }
  }

  void _startReply(int commentId, String nickname) {
    if (!AniWorldApi.isLoggedIn) {
      KazumiDialog.showToast(message: '请先登录后再回复');
      return;
    }
    setState(() {
      replyingToCommentId = commentId;
      replyingToNickname = nickname;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) commentFocusNode.requestFocus();
    });
  }

  void _cancelReply() {
    setState(() {
      replyingToCommentId = null;
      replyingToNickname = null;
    });
  }

  @override
  void didChangeDependencies() {
    ep = 0;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) {
        return;
      }
      if (siteComments.isEmpty) {
        _refreshIndicatorKey.currentState?.show();
      }
    });
    super.didChangeDependencies();
  }

  @override
  void dispose() {
    commentController.dispose();
    commentFocusNode.dispose();
    super.dispose();
  }

  Widget get episodeCommentsBody {
    return CustomScrollView(
      scrollBehavior: const ScrollBehavior().copyWith(
        scrollbars: false,
        dragDevices: {
          PointerDeviceKind.mouse,
          PointerDeviceKind.touch,
          PointerDeviceKind.trackpad
        },
      ),
      slivers: [
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 4),
          sliver: Observer(builder: (context) {
            if (commentsQueryTimeout) {
              return SliverFillRemaining(
                child: GeneralErrorWidget(
                  errMsg: '评论获取失败',
                  actions: [
                    GeneralErrorButton(
                      onPressed: () {
                        _refreshIndicatorKey.currentState?.show();
                      },
                      text: '重试',
                    ),
                  ],
                ),
              );
            }
            if (commentsIsLoading) {
              return const SliverFillRemaining(
                child: Center(child: CircularProgressIndicator()),
              );
            }
            if (commentsIsEmpty) {
              return const SliverFillRemaining(
                child: Center(
                  child: Text('还没有评论，来发第一条吧'),
                ),
              );
            }
            return SliverList(
              delegate: SliverChildBuilderDelegate(
                (context, index) {
                  // Keep loaded image cards alive to avoid scroll jumps when
                  // network images report their final size.
                  return KeepAlive(
                    keepAlive: true,
                    child: IndexedSemantics(
                      index: index,
                      child: EpisodeCommentsCard(
                        commentItem: siteComments[index],
                        onReaction: _handleReaction,
                        onReply: _startReply,
                        onDelete: _handleDelete,
                        repliesExpanded: expandedCommentIds.contains(
                          siteComments[index].comment.id,
                        ),
                        replyPage: replyPages[siteComments[index].comment.id] ?? 1,
                        replyPageCount: replyPageCounts[
                              siteComments[index].comment.id
                            ] ??
                            max(
                              1,
                              (siteComments[index].replyCount + 9) ~/ 10,
                            ),
                        repliesLoading: loadingReplyIds.contains(
                          siteComments[index].comment.id,
                        ),
                        onToggleReplies: () => _toggleReplies(
                          siteComments[index].comment.id,
                        ),
                        onReplyPageChanged: _loadReplies,
                      ),
                    ),
                  );
                },
                childCount: siteComments.length,
                addAutomaticKeepAlives: false,
                addRepaintBoundaries: false,
                addSemanticIndexes: false,
              ),
            );
          }),
        ),
      ],
    );
  }

  Widget get commentsInfo {
    return Padding(
      padding: const EdgeInsets.all(8),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          const Text(' 本集标题  '),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('ep.$activeEpisode $activeEpisodeTitle',
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(context).colorScheme.outline)),
                Text(videoPageController.title,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(context).colorScheme.outline)),
              ],
            ),
          ),
          const SizedBox(width: 10),
          SizedBox(
            height: 34,
            child: TextButton(
              style: ButtonStyle(
                padding: WidgetStateProperty.all(
                    const EdgeInsets.only(left: 4.0, right: 4.0)),
              ),
              onPressed: () {
                showEpisodeSelection();
              },
              child: const Text(
                '手动切换',
                style: TextStyle(fontSize: 13),
              ),
            ),
          ),
          SizedBox(
            height: 34,
            child: TextButton(
              style: ButtonStyle(
                padding: WidgetStateProperty.all(
                    const EdgeInsets.symmetric(horizontal: 4.0)),
              ),
              onPressed: toggleSortOrder,
              child: Observer(builder: (context) {
                return Text(
                  videoPageController.isCommentsAscending ? '倒序' : '正序',
                  style: const TextStyle(fontSize: 13),
                );
              }),
            ),
          ),
        ],
      ),
    );
  }

  void showEpisodeSelection() async {
    final int selectedEpisode = activeEpisode;
    KazumiDialog.showLoading(msg: '正在加载剧集...');
    final List<EpisodeInfo> episodeList =
        await BangumiApi.getBangumiEpisodesByID(
            videoPageController.bangumiItem.id);
    KazumiDialog.dismiss();
    if (!mounted) {
      return;
    }
    if (episodeList.isEmpty) {
      KazumiDialog.showToast(message: '没有找到剧集列表');
      return;
    }
    KazumiDialog.show(
      builder: (context) {
        return Dialog(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560, maxHeight: 520),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Padding(
                  padding: EdgeInsets.fromLTRB(24, 20, 24, 8),
                  child: Text('分集列表', style: TextStyle(fontSize: 20)),
                ),
                Flexible(
                  child: ListView.builder(
                    shrinkWrap: true,
                    itemCount: episodeList.length,
                    itemBuilder: (context, index) {
                      final episode = episodeList[index];
                      final episodeTitle = episode.nameCn.isNotEmpty
                          ? episode.nameCn
                          : episode.name;
                      final episodeText =
                          '${episode.readType()}.${episode.episode}';
                      final bool selected = index + 1 == selectedEpisode;
                      return ListTile(
                        selected: selected,
                        title: Text(
                          episodeTitle.isEmpty
                              ? episodeText
                              : '$episodeText $episodeTitle',
                          overflow: TextOverflow.ellipsis,
                        ),
                        onTap: () {
                          ep = index + 1;
                          _refreshIndicatorKey.currentState?.show();
                          KazumiDialog.dismiss();
                        },
                      );
                    },
                  ),
                ),
                Align(
                  alignment: Alignment.centerRight,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                    child: TextButton(
                      onPressed: () => KazumiDialog.dismiss(),
                      child: Text(
                        '取消',
                        style: TextStyle(
                            color: Theme.of(context).colorScheme.outline),
                      ),
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

  Widget get commentComposer {
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surface,
          border: Border(
            top: BorderSide(
              color: Theme.of(context).dividerColor.withAlpha(70),
            ),
          ),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (replyingToNickname != null)
              Row(
                children: [
                  Expanded(
                    child: Text(
                      '回复 @${replyingToNickname!}',
                      style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(context).colorScheme.primary,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: '取消回复',
                    visualDensity: VisualDensity.compact,
                    onPressed: _cancelReply,
                    icon: const Icon(Icons.close, size: 18),
                  ),
                ],
              ),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: commentController,
                    focusNode: commentFocusNode,
                    minLines: 1,
                    maxLines: 3,
                    decoration: InputDecoration(
                      hintText: AniWorldApi.isLoggedIn
                          ? (replyingToNickname == null ? '发表友善评论...' : '回复内容...')
                          : '登录后发表评论',
                      isDense: true,
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(999),
                      ),
                      contentPadding: const EdgeInsets.symmetric(
                          horizontal: 14, vertical: 10),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: postingComment ? null : submitComment,
                  child: postingComment
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('发送'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final int episode = EpisodeInfoWidget.of(context)!.episode;
    return Scaffold(
      body: RefreshIndicator(
        key: _refreshIndicatorKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            commentsInfo,
            Expanded(child: episodeCommentsBody),
            commentComposer,
          ],
        ),
        onRefresh: () async {
          await loadComments(ep == 0 ? episode : ep);
        },
      ),
    );
  }
}
