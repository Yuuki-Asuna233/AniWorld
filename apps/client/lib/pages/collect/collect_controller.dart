// ignore_for_file: library_private_types_in_public_api

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:kazumi/bean/dialog/dialog_helper.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/modules/collect/collect_module.dart';
import 'package:kazumi/modules/collect/collect_type.dart';
import 'package:kazumi/services/sync/bangumi_sync_service.dart';
import 'package:kazumi/services/storage/storage.dart';
import 'package:kazumi/services/sync/webdav.dart';
import 'package:kazumi/repositories/collect_crud_repository.dart';
import 'package:kazumi/repositories/collect_repository.dart';
import 'package:mobx/mobx.dart';
import 'package:kazumi/services/logging/logger.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';
import 'package:kazumi/pages/notifications/update_notification_controller.dart';

part 'collect_controller.g.dart';

// Define actions for handling Bangumi collect deletion.
enum _BangumiDeleteSyncAction {
  deleteLocalOnly,
  markAbandoned,
  openWeb,
  cancel,
}

class CollectController = _CollectController with _$CollectController;

abstract class _CollectController with Store {
  _CollectController() {
    GStorage.accountChanges.listen((_) => loadCollectibles());
  }
  final _collectCrudRepository = Modular.get<ICollectCrudRepository>();
  final _collectRepository = Modular.get<ICollectRepository>();
  int _metadataRefreshGeneration = 0;

  List<BangumiItem> get favorites => _collectCrudRepository.getFavorites();

  @observable
  ObservableList<CollectedBangumi> collectibles =
      ObservableList<CollectedBangumi>();

  void loadCollectibles() => GStorage.runActiveAccountTask(_loadCollectibles);

  void _loadCollectibles() {
    final generation = ++_metadataRefreshGeneration;
    final loaded = _collectCrudRepository.getAllCollectibles();
    collectibles.clear();
    collectibles.addAll(loaded);
    if (loaded.isNotEmpty) {
      unawaited(_refreshSavedMetadata(loaded, generation));
    }
  }

  Future<void> _refreshSavedMetadata(
    List<CollectedBangumi> loaded,
    int generation,
  ) async {
    final account = AniWorldAccountSnapshot();
    try {
      final metadata = await AniWorldApi.resolveSavedBangumiMetadata(
        loaded.map((item) => item.bangumiItem).toList(),
      );
      if (metadata.isEmpty ||
          !account.isCurrent ||
          generation != _metadataRefreshGeneration) {
        return;
      }
      for (final collected in loaded) {
        if (!account.isCurrent || generation != _metadataRefreshGeneration) {
          return;
        }
        final latest = metadata[collected.bangumiItem.id];
        if (latest == null) continue;
        final saved = collected.bangumiItem;
        saved.animeStatus = latest.animeStatus;
        saved.episodes = latest.episodes;
        saved.airedEpisodes = latest.airedEpisodes;
        if (latest.airDate.isNotEmpty) saved.airDate = latest.airDate;
        final latestCover = latest.images['large']?.trim() ?? '';
        if (latestCover.isNotEmpty) {
          final images = {...saved.images, ...latest.images};
          final fallback = images['fallback']?.trim() ?? '';
          if (fallback.isEmpty || fallback == latestCover) {
            images['fallback'] = [
              saved.images['large'],
              saved.images['fallback'],
            ].whereType<String>().map((url) => url.trim()).firstWhere(
                  (url) => url.isNotEmpty && url != latestCover,
                  orElse: () => '',
                );
          }
          saved.images = images;
        }
        await _collectCrudRepository.updateCollectible(saved);
      }
      if (!account.isCurrent || generation != _metadataRefreshGeneration) {
        return;
      }
      collectibles
        ..clear()
        ..addAll(_collectCrudRepository.getAllCollectibles());
    } catch (error) {
      KazumiLogger().w(
        'Collect: refresh saved anime metadata failed',
        error: error,
      );
    }
  }

  int getCollectType(BangumiItem bangumiItem) {
    return _collectCrudRepository.getCollectType(bangumiItem.id);
  }

  BangumiItem? getCollectibleBangumiItem(int id) {
    return _collectCrudRepository.getCollectible(id)?.bangumiItem;
  }

  @action
  Future<void> addCollect(BangumiItem bangumiItem, {type = 1}) =>
      GStorage.runAccountTask(() => _addCollect(bangumiItem, type: type));

  Future<void> _addCollect(BangumiItem bangumiItem, {type = 1}) async {
    final account = AniWorldAccountSnapshot();
    if (type == 0) {
      await deleteCollect(bangumiItem);
      return;
    }

    // 1. Sync with Bangumi if enabled
    final bool syncSucceeded = await _syncBangumiCollectIfEnabled(
      bangumiItem.id,
      type,
    );
    if (!syncSucceeded || !account.isCurrent) {
      return;
    }

    final int currentCollectType = getCollectType(bangumiItem);
    final int collectChangeAction = currentCollectType == 0 ? 1 : 2;

    // 2. Update local database and change logs
    await _collectCrudRepository.addCollectible(bangumiItem, type);
    unawaited(AniWorldApi.addUserFavorite(bangumiItem, account: account)
        .catchError((_) {}));
    await GStorage.appendCollectChange(
      bangumiId: bangumiItem.id,
      action: collectChangeAction,
      type: type,
    );
    loadCollectibles();
    unawaited(
      Modular.get<UpdateNotificationController>().checkForUpdates(force: true),
    );
  }

  @action
  Future<void> deleteCollect(BangumiItem bangumiItem) =>
      GStorage.runAccountTask(() => _deleteCollect(bangumiItem));

  Future<void> _deleteCollect(BangumiItem bangumiItem) async {
    final account = AniWorldAccountSnapshot();
    // Resolve how to handle deletion with user
    final action = await _resolveBangumiDeleteSyncAction(bangumiItem);
    if (!account.isCurrent) return;
    switch (action) {
      case _BangumiDeleteSyncAction.markAbandoned:
        await addCollect(
          bangumiItem,
          type: CollectType.abandoned.value,
        );
        return;

      case _BangumiDeleteSyncAction.openWeb:
        await _deleteCollectLocally(bangumiItem);
        await _openBangumiSubjectPage(bangumiItem.id);
        return;

      case _BangumiDeleteSyncAction.deleteLocalOnly:
        await _deleteCollectLocally(bangumiItem);
        return;

      case _BangumiDeleteSyncAction.cancel:
      case null:
        return;
    }
  }

  /// Removes a collectible after an already-confirmed Agent action.
  /// This deliberately skips the interactive Bangumi deletion dialog; the
  /// confirmation was shown by the Agent UI before the action was executed.
  Future<void> removeCollectForAgent(BangumiItem bangumiItem) async {
    await applyAgentCollect(bangumiItem, remove: true);
  }

  /// Mirrors a completed server operation without issuing a second remote write.
  Future<void> applyAgentCollect(BangumiItem bangumiItem,
      {bool remove = false, int type = 1}) async {
    if (remove) {
      await _collectCrudRepository.deleteCollectible(bangumiItem.id);
    } else {
      await _collectCrudRepository.addCollectible(bangumiItem, type);
    }
    loadCollectibles();
    unawaited(Modular.get<UpdateNotificationController>()
        .checkForUpdates(force: true));
  }

  Future<void> _deleteCollectLocally(BangumiItem bangumiItem) async {
    final account = AniWorldAccountSnapshot();
    await _collectCrudRepository.deleteCollectible(bangumiItem.id);
    unawaited(AniWorldApi.removeUserFavorite(
            '${AniWorldApi.userAnimeIdentity(bangumiItem)['anime_id']}',
            account: account)
        .catchError((_) {}));
    await GStorage.appendCollectChange(
      bangumiId: bangumiItem.id,
      action: 3,
      type: 5,
    );
    loadCollectibles();
    unawaited(
      Modular.get<UpdateNotificationController>().checkForUpdates(force: true),
    );
  }

  Future<_BangumiDeleteSyncAction?> _resolveBangumiDeleteSyncAction(
      BangumiItem bangumiItem) async {
    final bool syncEnable = GStorage.getSetting(SettingsKeys.bangumiSyncEnable);
    if (!syncEnable) {
      return _BangumiDeleteSyncAction.deleteLocalOnly;
    }

    final bangumi = BangumiSyncService();
    if (!bangumi.initialized) {
      return _BangumiDeleteSyncAction.deleteLocalOnly;
    }

    return KazumiDialog.show<_BangumiDeleteSyncAction>(
      clickMaskDismiss: true,
      builder: (context) => AlertDialog(
        title: const Text('Bangumi 不支持删除收藏'),
        content: const Text(
          '因为安全考虑，Bangumi 未提供删除接口，您可以选择把本地和远端标记为“抛弃”，或者选择仅删除本地收藏并打开网页后手动删除 Bangumi 数据。',
        ),
        actions: [
          TextButton(
            onPressed: () {
              Navigator.of(context).pop(_BangumiDeleteSyncAction.cancel);
            },
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () {
              Navigator.of(context).pop(_BangumiDeleteSyncAction.openWeb);
            },
            child: const Text('打开网页'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.of(context).pop(_BangumiDeleteSyncAction.markAbandoned);
            },
            child: const Text('标记为抛弃'),
          ),
        ],
      ),
    );
  }

  Future<void> _openBangumiSubjectPage(int bangumiId) async {
    final url = Uri.parse('https://bangumi.tv/subject/$bangumiId');
    if (await canLaunchUrl(url)) {
      await launchUrl(url, mode: LaunchMode.externalApplication);
      return;
    }
    KazumiDialog.showToast(message: '无法打开 Bangumi 网页');
  }

  Future<bool> _syncBangumiCollectIfEnabled(
      int bangumiId, int localType) async {
    final bool syncEnable = GStorage.getSetting(SettingsKeys.bangumiSyncEnable);
    final bool showImmediateSyncToast =
        GStorage.getSetting(SettingsKeys.bangumiImmediateSyncToastEnable);

    if (!syncEnable) {
      return true;
    }

    final bangumi = BangumiSyncService();
    if (!bangumi.initialized) {
      KazumiDialog.showToast(message: 'Bangumi 未初始化，同步失败，已取消本次状态修改');
      KazumiLogger().w(
        'Bangumi: immediate collect sync skipped because Bangumi is not initialized. '
        'bangumiId=$bangumiId, type=$localType',
      );
      return false;
    }
    try {
      if (showImmediateSyncToast) {
        KazumiDialog.showToast(message: '正在同步到 Bangumi...');
      }
      final bool synced =
          await bangumi.syncCollectibleWhenIdle(bangumiId, localType);
      if (synced && showImmediateSyncToast) {
        KazumiDialog.showToast(message: '已同步到 Bangumi');
        return true;
      } else if (!synced) {
        KazumiDialog.showToast(message: '同步到 Bangumi 失败，已取消本次状态修改');
        KazumiLogger().w(
          'Bangumi: immediate collect sync did not complete. bangumiId=$bangumiId, type=$localType',
        );
        return false;
      }
      return true;
    } catch (e, stackTrace) {
      KazumiDialog.showToast(message: '同步到 Bangumi 失败，已取消本次状态修改: $e');
      KazumiLogger().e(
        'Bangumi: immediate collect sync failed. bangumiId=$bangumiId, type=$localType',
        error: e,
        stackTrace: stackTrace,
      );
      return false;
    }
  }

  Future<void> updateLocalCollect(BangumiItem bangumiItem) async {
    await _collectCrudRepository.updateCollectible(bangumiItem);
    loadCollectibles();
  }

  Future<bool> syncCollectibles({bool showSuccessToast = true}) async {
    final bool webDavCollectEnable =
        GStorage.getSetting(SettingsKeys.webDavEnableCollect);
    if (!webDavCollectEnable) {
      KazumiDialog.showToast(message: '未开启WebDav收藏同步');
      return false;
    }
    if (!WebDav().initialized) {
      KazumiDialog.showToast(message: '未开启WebDav同步或配置无效');
      return false;
    }
    bool flag = true;
    try {
      await WebDav().ping();
    } catch (e) {
      KazumiLogger().e('WebDav: WebDav connection failed', error: e);
      KazumiDialog.showToast(message: 'WebDav连接失败: $e');
      flag = false;
    }
    if (!flag) {
      return false;
    }
    try {
      await WebDav().syncCollectibles();
      if (showSuccessToast) {
        KazumiDialog.showToast(message: 'WebDav同步完成');
      }
    } catch (e) {
      KazumiDialog.showToast(message: 'WebDav同步失败 $e');
      return false;
    }
    loadCollectibles();
    return true;
  }

  /// Only upload local collectibles and change logs to WebDAV, without downloading and merging.
  /// Used by full sync to push Bangumi-updated local changes back to WebDAV.
  Future<bool> uploadCollectiblesToWebDav(
      {bool showSuccessToast = true}) async {
    final bool webDavCollectEnable =
        GStorage.getSetting(SettingsKeys.webDavEnableCollect);
    if (!webDavCollectEnable) {
      KazumiDialog.showToast(message: '未开启WebDav收藏同步');
      return false;
    }
    if (!WebDav().initialized) {
      KazumiDialog.showToast(message: '未开启WebDav同步或配置无效');
      return false;
    }
    bool flag = true;
    try {
      await WebDav().ping();
    } catch (e) {
      KazumiLogger().e('WebDav: WebDav connection failed', error: e);
      KazumiDialog.showToast(message: 'WebDav连接失败: $e');
      flag = false;
    }
    if (!flag) {
      return false;
    }
    try {
      await WebDav().updateCollectibles();
      if (showSuccessToast) {
        KazumiDialog.showToast(message: 'WebDav上传完成');
      }
    } catch (e) {
      KazumiDialog.showToast(message: 'WebDav上传失败 $e');
      return false;
    }
    return true;
  }

  // migrate collect from old version (favorites)
  Future<void> migrateCollect() async {
    if (favorites.isNotEmpty) {
      int count = 0;
      for (BangumiItem bangumiItem in favorites) {
        // Migration should never depend on runtime Bangumi initialization.
        // Persist locally and append change logs, then let later sync handle remote updates.
        final int currentCollectType = getCollectType(bangumiItem);
        final int collectChangeAction = currentCollectType == 0 ? 1 : 2;
        await _collectCrudRepository.addCollectible(bangumiItem, 1);
        await GStorage.appendCollectChange(
          bangumiId: bangumiItem.id,
          action: collectChangeAction,
          type: 1,
        );
        count++;
      }
      await _collectCrudRepository.clearFavorites();
      loadCollectibles();
      KazumiLogger().d(
          'GStorage: detected $count uncategorized favorites, migrated to collectibles');
    }
  }

  /// 根据收藏类型获取番剧ID集合
  ///
  /// [type] 收藏类型
  /// 返回番剧ID集合
  Set<int> getBangumiIdsByType(CollectType type) {
    return _collectRepository.getBangumiIdsByType(type);
  }

  /// 过滤掉指定收藏类型的番剧
  ///
  /// [bangumiList] 原始番剧列表
  /// [excludeType] 要排除的收藏类型
  /// 返回过滤后的番剧列表
  List<BangumiItem> filterBangumiByType(
      List<BangumiItem> bangumiList, CollectType excludeType) {
    final excludeIds = getBangumiIdsByType(excludeType);
    return bangumiList.where((item) => !excludeIds.contains(item.id)).toList();
  }

  /// Sync Bangumi collectibles.
  Future<bool> syncCollectiblesBangumi(
      {void Function(String message, int current, int total)? onProgress,
      bool showSuccessToast = true}) async {
    final bool syncEnable = GStorage.getSetting(SettingsKeys.bangumiSyncEnable);
    if (!syncEnable) {
      KazumiDialog.showToast(message: '未开启Bangumi同步，请先在设置中启用');
      return false;
    }

    if (!BangumiSyncService().initialized) {
      KazumiDialog.showToast(message: 'Bangumi同步已开启但未初始化，请检查Token后重试');
      return false;
    }
    try {
      await BangumiSyncService().ping();
      try {
        final hasChanges =
            await BangumiSyncService().syncCollectibles(onProgress: onProgress);
        if (showSuccessToast) {
          KazumiDialog.showToast(
            message: hasChanges ? 'Bangumi同步完成' : '未发现状态差异，无需同步',
          );
        }
      } catch (e) {
        KazumiDialog.showToast(message: 'Bangumi同步失败 $e');
        return false;
      }
    } catch (e) {
      KazumiLogger().e('Bangumi: Bangumi connection failed', error: e);
      KazumiDialog.showToast(message: 'Bangumi访问失败: $e');
      return false;
    }
    loadCollectibles();
    return true;
  }
}
