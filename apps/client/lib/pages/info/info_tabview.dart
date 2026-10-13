import 'dart:convert';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/bean/widget/error_widget.dart';
import 'package:kazumi/bean/card/comments_card.dart';
import 'package:kazumi/bean/card/character_card.dart';
import 'package:kazumi/bean/card/staff_card.dart';
import 'package:skeletonizer/skeletonizer.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/modules/comments/comment_item.dart';
import 'package:kazumi/modules/characters/character_item.dart';
import 'package:kazumi/modules/staff/staff_item.dart';
import 'package:kazumi/utils/anime_tag_localizer.dart';
import 'package:kazumi/utils/device.dart';

class InfoTabView extends StatefulWidget {
  const InfoTabView({
    super.key,
    required this.commentsQueryTimeout,
    required this.commentsIsEmpty,
    required this.charactersQueryTimeout,
    required this.charactersIsEmpty,
    required this.staffQueryTimeout,
    required this.staffIsEmpty,
    required this.tabController,
    required this.loadMoreComments,
    required this.loadCharacters,
    required this.loadStaff,
    required this.bangumiItem,
    required this.commentsList,
    required this.commentsIsLoading,
    this.onCommentsTabSelected,
    required this.characterList,
    required this.staffList,
    required this.isLoading,
  });

  final bool commentsQueryTimeout;
  final bool commentsIsEmpty;
  final bool commentsIsLoading;
  final VoidCallback? onCommentsTabSelected;
  final bool charactersQueryTimeout;
  final bool charactersIsEmpty;
  final bool staffQueryTimeout;
  final bool staffIsEmpty;
  final TabController tabController;
  final Future<void> Function({bool loadMore}) loadMoreComments;
  final Future<void> Function() loadCharacters;
  final Future<void> Function() loadStaff;
  final BangumiItem bangumiItem;
  final List<CommentItem> commentsList;
  final List<CharacterItem> characterList;
  final List<StaffFullItem> staffList;
  final bool isLoading;

  @override
  State<InfoTabView> createState() => _InfoTabViewState();
}

class _InfoTabViewState extends State<InfoTabView>
    with SingleTickerProviderStateMixin {
  final maxWidth = 950.0;
  bool fullIntro = false;
  bool fullTag = false;

  @override
  void initState() {
    super.initState();
    widget.tabController.addListener(_onTabChanged);
  }

  @override
  void dispose() {
    widget.tabController.removeListener(_onTabChanged);
    super.dispose();
  }

  void _onTabChanged() {
    return;
  }

  Widget get infoBody {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(16.0),
        child: SizedBox(
          width: MediaQuery.sizeOf(context).width > maxWidth
              ? maxWidth
              : MediaQuery.sizeOf(context).width - 32,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('简介', style: TextStyle(fontSize: 18)),
              const SizedBox(height: 8),
              // https://stackoverflow.com/questions/54091055/flutter-how-to-get-the-number-of-text-lines
              // only show expand button when line > 7
              LayoutBuilder(builder: (context, constraints) {
                final summary = widget.bangumiItem.summary.trim().isEmpty
                    ? '暂无简介'
                    : widget.bangumiItem.summary;
                final span = TextSpan(text: summary);
                final tp =
                    TextPainter(text: span, textDirection: TextDirection.ltr);
                tp.layout(maxWidth: constraints.maxWidth);
                final numLines = tp.computeLineMetrics().length;
                if (numLines > 7) {
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      SizedBox(
                        // make intro expandable
                        height: fullIntro ? null : 120,
                        width: MediaQuery.sizeOf(context).width > maxWidth
                            ? maxWidth
                            : MediaQuery.sizeOf(context).width - 32,
                        child: SelectableText(
                          summary,
                          textAlign: TextAlign.start,
                          scrollBehavior: const ScrollBehavior().copyWith(
                            scrollbars: false,
                          ),
                          scrollPhysics: NeverScrollableScrollPhysics(),
                          selectionHeightStyle: ui.BoxHeightStyle.max,
                        ),
                      ),
                      TextButton(
                        onPressed: () {
                          setState(() {
                            fullIntro = !fullIntro;
                          });
                        },
                        child: Text(fullIntro ? '加载更少' : '加载更多'),
                      ),
                    ],
                  );
                } else {
                  return SelectableText(
                    summary,
                    textAlign: TextAlign.start,
                    scrollPhysics: NeverScrollableScrollPhysics(),
                    selectionHeightStyle: ui.BoxHeightStyle.max,
                  );
                }
              }),
              if (widget.bangumiItem.tags.isNotEmpty) ...[
                const SizedBox(height: 16),
                Text('标签', style: TextStyle(fontSize: 18)),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8.0,
                  runSpacing: isDesktop() ? 8 : 0,
                  children: List<Widget>.generate(
                      fullTag || widget.bangumiItem.tags.length < 13
                          ? widget.bangumiItem.tags.length
                          : 13, (int index) {
                    if (!fullTag && index == 12) {
                      // make tag expandable
                      return ActionChip(
                        label: Text(
                          '更多 +',
                          style: TextStyle(
                              color: Theme.of(context).colorScheme.primary),
                        ),
                        onPressed: () {
                          setState(() {
                            fullTag = !fullTag;
                          });
                        },
                      );
                    }
                    return ActionChip(
                      label: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            localizeAnimeTag(
                              widget.bangumiItem.tags[index].name,
                            ),
                          ),
                          if (widget.bangumiItem.tags[index].count > 0) ...[
                            const Text(' '),
                            Text(
                              '${widget.bangumiItem.tags[index].count}',
                              style: TextStyle(
                                  color: Theme.of(context).colorScheme.primary),
                            ),
                          ],
                        ],
                      ),
                      onPressed: () {
                        final tagName = Uri.encodeComponent(
                            widget.bangumiItem.tags[index].name);
                        Modular.to.pushNamed('/search/$tagName');
                      },
                    );
                  }).toList(),
                )
              ]
            ],
          ),
        ),
      ),
    );
  }

  /// Bone for Skeleton Loader
  Widget get infoBodyBone {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(16.0),
        child: SizedBox(
          width: MediaQuery.sizeOf(context).width > maxWidth
              ? maxWidth
              : MediaQuery.sizeOf(context).width - 32,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Skeletonizer.zone(child: Bone.text(fontSize: 18, width: 50)),
              const SizedBox(height: 8),
              Skeletonizer.zone(child: Bone.multiText(lines: 7)),
              const SizedBox(height: 16),
              Skeletonizer.zone(child: Bone.text(fontSize: 18, width: 50)),
              const SizedBox(height: 8),
              if (widget.isLoading)
                Skeletonizer.zone(
                  child: Wrap(
                    spacing: 8.0,
                    runSpacing: 8.0,
                    children: List.generate(
                        4, (_) => Bone.button(uniRadius: 8, height: 32)),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget get commentsListBody {
    return Builder(
      builder: (BuildContext context) {
        return NotificationListener<ScrollEndNotification>(
          onNotification: (scrollEnd) {
            final metrics = scrollEnd.metrics;
            if (metrics.pixels >= metrics.maxScrollExtent - 200) {
              widget.loadMoreComments(loadMore: widget.commentsList.isNotEmpty);
            }
            return true;
          },
          child: CustomScrollView(
            scrollBehavior: const ScrollBehavior().copyWith(
              scrollbars: false,
            ),
            key: PageStorageKey<String>('吐槽'),
            slivers: <Widget>[
              SliverOverlapInjector(
                handle:
                    NestedScrollView.sliverOverlapAbsorberHandleFor(context),
              ),
              SliverLayoutBuilder(builder: (context, _) {
                final myInterest = widget.bangumiItem.interest;
                final showMyReview = !widget.commentsIsLoading &&
                    myInterest != null &&
                    myInterest.hasUserProfile &&
                    myInterest.hasReviewContent;
                final listItemCount =
                    widget.commentsList.length + (showMyReview ? 1 : 0);

                if (listItemCount > 0) {
                  return SliverList.separated(
                    addAutomaticKeepAlives: false,
                    itemCount: listItemCount,
                    itemBuilder: (context, index) {
                      final commentIndex = showMyReview ? index - 1 : index;
                      final myUser = myInterest?.user;
                      final card = showMyReview && index == 0 && myUser != null
                          ? CommentsCard.own(
                              commentItem: CommentItem(
                                user: myUser,
                                comment: Comment(
                                  rate: myInterest.rate,
                                  comment: myInterest.comment,
                                  updatedAt: myInterest.updatedAt,
                                ),
                              ),
                            )
                          : CommentsCard(
                              commentItem: widget.commentsList[commentIndex],
                            );
                      return SafeArea(
                        top: false,
                        bottom: false,
                        child: Center(
                          child: Padding(
                            padding:
                                const EdgeInsets.symmetric(horizontal: 16.0),
                            child: SizedBox(
                              width: MediaQuery.sizeOf(context).width > maxWidth
                                  ? maxWidth
                                  : MediaQuery.sizeOf(context).width - 32,
                              child: card,
                            ),
                          ),
                        ),
                      );
                    },
                    separatorBuilder: (BuildContext context, int index) {
                      return SafeArea(
                        top: false,
                        bottom: false,
                        child: Center(
                          child: Padding(
                            padding:
                                const EdgeInsets.symmetric(horizontal: 16.0),
                            child: SizedBox(
                              width: MediaQuery.sizeOf(context).width > maxWidth
                                  ? maxWidth
                                  : MediaQuery.sizeOf(context).width - 32,
                              child: Divider(
                                  thickness: 0.5, indent: 10, endIndent: 10),
                            ),
                          ),
                        ),
                      );
                    },
                  );
                }
                if (widget.commentsQueryTimeout) {
                  return SliverFillRemaining(
                    child: GeneralErrorWidget(
                      errMsg: '获取失败，请重试',
                      actions: [
                        GeneralErrorButton(
                          onPressed: () {
                            widget.loadMoreComments(
                                loadMore: widget.commentsList.isNotEmpty);
                          },
                          text: '重试',
                        ),
                      ],
                    ),
                  );
                }
                if (widget.commentsIsEmpty) {
                  return const SliverFillRemaining(
                    child: Center(
                      child: Text('什么都没有找到 (´;ω;`)'),
                    ),
                  );
                }
                return SliverList.builder(
                  itemCount: 4,
                  itemBuilder: (context, _) {
                    return SafeArea(
                      top: false,
                      bottom: false,
                      child: Center(
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: SizedBox(
                            width: MediaQuery.sizeOf(context).width > maxWidth
                                ? maxWidth
                                : MediaQuery.sizeOf(context).width - 32,
                            child: CommentsCard.bone(),
                          ),
                        ),
                      ),
                    );
                  },
                );
              })
            ],
          ),
        );
      },
    );
  }

  Widget get staffListBody {
    return Builder(
      builder: (BuildContext context) {
        return CustomScrollView(
          scrollBehavior: const ScrollBehavior().copyWith(
            scrollbars: false,
          ),
          key: PageStorageKey<String>('制作人员'),
          slivers: <Widget>[
            SliverOverlapInjector(
              handle: NestedScrollView.sliverOverlapAbsorberHandleFor(context),
            ),
            SliverLayoutBuilder(builder: (context, _) {
              if (widget.staffList.isNotEmpty) {
                return SliverList.builder(
                  itemCount: widget.staffList.length,
                  itemBuilder: (context, index) {
                    return Center(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 16.0),
                        child: SizedBox(
                          width: MediaQuery.sizeOf(context).width > maxWidth
                              ? maxWidth
                              : MediaQuery.sizeOf(context).width - 32,
                          child: StaffCard(
                            staffFullItem: widget.staffList[index],
                          ),
                        ),
                      ),
                    );
                  },
                );
              }
              if (widget.staffQueryTimeout) {
                return SliverFillRemaining(
                  child: GeneralErrorWidget(
                    errMsg: '获取失败，请重试',
                    actions: [
                      GeneralErrorButton(
                        onPressed: () {
                          widget.loadStaff();
                        },
                        text: '重试',
                      ),
                    ],
                  ),
                );
              }
              if (widget.staffIsEmpty) {
                return const SliverFillRemaining(
                  child: Center(
                    child: Text('什么都没有找到 (´;ω;`)'),
                  ),
                );
              }
              return SliverList.builder(
                itemCount: 8,
                itemBuilder: (context, _) {
                  return Align(
                    alignment: Alignment.topCenter,
                    child: SizedBox(
                      width: MediaQuery.sizeOf(context).width > maxWidth
                          ? maxWidth
                          : MediaQuery.sizeOf(context).width - 32,
                      child: Skeletonizer.zone(
                        child: ListTile(
                          leading: Bone.circle(size: 36),
                          title: Bone.text(width: 100),
                          subtitle: Bone.text(width: 80),
                        ),
                      ),
                    ),
                  );
                },
              );
            }),
          ],
        );
      },
    );
  }

  Widget get charactersListBody {
    return Builder(
      builder: (BuildContext context) {
        return CustomScrollView(
          scrollBehavior: const ScrollBehavior().copyWith(
            scrollbars: false,
          ),
          key: PageStorageKey<String>('角色'),
          slivers: <Widget>[
            SliverOverlapInjector(
              handle: NestedScrollView.sliverOverlapAbsorberHandleFor(context),
            ),
            SliverLayoutBuilder(builder: (context, _) {
              if (widget.characterList.isNotEmpty) {
                return SliverList.builder(
                  itemCount: widget.characterList.length,
                  itemBuilder: (context, index) {
                    return Center(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 16.0),
                        child: SizedBox(
                          width: MediaQuery.sizeOf(context).width > maxWidth
                              ? maxWidth
                              : MediaQuery.sizeOf(context).width - 32,
                          child: CharacterCard(
                            characterItem: widget.characterList[index],
                          ),
                        ),
                      ),
                    );
                  },
                );
              }
              if (widget.charactersQueryTimeout) {
                return SliverFillRemaining(
                  child: GeneralErrorWidget(
                    errMsg: '获取失败，请重试',
                    actions: [
                      GeneralErrorButton(
                        onPressed: () {
                          widget.loadCharacters();
                        },
                        text: '重试',
                      ),
                    ],
                  ),
                );
              }
              if (widget.charactersIsEmpty) {
                return const SliverFillRemaining(
                  child: Center(
                    child: Text('什么都没有找到 (´;ω;`)'),
                  ),
                );
              }
              return SliverList.builder(
                itemCount: 4,
                itemBuilder: (context, _) {
                  return Align(
                    alignment: Alignment.topCenter,
                    child: SizedBox(
                      width: MediaQuery.sizeOf(context).width > maxWidth
                          ? maxWidth
                          : MediaQuery.sizeOf(context).width - 32,
                      child: Skeletonizer.zone(
                        child: ListTile(
                          leading: Bone.circle(size: 36),
                          title: Bone.text(width: 100),
                          subtitle: Bone.text(width: 80),
                        ),
                      ),
                    ),
                  );
                },
              );
            }),
          ],
        );
      },
    );
  }

  Map<String, dynamic> get _infoJson {
    try {
      final data = jsonDecode(widget.bangumiItem.info);
      if (data is Map<String, dynamic>) return data;
      if (data is Map) return Map<String, dynamic>.from(data);
    } catch (_) {}
    return const {};
  }

  String get _statusText {
    final info = _infoJson;
    final nextEpisode = int.tryParse('${info['nextAiringEpisode'] ?? 0}') ?? 0;
    final nextAt = int.tryParse('${info['nextAiringAt'] ?? 0}') ?? 0;
    if (nextEpisode > 0 || nextAt > 0) return '连载更新中';

    final airDate = DateTime.tryParse(widget.bangumiItem.airDate);
    if (airDate != null && airDate.isAfter(DateTime.now())) return '未开播';

    final status =
        '${info['aniStatus'] ?? info['status'] ?? ''}'.trim().toUpperCase();
    if (status == 'FINISHED') return '已完结';
    if (status == 'RELEASING') return '连载更新中';
    if (status == 'NOT_YET_RELEASED') return '未开播';
    if (status == 'CANCELLED') return '已取消';
    if (status == 'HIATUS') return '暂停更新';
    if (status.contains('更新') || status.contains('连载')) return '连载更新中';
    if (status.contains('完结') || status.contains('完結')) return '已完结';
    return status.isEmpty ? '暂无明确状态' : status;
  }

  Widget get playbackStatusBody {
    final info = _infoJson;
    final episodes = '${info['episodes'] ?? info['ji'] ?? ''}'.trim();
    final totalEpisodes = int.tryParse(episodes);
    final releasedEpisodes =
        int.tryParse('${info['releasedEpisodes'] ?? 0}') ?? 0;
    final nextEpisode = '${info['nextAiringEpisode'] ?? ''}'.trim();
    final nextAt = int.tryParse('${info['nextAiringAt'] ?? 0}') ?? 0;
    final nextDate =
        nextAt > 0 ? DateTime.fromMillisecondsSinceEpoch(nextAt * 1000) : null;
    final rows = <({IconData icon, String label, String value})>[
      (icon: Icons.live_tv_rounded, label: '播放状态', value: _statusText),
      if (episodes.isNotEmpty)
        (
          icon: Icons.format_list_numbered_rounded,
          label: '总集数',
          value: totalEpisodes != null && totalEpisodes > 0
              ? '$totalEpisodes集'
              : '待公布'
        ),
      if (releasedEpisodes > 0 &&
          (totalEpisodes == null || releasedEpisodes < totalEpisodes))
        (
          icon: Icons.playlist_play_rounded,
          label: '已更新',
          value: '$releasedEpisodes集'
        ),
      if (nextEpisode.isNotEmpty)
        (icon: Icons.update_rounded, label: '下一集', value: '第$nextEpisode集'),
      if (nextDate != null)
        (
          icon: Icons.schedule_rounded,
          label: '预计更新',
          value:
              '${nextDate.year}-${nextDate.month.toString().padLeft(2, '0')}-${nextDate.day.toString().padLeft(2, '0')} ${nextDate.hour.toString().padLeft(2, '0')}:${nextDate.minute.toString().padLeft(2, '0')}'
        ),
    ];
    return Builder(builder: (context) {
      return CustomScrollView(
        scrollBehavior: const ScrollBehavior().copyWith(scrollbars: false),
        key: const PageStorageKey<String>('playbackStatus'),
        slivers: [
          SliverOverlapInjector(
            handle: NestedScrollView.sliverOverlapAbsorberHandleFor(context),
          ),
          SliverToBoxAdapter(
            child: SafeArea(
              top: false,
              bottom: false,
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: SizedBox(
                    width: MediaQuery.sizeOf(context).width > maxWidth
                        ? maxWidth
                        : MediaQuery.sizeOf(context).width - 32,
                    child: Column(
                      children: rows
                          .map(
                            (row) => Card(
                              child: ListTile(
                                leading: Icon(row.icon),
                                title: Text(row.label),
                                trailing: Text(
                                  row.value,
                                  style: const TextStyle(
                                      fontWeight: FontWeight.w700),
                                ),
                              ),
                            ),
                          )
                          .toList(),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    return TabBarView(
      controller: widget.tabController,
      children: [
        Builder(
          // This Builder is needed to provide a BuildContext that is
          // "inside" the NestedScrollView, so that
          // sliverOverlapAbsorberHandleFor() can find the
          // NestedScrollView.
          builder: (BuildContext context) {
            return CustomScrollView(
              scrollBehavior: const ScrollBehavior().copyWith(
                scrollbars: false,
              ),
              // The PageStorageKey should be unique to this ScrollView;
              // it allows the list to remember its scroll position when
              // the tab view is not on the screen.
              key: PageStorageKey<String>('概览'),
              slivers: <Widget>[
                SliverOverlapInjector(
                  handle:
                      NestedScrollView.sliverOverlapAbsorberHandleFor(context),
                ),
                SliverToBoxAdapter(
                  child: SafeArea(
                    top: false,
                    bottom: false,
                    child: widget.isLoading ? infoBodyBone : infoBody,
                  ),
                ),
              ],
            );
          },
        ),
        charactersListBody,
        staffListBody,
        playbackStatusBody,
      ],
    );
  }
}
