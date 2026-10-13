import 'dart:convert';
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/modules/notifications/update_notification.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/repositories/collect_crud_repository.dart';
import 'package:kazumi/repositories/history_repository.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';
import 'package:kazumi/services/logging/logger.dart';
import 'package:kazumi/services/storage/storage.dart';

class UpdateNotificationController extends ChangeNotifier {
  UpdateNotificationController() {
    GStorage.runActiveAccountTask(_loadPersistedState);
    _accountSubscription = GStorage.accountChanges.listen((_) {
      GStorage.runActiveAccountTask(_reloadAccount);
    });
  }

  static const _notificationsKey = 'updateNotificationsV1';
  static const _baselinesKey = 'updateNotificationBaselinesV1';
  static const Duration automaticCheckCooldown = Duration(minutes: 10);

  final ICollectCrudRepository _collectRepository =
      Modular.get<ICollectCrudRepository>();
  final IHistoryRepository _historyRepository =
      Modular.get<IHistoryRepository>();

  final List<UpdateNotificationItem> _notifications = [];
  final Map<int, TrackedAnimeBaseline> _baselines = {};
  DateTime? _lastCheckedAt;
  bool _checking = false;
  int _generation = 0;
  bool _disposed = false;
  late final StreamSubscription<void> _accountSubscription;

  void _reloadAccount() {
    if (_disposed) return;
    _generation++;
    _checking = false;
    _lastCheckedAt = null;
    _notifications.clear();
    _baselines.clear();
    _loadPersistedState();
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    unawaited(_accountSubscription.cancel());
    super.dispose();
  }

  List<UpdateNotificationItem> get notifications =>
      List.unmodifiable(_notifications);

  int get unreadCount =>
      _notifications.where((notification) => !notification.isRead).length;

  bool get isChecking => _checking;

  Future<void> checkForUpdates({bool force = false}) =>
      GStorage.runActiveAccountTask(() => _checkForUpdates(force: force));

  Future<void> _checkForUpdates({required bool force}) async {
    final account = AniWorldAccountSnapshot();
    final generation = _generation;
    bool current() =>
        !_disposed && generation == _generation && account.isCurrent;
    if (_checking || !current()) return;
    final now = DateTime.now();
    if (!force &&
        _lastCheckedAt != null &&
        now.difference(_lastCheckedAt!) < automaticCheckCooldown) {
      return;
    }

    _checking = true;
    _lastCheckedAt = now;
    notifyListeners();
    try {
      final tracked = _collectRepository
          .getAllCollectibles()
          .where((item) => isTrackedForUpdateReminder(item.type))
          .toList();
      final trackedIds = tracked.map((item) => item.bangumiItem.id).toSet();
      _baselines.removeWhere((animeId, _) => !trackedIds.contains(animeId));

      if (tracked.isEmpty) {
        _markUntrackedNotificationsRead(trackedIds);
        await _persist();
        return;
      }

      final resolved = await AniWorldApi.resolveSavedBangumiMetadata(
        tracked.map((item) => item.bangumiItem).toList(),
      );
      if (!current()) return;
      final byAnimeId = {
        for (final notification in _notifications)
          notification.animeId: notification,
      };
      final metadataUpdates = <BangumiItem>[];
      final nowMs = now.millisecondsSinceEpoch;

      for (final collected in tracked) {
        if (!current()) return;
        final saved = collected.bangumiItem;
        final latest = resolved[saved.id];
        if (latest == null) continue;

        // The resolve endpoint may migrate a legacy Bangumi ID to AniList.
        // Keep the local collection identity stable so history lookups match.
        latest.id = saved.id;
        final currentEpisode = latest.airedEpisodes;
        final currentStatus = latest.animeStatus.trim().toUpperCase();
        final baseline = _baselines[saved.id];

        if (baseline == null) {
          final savedEpisode = saved.airedEpisodes;
          final initialEpisode =
              savedEpisode > 0 ? savedEpisode : currentEpisode;
          final stableEpisode =
              currentEpisode > initialEpisode ? currentEpisode : initialEpisode;
          _baselines[saved.id] = TrackedAnimeBaseline(
            animeId: saved.id,
            lastEpisode: stableEpisode,
            status: currentStatus,
          );
          if (isCurrentlyReleasing(latest) &&
              currentEpisode > initialEpisode &&
              initialEpisode > 0) {
            byAnimeId[saved.id] = mergeUpdateNotification(
              existing: byAnimeId[saved.id],
              bangumiItem: latest,
              previousEpisode: initialEpisode,
              latestEpisode: currentEpisode,
              updatedAtMs: nowMs,
            );
          }
        } else {
          if (isCurrentlyReleasing(latest) &&
              currentEpisode > baseline.lastEpisode) {
            byAnimeId[saved.id] = mergeUpdateNotification(
              existing: byAnimeId[saved.id],
              bangumiItem: latest,
              previousEpisode: baseline.lastEpisode,
              latestEpisode: currentEpisode,
              updatedAtMs: nowMs,
            );
          }
          final stableEpisode = currentEpisode > baseline.lastEpisode
              ? currentEpisode
              : baseline.lastEpisode;
          _baselines[saved.id] = TrackedAnimeBaseline(
            animeId: saved.id,
            lastEpisode: stableEpisode,
            status: currentStatus.isNotEmpty ? currentStatus : baseline.status,
          );
        }

        final stableAiredEpisodes = latest.airedEpisodes >= saved.airedEpisodes
            ? latest.airedEpisodes
            : saved.airedEpisodes;
        final stableStatus = latest.animeStatus.trim().isNotEmpty
            ? latest.animeStatus
            : saved.animeStatus;
        final stableEpisodes =
            latest.episodes > 0 ? latest.episodes : saved.episodes;
        final stableAirDate =
            latest.airDate.isNotEmpty ? latest.airDate : saved.airDate;
        if (saved.animeStatus != stableStatus ||
            saved.episodes != stableEpisodes ||
            saved.airedEpisodes != stableAiredEpisodes ||
            saved.airDate != stableAirDate) {
          saved.animeStatus = stableStatus;
          saved.episodes = stableEpisodes;
          saved.airedEpisodes = stableAiredEpisodes;
          saved.airDate = stableAirDate;
          metadataUpdates.add(saved);
        }
      }

      if (!current()) return;

      _notifications
        ..clear()
        ..addAll(byAnimeId.values);
      _markUntrackedNotificationsRead(trackedIds);
      _markWatchedNotificationsRead();
      _trimOldReadNotifications(nowMs);
      _sortNotifications();
      // Commit the notification delta before another await. Later read/delete
      // actions operate on this live list; no stale map can overwrite them.
      notifyListeners();
      await _persist();
      for (final saved in metadataUpdates) {
        if (!current()) return;
        await _collectRepository.updateCollectible(saved);
      }
    } catch (error, stackTrace) {
      KazumiLogger().w(
        'Update reminder: check failed',
        error: error,
        stackTrace: stackTrace,
      );
    } finally {
      if (!_disposed && generation == _generation) {
        _checking = false;
        if (!account.isCurrent) _lastCheckedAt = null;
        notifyListeners();
      }
    }
  }

  Future<void> markRead(int animeId) async {
    final index = _notifications.indexWhere((item) => item.animeId == animeId);
    if (index < 0 || _notifications[index].isRead) return;
    _notifications[index] = _notifications[index].copyWith(isRead: true);
    notifyListeners();
    await _persist();
  }

  Future<void> markAllRead() async {
    var changed = false;
    for (var index = 0; index < _notifications.length; index++) {
      if (_notifications[index].isRead) continue;
      _notifications[index] = _notifications[index].copyWith(isRead: true);
      changed = true;
    }
    if (!changed) return;
    notifyListeners();
    await _persist();
  }

  Future<void> deleteNotification(int animeId) async {
    final before = _notifications.length;
    _notifications.removeWhere((item) => item.animeId == animeId);
    if (_notifications.length == before) return;
    notifyListeners();
    await _persist();
  }

  void _loadPersistedState() {
    for (final raw in GStorage.getStringListSettingByName(
        _accountKey(_notificationsKey))) {
      try {
        final value = jsonDecode(raw);
        if (value is Map) {
          _notifications.add(UpdateNotificationItem.fromJson(
            Map<String, dynamic>.from(value),
          ));
        }
      } catch (_) {}
    }
    for (final raw
        in GStorage.getStringListSettingByName(_accountKey(_baselinesKey))) {
      try {
        final value = jsonDecode(raw);
        if (value is Map) {
          final baseline = TrackedAnimeBaseline.fromJson(
            Map<String, dynamic>.from(value),
          );
          if (baseline.animeId > 0) _baselines[baseline.animeId] = baseline;
        }
      } catch (_) {}
    }
    _sortNotifications();
  }

  void _markUntrackedNotificationsRead(Set<int> trackedIds) {
    for (var index = 0; index < _notifications.length; index++) {
      final item = _notifications[index];
      if (!trackedIds.contains(item.animeId) && !item.isRead) {
        _notifications[index] = item.copyWith(isRead: true);
      }
    }
  }

  void _markWatchedNotificationsRead() {
    final watchedEpisodes = <int, int>{};
    for (final history in _historyRepository.getAllHistories()) {
      final animeId = history.bangumiItem.id;
      final previous = watchedEpisodes[animeId] ?? 0;
      if (history.lastWatchEpisode > previous) {
        watchedEpisodes[animeId] = history.lastWatchEpisode;
      }
    }
    for (var index = 0; index < _notifications.length; index++) {
      final item = _notifications[index];
      if (!item.isRead &&
          (watchedEpisodes[item.animeId] ?? 0) >= item.latestEpisode) {
        _notifications[index] = item.copyWith(isRead: true);
      }
    }
  }

  void _trimOldReadNotifications(int nowMs) {
    const retention = Duration(days: 90);
    _notifications.removeWhere(
      (item) =>
          item.isRead && nowMs - item.updatedAtMs > retention.inMilliseconds,
    );
    _sortNotifications();
    if (_notifications.length > 100) {
      _notifications.removeRange(100, _notifications.length);
    }
  }

  void _sortNotifications() {
    _notifications.sort((a, b) => b.updatedAtMs.compareTo(a.updatedAtMs));
  }

  Future<void> _persist() async {
    await Future.wait([
      GStorage.putStringListSettingByName(
        _accountKey(_notificationsKey),
        _notifications.map((item) => jsonEncode(item.toJson())).toList(),
      ),
      GStorage.putStringListSettingByName(
        _accountKey(_baselinesKey),
        _baselines.values
            .map((baseline) => jsonEncode(baseline.toJson()))
            .toList(),
      ),
    ]);
  }

  // Legacy global reminders have no trustworthy owner. Preserve them on disk,
  // but never assign them to whichever account happens to be logged in.
  String _accountKey(String key) => '${key}_${GStorage.accountOwner}';
}
