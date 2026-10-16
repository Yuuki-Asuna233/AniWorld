import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/bean/card/bangumi_card.dart';
import 'package:kazumi/bean/card/network_img_layer.dart';
import 'package:kazumi/bean/dialog/dialog_helper.dart';
import 'package:kazumi/bean/widget/desktop_scroll_behavior.dart';
import 'package:kazumi/bean/widget/bangumi_mirror_error_widget.dart';
import 'package:kazumi/bean/widget/site_announcement_card.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/pages/popular/popular_controller.dart';
import 'package:kazumi/request/apis/bangumi_api.dart';
import 'package:kazumi/request/config/api_endpoints.dart';
import 'package:kazumi/services/cache/home_cache_service.dart';
import 'package:kazumi/utils/constants.dart';
import 'package:kazumi/utils/root_back_navigation.dart';

class PopularPage extends StatefulWidget {
  const PopularPage({super.key});

  @override
  State<PopularPage> createState() => _PopularPageState();
}

class _PopularPageState extends State<PopularPage>
    with AutomaticKeepAliveClientMixin {
  final PopularController popularController = Modular.get<PopularController>();
  final ScrollController scrollController = ScrollController();
  final PageController bannerController =
      PageController(viewportFraction: 0.92);
  final HomeCacheService _homeCache = HomeCacheService.instance;

  DateTime? _lastPressedAt;
  Timer? _bannerTimer;
  int _sectionIndex = 0;
  int _bannerIndex = 0;
  bool _homeLoading = true;
  bool _homeFailed = false;
  int _homeLoadGeneration = 0;

  String _selectedCategoryValue = '';
  int? _selectedYear;
  int? _selectedMonth;
  String _selectedFormat = '';
  String _selectedSort = 'latest';
  static const List<int?> _seasonMonthOptions = [null, 1, 4, 7, 10];
  static const List<({String label, String value})> _formatOptions = [
    (label: '全部形式', value: ''),
    (label: '普通 TV 版', value: 'TV'),
    (label: '剧场版', value: 'MOVIE'),
  ];
  static const List<({String label, String value})> _sortOptions = [
    (label: '最新', value: 'latest'),
    (label: '最热', value: 'popular'),
    (label: '高分', value: 'rating'),
  ];
  int _categoryPage = 1;
  bool _categoryHasMore = true;
  bool _categoryLoading = false;
  int _categoryLoadGeneration = 0;
  String _selectedRanking = 'classic';
  bool _dailyTrendLoading = false;
  bool _dailyTrendFailed = false;
  int _dailyTrendGeneration = 0;
  bool _weeklyTrendLoading = false;
  bool _weeklyTrendFailed = false;
  int _weeklyTrendGeneration = 0;

  List<BangumiItem> _bannerItems = [];
  List<BangumiItem> _recommendItems = [];
  List<BangumiItem> _todayItems = [];
  List<BangumiItem> _newItems = [];
  List<BangumiItem> _hotItems = [];
  List<BangumiItem> _classicItems = [];
  List<BangumiItem> _movieItems = [];
  List<BangumiItem> _categoryItems = [];
  List<BangumiItem> _dailyTrendItems = [];
  List<BangumiItem> _weeklyTrendItems = [];

  final List<String> _sections = const ['推荐', '全部分类', '排行榜'];
  final List<({String label, String value})> _categoryTags = const [
    (label: '全部类型', value: ''),
    (label: '动作', value: 'Action'),
    (label: '冒险', value: 'Adventure'),
    (label: '搞笑', value: 'Comedy'),
    (label: '剧情', value: 'Drama'),
    (label: '福利', value: 'Ecchi'),
    (label: '奇幻', value: 'Fantasy'),
    (label: '恐怖', value: 'Horror'),
    (label: '魔法少女', value: 'Mahou Shoujo'),
    (label: '机战', value: 'Mecha'),
    (label: '音乐', value: 'Music'),
    (label: '悬疑', value: 'Mystery'),
    (label: '心理', value: 'Psychological'),
    (label: '恋爱', value: 'Romance'),
    (label: '科幻', value: 'Sci-Fi'),
    (label: '日常', value: 'Slice of Life'),
    (label: '运动', value: 'Sports'),
    (label: '超自然', value: 'Supernatural'),
    (label: '惊悚', value: 'Thriller'),
    (label: '治愈', value: 'Iyashikei'),
    (label: '百合', value: 'Yuri'),
    (label: '后宫', value: 'Harem'),
  ];

  List<int> get _yearOptions {
    final current = DateTime.now().year;
    return List.generate(current - 1990 + 1, (index) => current - index);
  }

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    scrollController.addListener(scrollListener);
    _loadHomeData();
    popularController.setCurrentTag(_selectedCategoryValue);
  }

  @override
  void dispose() {
    _bannerTimer?.cancel();
    bannerController.dispose();
    scrollController.removeListener(scrollListener);
    scrollController.dispose();
    super.dispose();
  }

  void scrollListener() {
    popularController.scrollOffset = scrollController.offset;
    if (_sectionIndex != 1) return;
    if (scrollController.position.pixels >=
            scrollController.position.maxScrollExtent - 200 &&
        _categoryHasMore &&
        !_categoryLoading) {
      _loadCategoryData(loadMore: true);
    }
  }

  Future<void> _loadHomeData({bool readCache = true}) async {
    final generation = ++_homeLoadGeneration;
    final server = ApiEndpoints.selfBackend;
    var hasUsableData = _hasHomeContent;

    if (readCache) {
      final cached = await _homeCache.load(server: server);
      if (!mounted || generation != _homeLoadGeneration) return;
      if (cached != null && cached.hasContent) {
        setState(() => _applyHomeSnapshot(cached));
        hasUsableData = true;
        _startBannerAutoPlay();
      }
    }

    if (!mounted || generation != _homeLoadGeneration) return;
    setState(() {
      _homeLoading = !hasUsableData;
      _homeFailed = false;
    });

    try {
      final home = await BangumiApi.getAniWorldHome(limit: 18);
      final today = _uniqueItems(home.today);
      final recommend = _uniqueItems(home.recommend);
      final newItems = _uniqueItems(home.newSeason);
      final hot = _uniqueItems(home.hot);
      final classic = _uniqueItems(home.classic);
      final movies = _uniqueItems(home.movies).take(10).toList();

      if (today.isEmpty &&
          recommend.isEmpty &&
          newItems.isEmpty &&
          hot.isEmpty &&
          classic.isEmpty &&
          movies.isEmpty) {
        throw StateError('All home sections are empty');
      }

      final snapshot = HomeCacheSnapshot(
        recommend: _fallback(recommend, hot, newItems),
        today: _fallback(today, hot, recommend),
        newSeason: _fallback(newItems, recommend, hot),
        hot: _fallback(hot, recommend, newItems),
        classic: _fallback(classic, recommend, hot),
        movies: movies,
      );

      if (!mounted ||
          generation != _homeLoadGeneration ||
          ApiEndpoints.selfBackend != server) {
        return;
      }
      setState(() => _applyHomeSnapshot(snapshot));
      _startBannerAutoPlay();
      unawaited(_saveHomeCache(server, snapshot));
    } catch (_) {
      if (!mounted || generation != _homeLoadGeneration) return;
      setState(() {
        _homeLoading = false;
        _homeFailed = !_hasHomeContent;
      });
    }
  }

  bool get _hasHomeContent =>
      _recommendItems.isNotEmpty ||
      _todayItems.isNotEmpty ||
      _newItems.isNotEmpty ||
      _hotItems.isNotEmpty ||
      _classicItems.isNotEmpty ||
      _movieItems.isNotEmpty;

  void _applyHomeSnapshot(HomeCacheSnapshot snapshot) {
    _recommendItems = List<BangumiItem>.from(snapshot.recommend);
    _todayItems = List<BangumiItem>.from(snapshot.today);
    _newItems = List<BangumiItem>.from(snapshot.newSeason);
    _hotItems = List<BangumiItem>.from(snapshot.hot);
    _classicItems = List<BangumiItem>.from(snapshot.classic);
    _movieItems = List<BangumiItem>.from(snapshot.movies).take(10).toList();
    _bannerItems =
        _fallback(_hotItems, _recommendItems, _newItems).take(6).toList();
    _homeLoading = false;
    _homeFailed = !_hasHomeContent;
  }

  Future<void> _saveHomeCache(
    String server,
    HomeCacheSnapshot snapshot,
  ) async {
    try {
      await _homeCache.save(server: server, snapshot: snapshot);
    } catch (_) {
      // Cache writes are best-effort and must never break the home page.
    }
  }

  List<BangumiItem> _uniqueItems(List<BangumiItem> items) {
    final seen = <int>{};
    return items.where((item) => seen.add(item.id)).toList();
  }

  List<BangumiItem> _fallback(
    List<BangumiItem> primary,
    List<BangumiItem> secondary,
    List<BangumiItem> third,
  ) {
    if (primary.isNotEmpty) return primary;
    if (secondary.isNotEmpty) return secondary;
    return third;
  }

  void _startBannerAutoPlay() {
    _bannerTimer?.cancel();
    if (_bannerItems.length < 2) return;
    _bannerTimer = Timer.periodic(const Duration(seconds: 4), (_) {
      if (!mounted || !bannerController.hasClients) return;
      final next = (_bannerIndex + 1) % _bannerItems.length;
      bannerController.animateToPage(
        next,
        duration: const Duration(milliseconds: 420),
        curve: Curves.easeOutCubic,
      );
    });
  }

  void onBackPressed(BuildContext context) {
    if (popMediaOverlayIfPresent(context)) {
      return;
    }
    if (KazumiDialog.observer.hasKazumiDialog) {
      KazumiDialog.dismiss();
      return;
    }
    if (_lastPressedAt == null ||
        DateTime.now().difference(_lastPressedAt!) >
            const Duration(seconds: 2)) {
      _lastPressedAt = DateTime.now();
      KazumiDialog.showToast(message: '再按一次退出应用', context: context);
      return;
    }
    SystemNavigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (bool didPop, Object? result) {
        if (!didPop) {
          onBackPressed(context);
        }
      },
      child: Scaffold(
        body: RefreshIndicator(
          onRefresh: () async {
            if (_sectionIndex == 0) {
              await _loadHomeData(readCache: false);
            } else if (_sectionIndex == 1) {
              await _loadCategoryData(reset: true);
            } else {
              if (_selectedRanking != 'classic') {
                await _loadSelectedTrend();
              } else {
                await _loadHomeData(readCache: false);
              }
            }
          },
          child: CustomScrollView(
            controller: scrollController,
            physics: const AlwaysScrollableScrollPhysics(
              parent: BouncingScrollPhysics(),
            ),
            slivers: [
              buildSliverAppBar(),
              buildDiscoveryTools(),
              if (_sectionIndex == 0) ...buildHomeSlivers(),
              if (_sectionIndex == 1) ...buildCategorySlivers(),
              if (_sectionIndex == 2) ...buildRankingSlivers(),
            ],
          ),
        ),
      ),
    );
  }

  Widget buildSliverAppBar() {
    final colorScheme = Theme.of(context).colorScheme;
    return SliverAppBar(
      pinned: true,
      expandedHeight: 104,
      elevation: 0,
      titleSpacing: 0,
      centerTitle: false,
      backgroundColor: colorScheme.surface,
      flexibleSpace: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
          child: Align(
            alignment: Alignment.bottomLeft,
            child: DesktopHorizontalScrollRegion(
              builder: (context, controller) => SingleChildScrollView(
                controller: controller,
                scrollDirection: Axis.horizontal,
                physics: const BouncingScrollPhysics(),
                child: Row(
                  children: [
                    for (int i = 0; i < _sections.length; i++)
                      Padding(
                        padding: const EdgeInsets.only(right: 28),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(12),
                          onTap: () => _switchSection(i),
                          child: AnimatedDefaultTextStyle(
                            duration: const Duration(milliseconds: 180),
                            curve: Curves.easeOut,
                            style: Theme.of(context)
                                .textTheme
                                .headlineSmall!
                                .copyWith(
                                  color: _sectionIndex == i
                                      ? colorScheme.onSurface
                                      : colorScheme.onSurfaceVariant,
                                  fontWeight: _sectionIndex == i
                                      ? FontWeight.w800
                                      : FontWeight.w500,
                                  fontSize: _sectionIndex == i ? 28 : 22,
                                ),
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(_sections[i]),
                                const SizedBox(height: 5),
                                AnimatedContainer(
                                  duration: const Duration(milliseconds: 180),
                                  width: _sectionIndex == i ? 26 : 0,
                                  height: 4,
                                  decoration: BoxDecoration(
                                    color: colorScheme.primary,
                                    borderRadius: BorderRadius.circular(99),
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
            ),
          ),
        ),
      ),
    );
  }

  Widget buildDiscoveryTools() {
    final colorScheme = Theme.of(context).colorScheme;
    return SliverToBoxAdapter(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 14),
        child: Row(
          children: [
            Expanded(
              child: Material(
                color:
                    colorScheme.surfaceContainerHighest.withValues(alpha: 0.72),
                borderRadius: BorderRadius.circular(24),
                child: InkWell(
                  borderRadius: BorderRadius.circular(24),
                  onTap: () => Modular.to.pushNamed('/search/'),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 18,
                      vertical: 13,
                    ),
                    child: Row(
                      children: [
                        Icon(
                          Icons.search,
                          color: colorScheme.onSurfaceVariant,
                          size: 22,
                        ),
                        const SizedBox(width: 10),
                        Text(
                          '点击搜索动漫',
                          style:
                              Theme.of(context).textTheme.bodyLarge?.copyWith(
                                    color: colorScheme.onSurfaceVariant,
                                    fontWeight: FontWeight.w500,
                                  ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 12),
            FilledButton.icon(
              onPressed: () => Modular.to.pushNamed('/timeline/'),
              icon: const Icon(Icons.calendar_month_rounded),
              label: const Text('排期表'),
              style: FilledButton.styleFrom(
                padding: const EdgeInsets.symmetric(
                  horizontal: 18,
                  vertical: 14,
                ),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(24),
                ),
                textStyle: Theme.of(context)
                    .textTheme
                    .titleMedium
                    ?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> buildHomeSlivers() {
    if (_homeLoading) {
      return const [
        SliverToBoxAdapter(child: LinearProgressIndicator(minHeight: 3)),
        SliverToBoxAdapter(
          child: SizedBox(height: 420),
        ),
      ];
    }

    if (_homeFailed) {
      return [
        SliverToBoxAdapter(
          child: SizedBox(
            height: 420,
            child: BangumiMirrorErrorWidget(
              onRetry: _loadHomeData,
              onSettingsReturned: () {
                if (mounted) setState(() {});
              },
            ),
          ),
        ),
      ];
    }

    return [
      buildBanner(),
      buildNoticeBar(),
      buildHorizontalSection('推荐 · 今日更新', _todayItems, onMore: () {
        Modular.to.pushNamed('/timeline/');
      }),
      buildHorizontalSection('推荐 · 新番', _newItems),
      buildHorizontalSection('推荐 · 热门', _hotItems, onMore: () {
        _switchSection(2);
      }),
      buildHorizontalSection('推荐 · 经典', _classicItems, onMore: () {
        _switchSection(2);
      }),
      buildHorizontalSection('推荐 · 剧场版', _movieItems),
      const SliverToBoxAdapter(child: SizedBox(height: 24)),
    ];
  }

  Widget buildBanner() {
    final colorScheme = Theme.of(context).colorScheme;
    return SliverToBoxAdapter(
      child: SizedBox(
        height: 210,
        child: PageView.builder(
          controller: bannerController,
          itemCount: _bannerItems.length,
          onPageChanged: (index) => setState(() => _bannerIndex = index),
          itemBuilder: (context, index) {
            final item = _bannerItems[index];
            return Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: InkWell(
                borderRadius: BorderRadius.circular(18),
                onTap: () => Modular.to.pushNamed('/info/', arguments: item),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(18),
                  child: Stack(
                    fit: StackFit.expand,
                    children: [
                      NetworkImgLayer(
                        src: item.images['large'] ?? '',
                        fallbackSrc: item.images['fallback'],
                        width: double.infinity,
                        height: 210,
                        type: 'bg',
                      ),
                      DecoratedBox(
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment.centerLeft,
                            end: Alignment.centerRight,
                            colors: [
                              Colors.black.withValues(alpha: 0.65),
                              Colors.black.withValues(alpha: 0.22),
                            ],
                          ),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.all(20),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.end,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 10,
                                vertical: 4,
                              ),
                              decoration: BoxDecoration(
                                color: colorScheme.primary,
                                borderRadius: BorderRadius.circular(99),
                              ),
                              child: Text(
                                '站内推荐',
                                style: Theme.of(context)
                                    .textTheme
                                    .labelMedium
                                    ?.copyWith(
                                      color: colorScheme.onPrimary,
                                      fontWeight: FontWeight.w800,
                                    ),
                              ),
                            ),
                            const SizedBox(height: 10),
                            Text(
                              item.nameCn,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context)
                                  .textTheme
                                  .headlineSmall
                                  ?.copyWith(
                                    color: Colors.white,
                                    fontWeight: FontWeight.w900,
                                  ),
                            ),
                            const SizedBox(height: 6),
                            Text(
                              _itemMetaText(item),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context)
                                  .textTheme
                                  .bodyMedium
                                  ?.copyWith(color: Colors.white70),
                            ),
                          ],
                        ),
                      ),
                      Positioned(
                        right: 18,
                        bottom: 16,
                        child: Row(
                          children: List.generate(
                            _bannerItems.length,
                            (i) => AnimatedContainer(
                              duration: const Duration(milliseconds: 200),
                              margin: const EdgeInsets.only(left: 5),
                              width: i == _bannerIndex ? 18 : 6,
                              height: 6,
                              decoration: BoxDecoration(
                                color: i == _bannerIndex
                                    ? colorScheme.primary
                                    : Colors.white54,
                                borderRadius: BorderRadius.circular(99),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  Widget buildNoticeBar() {
    return SliverToBoxAdapter(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
        child: const SiteAnnouncementCard(
          title: '欢迎使用 AniWorld',
          summary: '欢迎使用 AniWorld，更多站内动漫内容正在持续同步。',
          publishedAt: '2026-06-30',
          content: '欢迎使用 AniWorld！\n\n'
              '目前番剧搜索、详情、播放、投屏、弹幕、收藏与观看历史等功能均在持续维护。'
              '如果遇到播放源失效，可以在剧集页面切换其他线路后重试。\n\n'
              '番剧资料和放送信息来自多个公开数据源，评分与评分人数会随数据源更新。'
              '如发现串番、季数不对应或剧集信息错误，请提供番剧名称和页面截图，便于进一步核对。',
        ),
      ),
    );
  }

  Widget buildHorizontalSection(
    String title,
    List<BangumiItem> items, {
    VoidCallback? onMore,
  }) {
    if (items.isEmpty) {
      return const SliverToBoxAdapter(child: SizedBox.shrink());
    }
    final colorScheme = Theme.of(context).colorScheme;
    return SliverToBoxAdapter(
      child: Padding(
        padding: const EdgeInsets.only(top: 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 18),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      title,
                      style: Theme.of(context)
                          .textTheme
                          .titleLarge
                          ?.copyWith(fontWeight: FontWeight.w900),
                    ),
                  ),
                  if (onMore != null)
                    TextButton(
                      onPressed: onMore,
                      style: TextButton.styleFrom(
                        foregroundColor: colorScheme.onSurfaceVariant,
                      ),
                      child: const Text('查看更多'),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            SizedBox(
              height: 218,
              child: DesktopHorizontalScrollRegion(
                builder: (context, controller) => ListView.separated(
                  controller: controller,
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  scrollDirection: Axis.horizontal,
                  physics: const BouncingScrollPhysics(),
                  itemCount: items.length,
                  separatorBuilder: (_, __) => const SizedBox(width: 12),
                  itemBuilder: (context, index) {
                    return SizedBox(
                      width: 116,
                      child: BangumiCardV(bangumiItem: items[index]),
                    );
                  },
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> buildCategorySlivers() {
    return [
      buildCategoryFilters(),
      buildCategoryLoadingBar(),
      SliverPadding(
        padding: const EdgeInsets.fromLTRB(
          StyleString.cardSpace,
          0,
          StyleString.cardSpace,
          0,
        ),
        sliver: _categoryItems.isEmpty && !_categoryLoading
            ? SliverToBoxAdapter(
                child: SizedBox(
                  height: 400,
                  child: BangumiMirrorErrorWidget(
                    onRetry: () => _loadCategoryData(reset: true),
                    onSettingsReturned: () {
                      if (mounted) setState(() {});
                    },
                  ),
                ),
              )
            : contentGrid(_categoryItems),
      ),
    ];
  }

  Widget buildCategoryFilters() {
    final colorScheme = Theme.of(context).colorScheme;
    return SliverToBoxAdapter(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
        child: Column(
          children: [
            _filterRow(
              label: '类型',
              child: DesktopHorizontalScrollRegion(
                builder: (context, controller) => ListView.separated(
                  controller: controller,
                  scrollDirection: Axis.horizontal,
                  physics: const BouncingScrollPhysics(),
                  itemBuilder: (context, index) {
                    final tag = _categoryTags[index];
                    final selected = tag.value == _selectedCategoryValue;
                    return ChoiceChip(
                      label: Text(tag.label),
                      selected: selected,
                      onSelected: (_) => _selectCategory(tag.value),
                      showCheckmark: false,
                      labelStyle: TextStyle(
                        color: selected
                            ? colorScheme.onPrimary
                            : colorScheme.onSurfaceVariant,
                        fontWeight:
                            selected ? FontWeight.w800 : FontWeight.w500,
                      ),
                      selectedColor: colorScheme.primary,
                      backgroundColor: colorScheme.surfaceContainerHighest
                          .withValues(alpha: 0.72),
                      side: BorderSide(
                        color: selected
                            ? colorScheme.primary
                            : colorScheme.outline,
                      ),
                    );
                  },
                  separatorBuilder: (_, __) => const SizedBox(width: 8),
                  itemCount: _categoryTags.length,
                ),
              ),
            ),
            const SizedBox(height: 10),
            _filterRow(
              label: '年份',
              child: DesktopHorizontalScrollRegion(
                builder: (context, controller) => ListView.separated(
                  controller: controller,
                  scrollDirection: Axis.horizontal,
                  physics: const BouncingScrollPhysics(),
                  itemBuilder: (context, index) {
                    final year = index == 0 ? null : _yearOptions[index - 1];
                    final selected = year == _selectedYear;
                    return ChoiceChip(
                      label: Text(year == null ? '全部年份' : '$year'),
                      selected: selected,
                      onSelected: (_) => _selectYear(year),
                      showCheckmark: false,
                      labelStyle: TextStyle(
                        color: selected
                            ? colorScheme.onPrimary
                            : colorScheme.onSurfaceVariant,
                        fontWeight:
                            selected ? FontWeight.w800 : FontWeight.w500,
                      ),
                      selectedColor: colorScheme.primary,
                      backgroundColor: colorScheme.surfaceContainerHighest
                          .withValues(alpha: 0.72),
                      side: BorderSide(
                        color: selected
                            ? colorScheme.primary
                            : colorScheme.outline,
                      ),
                    );
                  },
                  separatorBuilder: (_, __) => const SizedBox(width: 8),
                  itemCount: _yearOptions.length + 1,
                ),
              ),
            ),
            const SizedBox(height: 10),
            _filterRow(
              label: '月份',
              child: DesktopHorizontalScrollRegion(
                builder: (context, controller) => ListView.separated(
                  controller: controller,
                  scrollDirection: Axis.horizontal,
                  physics: const BouncingScrollPhysics(),
                  itemBuilder: (context, index) {
                    final month = _seasonMonthOptions[index];
                    final selected = month == _selectedMonth;
                    return ChoiceChip(
                      label: Text(month == null ? '全部月份' : '$month月'),
                      selected: selected,
                      onSelected: (_) => _selectMonth(month),
                      showCheckmark: false,
                      labelStyle: TextStyle(
                        color: selected
                            ? colorScheme.onPrimary
                            : colorScheme.onSurfaceVariant,
                        fontWeight:
                            selected ? FontWeight.w800 : FontWeight.w500,
                      ),
                      selectedColor: colorScheme.primary,
                      backgroundColor: colorScheme.surfaceContainerHighest
                          .withValues(alpha: 0.72),
                      side: BorderSide(
                        color: selected
                            ? colorScheme.primary
                            : colorScheme.outline,
                      ),
                    );
                  },
                  separatorBuilder: (_, __) => const SizedBox(width: 8),
                  itemCount: _seasonMonthOptions.length,
                ),
              ),
            ),
            const SizedBox(height: 10),
            _filterRow(
              label: '形式',
              child: DesktopHorizontalScrollRegion(
                builder: (context, controller) => ListView.separated(
                  controller: controller,
                  scrollDirection: Axis.horizontal,
                  physics: const BouncingScrollPhysics(),
                  itemBuilder: (context, index) {
                    final option = _formatOptions[index];
                    final selected = option.value == _selectedFormat;
                    return ChoiceChip(
                      label: Text(option.label),
                      selected: selected,
                      onSelected: (_) => _selectFormat(option.value),
                      showCheckmark: false,
                      labelStyle: TextStyle(
                        color: selected
                            ? colorScheme.onPrimary
                            : colorScheme.onSurfaceVariant,
                        fontWeight:
                            selected ? FontWeight.w800 : FontWeight.w500,
                      ),
                      selectedColor: colorScheme.primary,
                      backgroundColor: colorScheme.surfaceContainerHighest
                          .withValues(alpha: 0.72),
                      side: BorderSide(
                        color: selected
                            ? colorScheme.primary
                            : colorScheme.outline,
                      ),
                    );
                  },
                  separatorBuilder: (_, __) => const SizedBox(width: 8),
                  itemCount: _formatOptions.length,
                ),
              ),
            ),
            const SizedBox(height: 10),
            _filterRow(
              label: '排序',
              child: DesktopHorizontalScrollRegion(
                builder: (context, controller) => ListView.separated(
                  controller: controller,
                  scrollDirection: Axis.horizontal,
                  physics: const BouncingScrollPhysics(),
                  itemBuilder: (context, index) {
                    final option = _sortOptions[index];
                    final selected = option.value == _selectedSort;
                    return ChoiceChip(
                      label: Text(option.label),
                      selected: selected,
                      onSelected: (_) => _selectSort(option.value),
                      showCheckmark: false,
                      labelStyle: TextStyle(
                        color: selected
                            ? colorScheme.onPrimary
                            : colorScheme.onSurfaceVariant,
                        fontWeight:
                            selected ? FontWeight.w800 : FontWeight.w500,
                      ),
                      selectedColor: colorScheme.primary,
                      backgroundColor: colorScheme.surfaceContainerHighest
                          .withValues(alpha: 0.72),
                      side: BorderSide(
                        color: selected
                            ? colorScheme.primary
                            : colorScheme.outline,
                      ),
                    );
                  },
                  separatorBuilder: (_, __) => const SizedBox(width: 8),
                  itemCount: _sortOptions.length,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _filterRow({required String label, required Widget child}) {
    return Row(
      children: [
        SizedBox(
          width: 44,
          child: Text(
            label,
            style: Theme.of(context)
                .textTheme
                .titleSmall
                ?.copyWith(fontWeight: FontWeight.w800),
          ),
        ),
        Expanded(
          child: SizedBox(height: 40, child: child),
        ),
      ],
    );
  }

  List<Widget> buildRankingSlivers() {
    final colorScheme = Theme.of(context).colorScheme;
    final trendSelected =
        _selectedRanking == 'daily' || _selectedRanking == 'weekly';
    final trendLoading =
        _selectedRanking == 'daily' ? _dailyTrendLoading : _weeklyTrendLoading;
    final trendFailed =
        _selectedRanking == 'daily' ? _dailyTrendFailed : _weeklyTrendFailed;
    final trendItems =
        _selectedRanking == 'daily' ? _dailyTrendItems : _weeklyTrendItems;
    final rankingTitle = switch (_selectedRanking) {
      'daily' => '排行榜 · 每日趋势',
      'weekly' => '排行榜 · 本周趋势',
      _ => '排行榜 · 高分经典',
    };
    return [
      SliverToBoxAdapter(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 0, 18, 14),
          child: Row(
            children: [
              for (final option in const [
                (label: '高分经典', value: 'classic'),
                (label: '每日趋势', value: 'daily'),
                (label: '本周趋势', value: 'weekly'),
              ])
                Padding(
                  padding: const EdgeInsets.only(right: 10),
                  child: ChoiceChip(
                    label: Text(option.label),
                    selected: _selectedRanking == option.value,
                    onSelected: (_) => _selectRanking(option.value),
                    showCheckmark: false,
                    selectedColor: colorScheme.primary,
                    labelStyle: TextStyle(
                      color: _selectedRanking == option.value
                          ? colorScheme.onPrimary
                          : colorScheme.onSurfaceVariant,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
      SliverToBoxAdapter(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 0, 18, 8),
          child: Text(
            rankingTitle,
            style: Theme.of(context)
                .textTheme
                .titleLarge
                ?.copyWith(fontWeight: FontWeight.w900),
          ),
        ),
      ),
      if (trendSelected && trendLoading)
        const SliverToBoxAdapter(
          child: LinearProgressIndicator(minHeight: 3),
        ),
      if (!trendSelected)
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(
            StyleString.cardSpace,
            0,
            StyleString.cardSpace,
            0,
          ),
          sliver:
              contentGrid(_classicItems.isEmpty ? _hotItems : _classicItems),
        ),
      if (trendSelected && !trendLoading && trendItems.isNotEmpty)
        _buildTrendList(trendItems),
      if (trendSelected && !trendLoading && (trendItems.isEmpty || trendFailed))
        SliverToBoxAdapter(
          child: SizedBox(
            height: 360,
            child: BangumiMirrorErrorWidget(
              onRetry: _loadSelectedTrend,
              onSettingsReturned: () {
                if (mounted) setState(() {});
              },
            ),
          ),
        ),
    ];
  }

  Widget _buildTrendList(List<BangumiItem> items) {
    return SliverPadding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 24),
      sliver: SliverList(
        delegate: SliverChildBuilderDelegate(
          (context, index) {
            final item = items[index];
            return Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Card(
                elevation: 0,
                clipBehavior: Clip.antiAlias,
                child: InkWell(
                  onTap: () => Modular.to.pushNamed('/info/', arguments: item),
                  child: SizedBox(
                    height: 112,
                    child: Row(
                      children: [
                        SizedBox(
                          width: 62,
                          child: Center(
                            child: Text(
                              'Rank ${index + 1}',
                              style: Theme.of(context)
                                  .textTheme
                                  .titleMedium
                                  ?.copyWith(
                                    fontWeight: FontWeight.w900,
                                    color: index < 3
                                        ? Theme.of(context).colorScheme.primary
                                        : null,
                                  ),
                            ),
                          ),
                        ),
                        ClipRRect(
                          borderRadius: BorderRadius.circular(8),
                          child: SizedBox(
                            width: 72,
                            height: 104,
                            child: BangumiCover(
                              bangumiItem: item,
                              width: 72,
                              height: 104,
                            ),
                          ),
                        ),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Padding(
                            padding: const EdgeInsets.fromLTRB(0, 14, 12, 12),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  item.nameCn,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: Theme.of(context)
                                      .textTheme
                                      .titleMedium
                                      ?.copyWith(fontWeight: FontWeight.w800),
                                ),
                                const Spacer(),
                                Text(
                                  [
                                    if (item.releaseProgressText.isNotEmpty)
                                      item.releaseProgressText,
                                    if (item.ratingScore > 0)
                                      '${item.ratingScore.toStringAsFixed(1)} 分',
                                  ].join(' · '),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: Theme.of(context)
                                      .textTheme
                                      .bodySmall
                                      ?.copyWith(
                                        color: Theme.of(context)
                                            .colorScheme
                                            .onSurfaceVariant,
                                      ),
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
            );
          },
          childCount: items.length,
        ),
      ),
    );
  }

  Widget buildCategoryLoadingBar() {
    return SliverToBoxAdapter(
      child: AnimatedOpacity(
        opacity: _categoryLoading ? 1.0 : 0.0,
        duration: const Duration(milliseconds: 300),
        child: _categoryLoading
            ? const LinearProgressIndicator(minHeight: 3)
            : const SizedBox(height: 3),
      ),
    );
  }

  Widget contentGrid(List<BangumiItem> bangumiList) {
    int crossCount = 3;
    if (MediaQuery.sizeOf(context).width > LayoutBreakpoint.compact['width']!) {
      crossCount = 5;
    }
    if (MediaQuery.sizeOf(context).width > LayoutBreakpoint.medium['width']!) {
      crossCount = 6;
    }
    return SliverPadding(
      padding: const EdgeInsets.all(8),
      sliver: SliverGrid(
        gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
          mainAxisSpacing: StyleString.cardSpace - 2,
          crossAxisSpacing: StyleString.cardSpace,
          crossAxisCount: crossCount,
          mainAxisExtent:
              MediaQuery.of(context).size.width / crossCount / 0.65 +
                  MediaQuery.textScalerOf(context).scale(32.0),
        ),
        delegate: SliverChildBuilderDelegate((BuildContext context, int index) {
          return bangumiList.isNotEmpty
              ? BangumiCardV(bangumiItem: bangumiList[index])
              : null;
        }, childCount: bangumiList.isNotEmpty ? bangumiList.length : 10),
      ),
    );
  }

  Future<void> _switchSection(int index) async {
    if (_sectionIndex == index) return;
    setState(() {
      _sectionIndex = index;
    });
    scrollController.animateTo(
      0,
      duration: const Duration(milliseconds: 250),
      curve: Curves.easeOut,
    );
    if (index == 1 && _categoryItems.isEmpty) {
      await _loadCategoryData(reset: true);
    }
    if (index == 2 && _classicItems.isEmpty) {
      await _loadHomeData();
    }
    if (index == 2 && _selectedRanking != 'classic') {
      await _loadSelectedTrend();
    }
  }

  Future<void> _selectCategory(
    String value, {
    bool animate = true,
  }) async {
    if (_selectedCategoryValue == value) return;
    if (animate) {
      scrollController.animateTo(
        0,
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOut,
      );
    }
    setState(() {
      _selectedCategoryValue = value;
    });
    popularController.setCurrentTag(value);
    await _loadCategoryData(reset: true);
  }

  Future<void> _selectYear(int? year) async {
    if (_selectedYear == year) return;
    scrollController.animateTo(
      0,
      duration: const Duration(milliseconds: 250),
      curve: Curves.easeOut,
    );
    setState(() {
      _selectedYear = year;
    });
    await _loadCategoryData(reset: true);
  }

  Future<void> _selectMonth(int? month) async {
    if (_selectedMonth == month) return;
    scrollController.animateTo(
      0,
      duration: const Duration(milliseconds: 250),
      curve: Curves.easeOut,
    );
    setState(() {
      _selectedMonth = month;
    });
    await _loadCategoryData(reset: true);
  }

  Future<void> _selectFormat(String format) async {
    if (_selectedFormat == format) return;
    scrollController.animateTo(
      0,
      duration: const Duration(milliseconds: 250),
      curve: Curves.easeOut,
    );
    setState(() {
      _selectedFormat = format;
    });
    await _loadCategoryData(reset: true);
  }

  Future<void> _selectSort(String sort) async {
    if (_selectedSort == sort) return;
    scrollController.animateTo(
      0,
      duration: const Duration(milliseconds: 250),
      curve: Curves.easeOut,
    );
    setState(() {
      _selectedSort = sort;
    });
    await _loadCategoryData(reset: true);
  }

  Future<void> _selectRanking(String ranking) async {
    if (_selectedRanking == ranking) return;
    setState(() {
      _selectedRanking = ranking;
    });
    if (ranking == 'daily' && _dailyTrendItems.isEmpty) {
      await _loadDailyTrend();
    } else if (ranking == 'weekly' && _weeklyTrendItems.isEmpty) {
      await _loadWeeklyTrend();
    }
  }

  Future<void> _loadSelectedTrend() {
    return _selectedRanking == 'daily' ? _loadDailyTrend() : _loadWeeklyTrend();
  }

  Future<void> _loadDailyTrend() async {
    final generation = ++_dailyTrendGeneration;
    setState(() {
      _dailyTrendLoading = true;
      _dailyTrendFailed = false;
    });
    final items = await BangumiApi.getAniWorldSection(
      type: 'daily',
      limit: 10,
    );
    if (!mounted || generation != _dailyTrendGeneration) return;
    setState(() {
      _dailyTrendItems = _uniqueItems(items).take(10).toList();
      _dailyTrendLoading = false;
      _dailyTrendFailed = _dailyTrendItems.isEmpty;
    });
  }

  Future<void> _loadWeeklyTrend() async {
    final generation = ++_weeklyTrendGeneration;
    setState(() {
      _weeklyTrendLoading = true;
      _weeklyTrendFailed = false;
    });
    final items = await BangumiApi.getAniWorldSection(
      type: 'weekly',
      limit: 10,
    );
    if (!mounted || generation != _weeklyTrendGeneration) return;
    setState(() {
      _weeklyTrendItems = _uniqueItems(items).take(10).toList();
      _weeklyTrendLoading = false;
      _weeklyTrendFailed = _weeklyTrendItems.isEmpty;
    });
  }

  Future<void> _loadCategoryData({
    bool reset = false,
    bool loadMore = false,
  }) async {
    if (_categoryLoading && !reset) return;
    if (loadMore && !_categoryHasMore) return;

    final generation = ++_categoryLoadGeneration;
    final nextPage = reset ? 1 : _categoryPage + 1;
    setState(() {
      _categoryLoading = true;
      if (reset) {
        _categoryPage = 1;
        _categoryHasMore = true;
        _categoryItems = [];
      }
    });

    final result = await BangumiApi.getAniWorldBrowse(
      genre: _selectedCategoryValue,
      year: _selectedYear,
      month: _selectedMonth,
      format: _selectedFormat,
      sort: _selectedSort,
      page: nextPage,
      limit: 24,
    );

    if (!mounted || generation != _categoryLoadGeneration) return;
    setState(() {
      if (reset) {
        _categoryItems = result.data;
      } else {
        final seen = _categoryItems.map((e) => e.id).toSet();
        _categoryItems = [
          ..._categoryItems,
          ...result.data.where((item) => seen.add(item.id)),
        ];
      }
      _categoryPage = nextPage;
      _categoryHasMore = result.hasMore;
      _categoryLoading = false;
    });
  }

  String _itemMetaText(BangumiItem item) {
    final parts = <String>[];
    if (item.airDate.isNotEmpty) {
      parts.add(item.airDate.length >= 4
          ? item.airDate.substring(0, 4)
          : item.airDate);
    }
    if (item.ratingScore > 0) {
      parts.add('${item.ratingScore.toStringAsFixed(1)} 分');
    }
    if (item.tags.isNotEmpty) {
      parts.add(item.tags.take(2).map((e) => e.name).join(' / '));
    }
    return parts.join(' · ');
  }
}
