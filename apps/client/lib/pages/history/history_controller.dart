// ignore_for_file: library_private_types_in_public_api

import 'dart:async';

import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/modules/history/history_module.dart';
import 'package:kazumi/repositories/history_repository.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';
import 'package:kazumi/services/storage/storage.dart';
import 'package:mobx/mobx.dart';

part 'history_controller.g.dart';

class HistoryController = _HistoryController with _$HistoryController;

abstract class _HistoryController with Store {
  _HistoryController() {
    GStorage.accountChanges.listen((_) {
      _lastServerSync.clear();
      _lastLocalSave.clear();
      _pendingServerSync.clear();
      init();
    });
  }
  final _historyRepository = Modular.get<IHistoryRepository>();
  final Map<String, DateTime> _lastServerSync = {};
  final Map<String, Future<void>> _serverSyncInFlight = {};
  final Map<String, Future<void> Function()> _pendingServerSync = {};
  final Map<String, ({DateTime at, Duration position, Duration duration})>
      _lastLocalSave = {};

  @observable
  ObservableList<History> histories = ObservableList<History>();

  void init() => GStorage.runActiveAccountTask(_loadHistories);

  void _loadHistories() {
    final temp = _historyRepository.getAllHistories();
    histories.clear();
    histories.addAll(temp);
  }

  Future<void> updateHistory(
      PlaybackHistoryIdentity identity, Duration progress,
      {Duration duration = Duration.zero, bool force = false}) async {
    final account = AniWorldAccountSnapshot();
    if (_historyRepository.getPrivateMode() || !identity.canRecord) return;
    final localKey =
        '${account.owner}:${account.revision}:${identity.entryKind}:${identity.pluginName}:'
        '${identity.bangumiItem.id}:${identity.episodeNumber}:${identity.road}';
    final now = DateTime.now();
    final previousLocal = _lastLocalSave[localKey];
    if (previousLocal != null &&
        ((previousLocal.position == progress &&
                previousLocal.duration == duration) ||
            (!force &&
                now.difference(previousLocal.at) <
                    const Duration(seconds: 10)))) {
      return;
    }
    _lastLocalSave[localKey] =
        (at: now, position: progress, duration: duration);
    if (_lastLocalSave.length > 200) {
      _lastLocalSave.remove(_lastLocalSave.keys.first);
    }
    await _historyRepository.updateHistory(
      identity: identity,
      progress: progress,
    );
    if (account.isLoggedIn && !_historyRepository.getPrivateMode()) {
      final key =
          '${account.owner}:${account.revision}:${identity.bangumiItem.id}:${identity.episodeNumber}';
      final uploadKey =
          '${account.owner}:${account.revision}:${identity.bangumiItem.id}';
      final previous = _lastServerSync[key];
      if (!account.isCurrent) return;
      if (force ||
          previous == null ||
          now.difference(previous) >= const Duration(seconds: 20)) {
        Future<void> send() async {
          if (!account.isCurrent || _historyRepository.getPrivateMode()) return;
          await AniWorldApi.saveUserHistory(
            account: account,
            duration: duration,
            item: identity.bangumiItem,
            episode: identity.episodeNumber,
            progress: progress,
            episodeTitle: identity.episodeTitle,
            videoUrl: identity.episodePageUrl,
          );
          if (account.isCurrent) _lastServerSync[key] = now;
        }

        if (_serverSyncInFlight.containsKey(uploadKey)) {
          if (force) _pendingServerSync[uploadKey] = send;
        } else {
          _startServerSync(uploadKey, send);
        }
      }
    }
    if (!account.isCurrent) return;
    final updated = _historyRepository.getHistory(
        identity.pluginName, identity.bangumiItem,
        entryKind: identity.entryKind);
    if (updated != null) {
      histories.removeWhere((item) => item.key == updated.key);
      histories.insert(0, updated);
    }
  }

  void _startServerSync(String key, Future<void> Function() send) {
    late final Future<void> upload;
    upload = send().catchError((_) {}).whenComplete(() {
      if (!identical(_serverSyncInFlight[key], upload)) return;
      _serverSyncInFlight.remove(key);
      final next = _pendingServerSync.remove(key);
      if (next != null) _startServerSync(key, next);
    });
    _serverSyncInFlight[key] = upload;
    unawaited(upload);
  }

  Progress? lastWatching(
    BangumiItem bangumiItem,
    String adapterName, {
    String entryKind = HistoryEntryKind.online,
  }) {
    return _historyRepository.getLastWatchingProgress(
      bangumiItem,
      adapterName,
      entryKind: entryKind,
    );
  }

  History? getHistory(
    BangumiItem bangumiItem,
    String adapterName, {
    String entryKind = HistoryEntryKind.online,
  }) {
    return _historyRepository.getHistory(
      adapterName,
      bangumiItem,
      entryKind: entryKind,
    );
  }

  Progress? findProgress(
    BangumiItem bangumiItem,
    String adapterName,
    int episode, {
    String entryKind = HistoryEntryKind.online,
  }) {
    return _historyRepository.findProgress(
      bangumiItem,
      adapterName,
      episode,
      entryKind: entryKind,
    );
  }

  Future<void> deleteHistory(History history) async {
    await _historyRepository.deleteHistory(history);
    init();
  }

  /// Removes all local playback-history entries for an Agent action target.
  Future<void> deleteForAgent(int bangumiId) async {
    final targets = _historyRepository
        .getAllHistories()
        .where((item) => item.bangumiItem.id == bangumiId)
        .toList();
    for (final history in targets) {
      await _historyRepository.deleteHistory(history);
    }
    init();
  }

  Future<void> clearProgress(
    BangumiItem bangumiItem,
    String adapterName,
    int episode, {
    String entryKind = HistoryEntryKind.online,
  }) async {
    await _historyRepository.clearProgress(
      bangumiItem,
      adapterName,
      episode,
      entryKind: entryKind,
    );
    init();
  }

  Future<void> clearAll() async {
    await _historyRepository.clearAllHistories();
    histories.clear();
  }
}
