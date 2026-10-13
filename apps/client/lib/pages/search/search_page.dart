import 'package:flutter/material.dart';
import 'package:flutter_mobx/flutter_mobx.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/bean/appbar/sys_app_bar.dart';
import 'package:kazumi/bean/card/bangumi_card.dart';
import 'package:kazumi/bean/widget/error_widget.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/pages/search/search_controller.dart';
import 'package:kazumi/utils/constants.dart';
import 'package:kazumi/utils/date_time.dart';
import 'package:kazumi/utils/search_parser.dart';

part 'search_workbench.dart';

class SearchPage extends StatefulWidget {
  const SearchPage({super.key, this.inputTag = ''});

  final String inputTag;

  @override
  State<SearchPage> createState() => _SearchPageState();
}

class _SearchPageState extends State<SearchPage> {
  final SearchController searchController = SearchController();

  /// Don't use modular singleton here. We may have multiple search pages.
  /// Use a new instance of SearchPageController for each search page.
  final SearchPageController searchPageController = SearchPageController();
  final ScrollController scrollController = ScrollController();

  SearchFilterState filterState = const SearchFilterState();
  bool _syncingSearchText = false;

  @override
  void initState() {
    super.initState();
    searchController.addListener(_syncFilterFromSearchText);
    searchPageController.loadSearchHistories();
    if (widget.inputTag != '') {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        _applyFilterState(
            SearchFilterState(tags: [Uri.decodeComponent(widget.inputTag)]),
            search: true);
      });
    }
  }

  @override
  void dispose() {
    searchPageController.cancelPendingSearch();
    searchPageController.bangumiList.clear();
    searchController.removeListener(_syncFilterFromSearchText);
    searchController.dispose();
    scrollController.dispose();
    super.dispose();
  }

  void _syncFilterFromSearchText() {
    if (_syncingSearchText) return;
    final parsed = SearchParser(searchController.text).toFilterState();
    if (SearchParser.fromFilterState(parsed) !=
        SearchParser.fromFilterState(filterState)) {
      setState(() => filterState = parsed);
    }
  }

  void _setSearchText(String value) {
    _syncingSearchText = true;
    searchController.text = value;
    searchController.selection = TextSelection.collapsed(offset: value.length);
    _syncingSearchText = false;
  }

  Future<void> _applyFilterState(
    SearchFilterState state, {
    bool search = false,
  }) async {
    setState(() => filterState = state);
    _setSearchText(SearchParser.fromFilterState(state));
    if (search) {
      await searchPageController.searchBangumi(searchController.text,
          type: 'init');
    }
  }

  Future<void> showWorkbench() async {
    final result = await showModalBottomSheet<_SearchWorkbenchResult>(
      isScrollControlled: true,
      constraints: BoxConstraints(
        maxHeight: MediaQuery.of(context).size.height * 0.86,
        maxWidth: (MediaQuery.sizeOf(context).width >=
                LayoutBreakpoint.medium['width']!)
            ? MediaQuery.of(context).size.width * 9 / 16
            : MediaQuery.of(context).size.width,
      ),
      clipBehavior: Clip.antiAlias,
      backgroundColor: Theme.of(context).scaffoldBackgroundColor,
      context: context,
      builder: (context) {
        return _SearchWorkbenchSheet(
          initialState: filterState,
          initialNotShowWatched: searchPageController.notShowWatchedBangumis,
          initialNotShowAbandoned:
              searchPageController.notShowAbandonedBangumis,
        );
      },
    );

    if (result == null || !mounted) return;
    await searchPageController.setNotShowWatchedBangumis(result.notShowWatched);
    await searchPageController
        .setNotShowAbandonedBangumis(result.notShowAbandoned);
    await _applyFilterState(result.filterState, search: result.shouldSearch);
  }

  SearchFilterState _removeTag(String tag) {
    return filterState.copyWith(
      tags: filterState.tags.where((item) => item != tag).toList(),
    );
  }

  List<Widget> buildFilterChips() {
    final chips = <Widget>[];

    for (final tag in filterState.tags) {
      chips.add(InputChip(
        label: Text('标签: $tag'),
        onDeleted: () => _applyFilterState(_removeTag(tag), search: true),
      ));
    }
    if (filterState.sort != 'heat' || filterState.explicitSort) {
      chips.add(InputChip(
        label: Text('排序: ${_sortLabel(filterState.sort)}'),
        onDeleted: () => _applyFilterState(
          filterState.copyWith(sort: 'heat', explicitSort: false),
          search: true,
        ),
      ));
    }
    if (filterState.season.isNotEmpty) {
      chips.add(InputChip(
        label: Text('季度: ${filterState.season}'),
        onDeleted: () => _applyFilterState(
          filterState.copyWith(season: '', dateRange: null),
          search: true,
        ),
      ));
    } else if (filterState.dateRange != null) {
      chips.add(InputChip(
        label: Text(
            '日期: ${filterState.dateRange!.start}..${filterState.dateRange!.end}'),
        onDeleted: () => _applyFilterState(
          filterState.copyWith(dateRange: null),
          search: true,
        ),
      ));
    }
    if (filterState.rankRange?.isValid == true) {
      chips.add(InputChip(
        label: Text('排名: ${filterState.rankRange!.toToken()}'),
        onDeleted: () => _applyFilterState(
          filterState.copyWith(rankRange: null),
          search: true,
        ),
      ));
    }
    if (filterState.scoreRange?.isValid == true) {
      chips.add(InputChip(
        label: Text('评分: ${filterState.scoreRange!.toToken()}'),
        onDeleted: () => _applyFilterState(
          filterState.copyWith(scoreRange: null),
          search: true,
        ),
      ));
    }
    if (filterState.weekdays.isNotEmpty) {
      chips.add(InputChip(
        label: Text('星期: ${filterState.weekdays.join(',')}'),
        onDeleted: () => _applyFilterState(
          filterState.copyWith(weekdays: []),
          search: true,
        ),
      ));
    }
    if (searchPageController.notShowWatchedBangumis) {
      chips.add(InputChip(
        label: const Text('隐藏已看'),
        onDeleted: () async {
          await searchPageController.setNotShowWatchedBangumis(false);
          if (mounted) await _submitSearch(searchController.text);
        },
      ));
    }
    if (searchPageController.notShowAbandonedBangumis) {
      chips.add(InputChip(
        label: const Text('隐藏已弃'),
        onDeleted: () async {
          await searchPageController.setNotShowAbandonedBangumis(false);
          if (mounted) await _submitSearch(searchController.text);
        },
      ));
    }

    return chips;
  }

  Future<void> _submitSearch(String value) async {
    final parsed = SearchParser(value).toFilterState();
    setState(() => filterState = parsed);
    final normalizedValue = SearchParser(value).validationError == null
        ? SearchParser.fromFilterState(parsed)
        : value.trim();
    _setSearchText(normalizedValue);
    final search =
        searchPageController.searchBangumi(normalizedValue, type: 'init');
    if (searchController.isOpen) {
      searchController.closeView(normalizedValue);
    }
    await search;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: SysAppBar(
        backgroundColor: Colors.transparent,
        title: const Text("搜索"),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: showWorkbench,
        icon: const Icon(Icons.tune),
        label: const Text("筛选"),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
            child: FocusScope(
              descendantsAreFocusable: false,
              child: SearchAnchor.bar(
                searchController: searchController,
                barElevation: WidgetStateProperty<double>.fromMap(
                  <WidgetStatesConstraint, double>{WidgetState.any: 0},
                ),
                viewElevation: 0,
                viewLeading: IconButton(
                  onPressed: () {
                    Navigator.of(context).pop();
                  },
                  icon: const Icon(Icons.arrow_back),
                ),
                barTrailing: [
                  IconButton(
                    tooltip: '图片搜索',
                    onPressed: () async {
                      final result =
                          await Modular.to.pushNamed('/search/image');
                      if (result is String && result.isNotEmpty) {
                        await _applyFilterState(
                          SearchParser(result).toFilterState(),
                          search: true,
                        );
                      }
                    },
                    icon: const Icon(Icons.image_search_rounded),
                  ),
                ],
                isFullScreen: MediaQuery.sizeOf(context).width <
                    LayoutBreakpoint.compact['width']!,
                suggestionsBuilder: (context, controller) => [
                  Observer(
                    builder: (context) {
                      if (controller.text.isNotEmpty) {
                        return const SizedBox(
                          height: 400,
                          child: Center(
                            child: Text("暂无搜索建议，按回车直接检索"),
                          ),
                        );
                      } else {
                        return Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            for (var history in searchPageController
                                .searchHistories
                                .take(10))
                              ListTile(
                                title: Text(history.keyword),
                                onTap: () {
                                  controller.text = history.keyword;
                                  _submitSearch(controller.text);
                                },
                                trailing: IconButton(
                                  icon: const Icon(Icons.close),
                                  onPressed: () {
                                    searchPageController
                                        .deleteSearchHistory(history);
                                  },
                                ),
                              ),
                          ],
                        );
                      }
                    },
                  ),
                ],
                onSubmitted: _submitSearch,
              ),
            ),
          ),
          Observer(
            builder: (_) {
              final chips = buildFilterChips();
              if (chips.isEmpty) return const SizedBox.shrink();
              return Padding(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 4,
                    children: chips,
                  ),
                ),
              );
            },
          ),
          Expanded(
            child: Observer(builder: (context) {
              if (!searchPageController.isLoading &&
                  {
                    SearchOutcome.empty,
                    SearchOutcome.networkError,
                    SearchOutcome.protocolError,
                    SearchOutcome.invalidQuery
                  }.contains(searchPageController.outcome)) {
                return Center(
                  child: SizedBox(
                    height: 400,
                    child: GeneralErrorWidget(
                      errMsg: switch (searchPageController.outcome) {
                        SearchOutcome.networkError => '搜索请求失败，请检查网络和服务器地址后重试',
                        SearchOutcome.protocolError => '搜索服务返回了异常数据，请稍后重试',
                        SearchOutcome.invalidQuery =>
                          searchPageController.searchMessage,
                        _ => '没有符合当前搜索及筛选条件的动漫',
                      },
                      actions: [
                        GeneralErrorButton(
                          onPressed: () {
                            searchPageController.searchBangumi(
                                searchController.text,
                                type: 'init',
                                forceRefresh: true);
                          },
                          text: '点击重试',
                        ),
                      ],
                    ),
                  ),
                );
              }

              if (searchPageController.isLoading &&
                  searchPageController.bangumiList.isEmpty) {
                return const Center(child: CircularProgressIndicator());
              }

              int crossCount = 3;
              if (MediaQuery.sizeOf(context).width >
                  LayoutBreakpoint.compact['width']!) {
                crossCount = 5;
              }
              if (MediaQuery.sizeOf(context).width >
                  LayoutBreakpoint.medium['width']!) {
                crossCount = 6;
              }
              List<BangumiItem> filteredList =
                  searchPageController.bangumiList.toList();

              if (searchPageController.notShowWatchedBangumis) {
                final watchedBangumiIds =
                    searchPageController.loadWatchedBangumiIds();
                filteredList = filteredList
                    .where((item) => !watchedBangumiIds.contains(item.id))
                    .toList();
              }

              if (searchPageController.notShowAbandonedBangumis) {
                final abandonedBangumiIds =
                    searchPageController.loadAbandonedBangumiIds();
                filteredList = filteredList
                    .where((item) => !abandonedBangumiIds.contains(item.id))
                    .toList();
              }

              return Column(children: [
                Expanded(
                    child: filteredList.isEmpty
                        ? Center(
                            child: Text(searchPageController.outcome ==
                                    SearchOutcome.idle
                                ? '输入关键词搜索动漫，或使用目录筛选'
                                : '没有符合当前筛选条件的动漫'))
                        : GridView.builder(
                            controller: scrollController,
                            padding: const EdgeInsets.fromLTRB(8, 0, 8, 0),
                            gridDelegate:
                                SliverGridDelegateWithFixedCrossAxisCount(
                              mainAxisSpacing: StyleString.cardSpace - 2,
                              crossAxisSpacing: StyleString.cardSpace,
                              crossAxisCount: crossCount,
                              mainAxisExtent: MediaQuery.sizeOf(context).width /
                                      crossCount /
                                      0.65 +
                                  MediaQuery.textScalerOf(context).scale(32.0),
                            ),
                            itemCount: filteredList.length,
                            itemBuilder: (context, index) {
                              return BangumiCardV(
                                enableHero: false,
                                bangumiItem: filteredList[index],
                              );
                            },
                          )),
                if (searchPageController.hasMore)
                  Padding(
                    padding: const EdgeInsets.all(8),
                    child: TextButton(
                      onPressed: searchPageController.isLoading
                          ? null
                          : () => searchPageController
                              .searchBangumi(searchController.text),
                      child: Text(searchPageController.isLoading
                          ? '正在加载…'
                          : searchPageController.searchMessage.isNotEmpty
                              ? searchPageController.searchMessage
                              : '加载更多'),
                    ),
                  ),
              ]);
            }),
          ),
        ],
      ),
    );
  }
}
