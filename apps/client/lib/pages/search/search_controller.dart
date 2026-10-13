// ignore_for_file: library_private_types_in_public_api

import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';

import 'package:flutter_modular/flutter_modular.dart';
import 'package:mobx/mobx.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/modules/collect/collect_type.dart';
import 'package:kazumi/modules/search/image_search_module.dart';
import 'package:kazumi/modules/search/search_history_module.dart';
import 'package:kazumi/repositories/collect_repository.dart';
import 'package:kazumi/repositories/search_history_repository.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';
import 'package:kazumi/request/apis/catalog_search_api.dart';
import 'package:kazumi/request/apis/trace_api.dart';
import 'package:kazumi/utils/search_parser.dart';
import 'package:kazumi/pages/search/search_result_identity.dart';

part 'search_controller.g.dart';

enum SearchOutcome {
  idle,
  results,
  empty,
  networkError,
  protocolError,
  invalidQuery
}

class SearchPageController = _SearchPageController with _$SearchPageController;

abstract class _SearchPageController with Store {
  final _collectRepository = Modular.get<ICollectRepository>();
  final _searchHistoryRepository = Modular.get<ISearchHistoryRepository>();
  int _searchGeneration = 0;
  SearchFilterState? _catalogFilters;
  Set<int> _excludedIds = {};
  AniWorldAccountSnapshot? _catalogAccount;
  String _catalogServer = '';
  String _catalogQuery = '';
  int _nextPage = 1;

  @observable
  bool isLoading = false;

  @observable
  SearchOutcome outcome = SearchOutcome.idle;

  @observable
  bool hasMore = false;

  @observable
  String searchMessage = '';

  @observable
  bool notShowWatchedBangumis = false;

  @observable
  bool notShowAbandonedBangumis = false;

  @observable
  ObservableList<BangumiItem> bangumiList = ObservableList.of([]);

  @observable
  ObservableList<SearchHistory> searchHistories = ObservableList.of([]);

  @observable
  bool isImageSearching = false;

  @observable
  String imageSearchError = '';

  @observable
  ObservableList<ResultItem> imageSearchResults = ObservableList.of([]);

  @action
  void loadSearchHistories() {
    final histories = _searchHistoryRepository.getAllHistories();
    searchHistories.clear();
    searchHistories.addAll(histories);
  }

  @action
  Future<void> searchBangumi(String input,
      {String type = 'add', bool forceRefresh = false}) async {
    if (type == 'add') {
      if (_catalogFilters != null && input != _catalogQuery) {
        await searchBangumi(input, type: 'init', forceRefresh: forceRefresh);
        return;
      }
      await _loadMore();
      return;
    }
    final generation = ++_searchGeneration;
    _catalogFilters = null;
    hasMore = false;
    searchMessage = '';
    bangumiList.clear();
    isLoading = true;
    outcome = SearchOutcome.idle;
    final parser = SearchParser(input);
    final invalid = parser.validationError;
    if (invalid != null) {
      searchMessage = invalid;
      outcome = SearchOutcome.invalidQuery;
      isLoading = false;
      return;
    }
    if (!_collectRepository.getPrivateMode()) {
      unawaited(_recordSearchHistory(input));
    }
    final filterState = parser.toFilterState();
    final server = AniWorldApi.serverAddress;
    final account = AniWorldAccountSnapshot();
    final isCatalog = filterState.isIdSearch || filterState.hasAdvancedFilters;
    bool current() =>
        generation == _searchGeneration &&
        server == AniWorldApi.serverAddress &&
        (!isCatalog || account.isCurrent);
    try {
      final List<BangumiItem> result;
      if (isCatalog) {
        _catalogFilters = filterState;
        _catalogAccount = account;
        _catalogServer = server;
        _catalogQuery = input;
        _excludedIds = {
          if (notShowWatchedBangumis) ...loadWatchedBangumiIds(),
          if (notShowAbandonedBangumis) ...loadAbandonedBangumiIds(),
        };
        final response = await CatalogSearchApi.search(filterState,
            page: 1, excludeIds: _excludedIds);
        if (!current()) {
          return;
        }
        result = response.items;
        hasMore = response.hasMore;
        _nextPage = 2;
      } else {
        result = await AniWorldApi.searchOi(filterState.keyword,
            forceRefresh: forceRefresh);
      }
      if (!current()) {
        return;
      }
      bangumiList.addAll(isCatalog
          ? _uniqueCatalogItems(result)
          : deduplicateSearchResults(result));
      outcome =
          bangumiList.isEmpty ? SearchOutcome.empty : SearchOutcome.results;
    } on CatalogSearchInputException catch (error) {
      if (current()) {
        searchMessage = error.message;
        outcome = SearchOutcome.invalidQuery;
      }
    } on FormatException {
      if (current()) outcome = SearchOutcome.protocolError;
    } on DioException {
      if (current()) outcome = SearchOutcome.networkError;
    } catch (_) {
      if (current()) outcome = SearchOutcome.protocolError;
    } finally {
      if (generation == _searchGeneration) isLoading = false;
    }
  }

  Future<void> _loadMore() async {
    final filters = _catalogFilters;
    final account = _catalogAccount;
    if (filters == null ||
        account == null ||
        !hasMore ||
        isLoading ||
        !account.isCurrent ||
        _catalogServer != AniWorldApi.serverAddress) {
      return;
    }
    final generation = _searchGeneration;
    isLoading = true;
    searchMessage = '';
    try {
      final response = await CatalogSearchApi.search(filters,
          page: _nextPage, excludeIds: _excludedIds);
      if (generation != _searchGeneration ||
          !account.isCurrent ||
          _catalogServer != AniWorldApi.serverAddress) {
        return;
      }
      bangumiList = ObservableList.of(
          _uniqueCatalogItems([...bangumiList, ...response.items]));
      _nextPage++;
      hasMore = response.hasMore;
    } catch (_) {
      if (generation == _searchGeneration &&
          account.isCurrent &&
          _catalogServer == AniWorldApi.serverAddress) {
        searchMessage = '加载下一页失败，点击重试';
      }
    } finally {
      if (generation == _searchGeneration) isLoading = false;
    }
  }

  // Titles can collide across distinct catalogue entries; directory IDs cannot.
  List<BangumiItem> _uniqueCatalogItems(List<BangumiItem> items) {
    final seen = <int>{};
    return items.where((item) => seen.add(item.id)).toList();
  }

  Future<void> _recordSearchHistory(String input) async {
    try {
      if (_searchHistoryRepository.isHistoryFull(10)) {
        await _searchHistoryRepository.deleteOldest();
      }
      await _searchHistoryRepository.deleteDuplicates(input);
      await _searchHistoryRepository.saveHistory(input);
      loadSearchHistories();
    } catch (_) {}
  }

  void cancelPendingSearch() {
    _searchGeneration++;
  }

  @action
  Future<void> deleteSearchHistory(SearchHistory history) async {
    await _searchHistoryRepository.deleteHistory(history);
    loadSearchHistories();
  }

  @action
  Future<void> clearSearchHistory() async {
    await _searchHistoryRepository.clearAllHistories();
    loadSearchHistories();
  }

  @action
  void clearImageSearchState() {
    isImageSearching = false;
    imageSearchError = '';
    imageSearchResults.clear();
  }

  @action
  Future<void> searchImageByFile(File imageFile) async {
    isImageSearching = true;
    imageSearchError = '';
    imageSearchResults.clear();
    try {
      final result = await TraceApi.searchAnimeByImageFile(imageFile);
      imageSearchResults.addAll(result.result ?? []);
      if (result.error != null && result.error!.isNotEmpty) {
        imageSearchError = result.error!;
      } else if (imageSearchResults.isEmpty) {
        imageSearchError = '未找到匹配结果';
      }
    } catch (e) {
      imageSearchError = '图片搜索失败，请稍后重试';
    } finally {
      isImageSearching = false;
    }
  }

  @action
  Future<void> searchImageByUrl(String imageUrl) async {
    isImageSearching = true;
    imageSearchError = '';
    imageSearchResults.clear();
    try {
      final result = await TraceApi.searchAnimeByImageUrl(imageUrl);
      imageSearchResults.addAll(result.result ?? []);
      if (result.error != null && result.error!.isNotEmpty) {
        imageSearchError = result.error!;
      } else if (imageSearchResults.isEmpty) {
        imageSearchError = '未找到匹配结果';
      }
    } catch (e) {
      imageSearchError = '图片搜索失败，请检查图片地址或稍后重试';
    } finally {
      isImageSearching = false;
    }
  }

  @action
  Future<void> setNotShowWatchedBangumis(bool value) async {
    notShowWatchedBangumis = value;
  }

  @action
  Future<void> setNotShowAbandonedBangumis(bool value) async {
    notShowAbandonedBangumis = value;
  }

  Set<int> loadWatchedBangumiIds() {
    return _collectRepository.getBangumiIdsByType(CollectType.watched);
  }

  Set<int> loadAbandonedBangumiIds() {
    return _collectRepository.getBangumiIdsByType(CollectType.abandoned);
  }
}
