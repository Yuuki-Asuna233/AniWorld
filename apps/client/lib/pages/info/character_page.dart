import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:kazumi/modules/character/character_full_item.dart';
import 'package:kazumi/modules/comments/comment_item.dart';
import 'package:kazumi/request/apis/bangumi_api.dart';
import 'package:kazumi/bean/card/network_img_layer.dart';
import 'package:kazumi/bean/card/character_comments_card.dart';
import 'package:kazumi/bean/widget/error_widget.dart';
import 'package:kazumi/bean/widget/image_preview.dart';

class CharacterPage extends StatefulWidget {
  const CharacterPage({
    super.key,
    required this.characterID,
    this.relation = '',
  });

  final int characterID;
  final String relation;

  @override
  State<CharacterPage> createState() => _CharacterPageState();
}

class _CharacterPageState extends State<CharacterPage> {
  CharacterFullItem characterFullItem = CharacterFullItem.fromTemplate();
  bool loadingCharacter = true;
  List<CharacterCommentItem> commentsList = [];
  bool loadingComments = true;
  bool commentsError = false;

  Future<void> loadCharacter() async {
    setState(() {
      loadingCharacter = true;
    });
    await BangumiApi.getCharacterByCharacterID(widget.characterID)
        .then((character) {
      characterFullItem = character;
    });
    if (mounted) {
      setState(() {
        loadingCharacter = false;
      });
    }
  }

  Future<void> loadComments() async {
    setState(() {
      loadingComments = true;
      commentsError = false;
    });
    try {
      final value = await BangumiApi.getCharacterCommentsByCharacterID(
          widget.characterID);
      commentsList = value.commentList;
    } catch (e) {
      if (mounted) {
        setState(() {
          commentsError = true;
        });
      }
    }
    if (mounted) {
      setState(() {
        loadingComments = false;
      });
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      loadCharacter();
      loadComments();
    });
  }

  @override
  Widget build(BuildContext context) {
    final title = loadingCharacter || characterFullItem.id == 0
        ? '角色资料'
        : characterFullItem.name;
    final subtitle = widget.relation.isNotEmpty
        ? widget.relation
        : characterFullItem.nameCN;
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.surface,
      child: DefaultTabController(
        length: 2,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 8, 6),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context)
                              .textTheme
                              .headlineSmall
                              ?.copyWith(fontWeight: FontWeight.w700),
                        ),
                        if (subtitle.isNotEmpty) ...[
                          const SizedBox(height: 4),
                          Text(
                            subtitle,
                            style: Theme.of(context)
                                .textTheme
                                .titleMedium
                                ?.copyWith(color: colors.onSurfaceVariant),
                          ),
                        ],
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: '关闭',
                    onPressed: () => Navigator.of(context).maybePop(),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
            ),
            Container(
              margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
              padding: const EdgeInsets.all(4),
              decoration: BoxDecoration(
                color: colors.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(20),
              ),
              child: TabBar(
                dividerColor: Colors.transparent,
                indicatorSize: TabBarIndicatorSize.tab,
                indicator: BoxDecoration(
                  color: colors.primaryContainer,
                  borderRadius: BorderRadius.circular(16),
                ),
                labelColor: colors.onPrimaryContainer,
                unselectedLabelColor: colors.onSurfaceVariant,
                tabs: const [
                  Tab(text: '资料'),
                  Tab(text: '吐槽'),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: TabBarView(
                children: [characterInfoBody, characterCommentsBody],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget get characterInfoBody {
    if (loadingCharacter) {
      return const Center(child: CircularProgressIndicator());
    }
    if (characterFullItem.id == 0) {
      return GeneralErrorWidget(
        errMsg: '角色资料暂时不可用',
        actions: [
          GeneralErrorButton(onPressed: loadCharacter, text: '点击重试'),
        ],
      );
    }
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
      child: Card(
        elevation: 0,
        clipBehavior: Clip.antiAlias,
        color: Theme.of(context).colorScheme.surfaceContainerLow,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: LayoutBuilder(builder: (context, constraints) {
            final isWide = constraints.maxWidth >= 520;
            final image = _characterImage(constraints, isWide);
            final details = _characterDetails;
            if (isWide) {
              return Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(width: constraints.maxWidth * .34, child: image),
                  const SizedBox(width: 18),
                  Expanded(child: details),
                ],
              );
            }
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [image, const SizedBox(height: 18), details],
            );
          }),
        ),
      ),
    );
  }

  Widget _characterImage(BoxConstraints constraints, bool isWide) {
    final image = characterFullItem.image.trim();
    final height = isWide ? constraints.maxWidth * 1.25 : 280.0;
    if (image.isEmpty) {
      return Container(
        height: height,
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(22),
        ),
        child: const Center(child: Icon(Icons.person_outline, size: 64)),
      );
    }
    return GestureDetector(
      onTap: () => ImageViewer.show(
        context,
        imageUrls: [image],
        heroTag: ImageViewer.heroTagFor(image, 0),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(22),
        child: Hero(
          tag: ImageViewer.heroTagFor(image, 0),
          child: NetworkImgLayer(
            width: double.infinity,
            height: height,
            src: image,
          ),
        ),
      ),
    );
  }

  Widget get _characterDetails {
    final colors = Theme.of(context).colorScheme;
    Widget section(String title, String text) {
      if (text.trim().isEmpty) return const SizedBox.shrink();
      return Padding(
        padding: const EdgeInsets.only(top: 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title,
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      color: colors.primary,
                      fontWeight: FontWeight.w700,
                    )),
            const SizedBox(height: 8),
            Text(text, textAlign: TextAlign.justify),
          ],
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          characterFullItem.name,
          style: Theme.of(context)
              .textTheme
              .headlineSmall
              ?.copyWith(fontWeight: FontWeight.w700),
        ),
        if (characterFullItem.nameCN.trim().isNotEmpty) ...[
          const SizedBox(height: 4),
          Text(characterFullItem.nameCN,
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    color: colors.onSurfaceVariant,
                  )),
        ],
        section('基本信息', characterFullItem.info),
        section('角色简介', characterFullItem.summary),
        if (characterFullItem.info.trim().isEmpty &&
            characterFullItem.summary.trim().isEmpty)
          const Padding(
            padding: EdgeInsets.only(top: 18),
            child: Text('暂无详细资料'),
          ),
      ],
    );
  }

  Widget get characterCommentsBody {
    return CustomScrollView(
      scrollBehavior: const ScrollBehavior().copyWith(
        // Scrollbars' movement is not linear so hide it.
        scrollbars: false,
        // Enable mouse drag to refresh
        dragDevices: {
          PointerDeviceKind.mouse,
          PointerDeviceKind.touch,
        },
      ),
      slivers: [
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 4),
          sliver: Builder(builder: (context) {
            if (loadingComments) {
              return const SliverFillRemaining(
                child: Center(
                  child: CircularProgressIndicator(),
                ),
              );
            }
            if (commentsError) {
              return SliverFillRemaining(
                child: GeneralErrorWidget(
                  errMsg: '什么都没有找到 (´;ω;`)',
                  actions: [
                    GeneralErrorButton(
                      onPressed: () {
                        loadComments();
                      },
                      text: '点击重试',
                    ),
                  ],
                ),
              );
            }
            if (commentsList.isEmpty) {
              return const SliverFillRemaining(
                child: Center(
                  child: Text('什么都没有找到 (´;ω;`)'),
                ),
              );
            }
            return SliverList(
              delegate: SliverChildBuilderDelegate(
                (context, index) {
                  // Fix scroll issue caused by height change of network images
                  // by keeping loaded cards alive.
                  return KeepAlive(
                    keepAlive: true,
                    child: IndexedSemantics(
                      index: index,
                      child: CharacterCommentsCard(
                        commentItem: commentsList[index],
                      ),
                    ),
                  );
                },
                childCount: commentsList.length,
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
}
