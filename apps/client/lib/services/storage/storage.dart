import 'dart:async';
import 'dart:io';
import 'dart:convert';
import 'package:hive_ce/hive.dart';
import 'package:kazumi/services/logging/logger.dart';
import 'package:path_provider/path_provider.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/hive_registrar.g.dart';
import 'package:kazumi/modules/history/history_module.dart';
import 'package:kazumi/modules/collect/collect_module.dart';
import 'package:kazumi/modules/collect/collect_change_module.dart';
import 'package:kazumi/modules/collect/collect_sync_merger.dart';
import 'package:kazumi/modules/search/search_history_module.dart';
import 'package:kazumi/modules/download/download_module.dart';

import 'package:kazumi/services/storage/settings_keys.dart';
import 'package:kazumi/services/storage/account_identity.dart';
export 'package:kazumi/services/storage/settings_keys.dart';

class GStorage {
  /// Don't use favorites box, it's replaced by collectibles.
  static Box<BangumiItem> get favorites => _scope.favorites;
  static Box<CollectedBangumi> get collectibles => _scope.collectibles;
  static Box<History> get histories => _scope.histories;
  static Box<CollectedBangumiChange> get collectChanges =>
      _scope.collectChanges;
  static late Box<String> shieldList;
  static late final Box<dynamic> _setting;
  static late Box<SearchHistory> searchHistory;
  static late Box<DownloadRecord> downloads;

  static late _AccountData _activeData;
  static _AccountData get _scope =>
      Zone.current[#accountData] as _AccountData? ?? _activeData;
  static String get accountOwner => _scope.owner;
  static String get activeAccountOwner => _activeData.owner;

  /// Physical namespace preserves the original backend's boxes and sidecars.
  static String get accountStorageOwner => _scope.boxOwner;
  static AccountIdentity get accountIdentity => _scope.identity;
  static int accountRevision = 0;
  static bool accountChanging = false;
  static final _accountChanges = StreamController<void>.broadcast(sync: true);
  static Stream<void> get accountChanges => _accountChanges.stream;
  static bool get isLegacyAccount =>
      _scope.boxOwner == _setting.get('accountDataLegacyOwner');
  static String accountBoxName(String name) =>
      isLegacyAccount ? name : '${name}_${_scope.boxOwner}';

  // Async tasks keep their original boxes across account switches, including
  // queued writes and WebDAV merges. Device settings remain shared.
  static T runAccountTask<T>(T Function() operation) =>
      runZoned(operation, zoneValues: {#accountData: _scope});

  static T runActiveAccountTask<T>(T Function() operation) =>
      runZoned(operation, zoneValues: {#accountData: _activeData});

  static Future<_AccountData> _openAccount(AccountIdentity identity) async {
    // Existing boxes stay associated with the backend used at the upgrade.
    // Alias them instead of copying HiveObjects between boxes.
    final boxOwner =
        identity.serverId == _setting.get('accountDataLegacyServerId')
            ? identity.localOwner
            : identity.owner;
    final legacy = boxOwner == _setting.get('accountDataLegacyOwner');
    String name(String base) => legacy ? base : '${base}_$boxOwner';
    return _AccountData(
        identity,
        boxOwner,
        await _openBoxSafe<BangumiItem>(name('favorites')),
        await _openBoxSafe<CollectedBangumi>(name('collectibles')),
        await _openBoxSafe<History>(name('histories')),
        await _openBoxSafe<CollectedBangumiChange>(name('collectchanges')));
  }

  static Future<void> switchAccount(int? userId, String token, String userJson,
      {String? serverAddress, void Function()? onCommitted}) async {
    final identity = AccountIdentity(
        serverAddress ?? _activeData.identity.serverAddress, userId);
    final changed = identity.owner != activeAccountOwner ||
        token != getSetting(SettingsKeys.aniworldToken);
    // Callers serialize transitions with the history lock. Invalidate requests
    // before opening boxes or waiting for pending collection writes.
    accountChanging = true;
    if (changed) accountRevision++;
    try {
      final next = identity.owner != activeAccountOwner
          ? await _openAccount(identity)
          : _activeData;
      await _runCollectChangesWriteExclusive(() async {
        await _setting.putAll({
          SettingsKeys.aniworldToken.name: token,
          SettingsKeys.aniworldUserJson.name: userJson,
          if (serverAddress != null) ...{
            SettingsKeys.serverBaseUrl.name: serverAddress,
            SettingsKeys.accessGateToken.name: '',
            SettingsKeys.accessGatePublicServer.name: '',
          },
        });
        if (identity.owner != activeAccountOwner) {
          _collectChangeIdInitialized = false;
        }
        _activeData = next;
        onCommitted?.call();
      });
    } finally {
      accountChanging = false;
    }
    if (changed) _accountChanges.add(null);
  }

  /// Hive directory path, initialized during init()
  static String? _hivePath;

  /// Queue to serialize write operations
  static Future<void> _collectChangesWriteQueue = Future.value();

  /// Next ID
  static int _nextCollectChangeId = 0;

  /// Flag to indicate if the next ID has initialized
  static bool _collectChangeIdInitialized = false;
  static String? _collectChangeOwner;

  /// Ensure collect-related write sequentially
  static Future<T> _runCollectChangesWriteExclusive<T>(
    Future<T> Function() action,
  ) =>
      runAccountTask(() => _enqueueCollectWrite(action));

  static Future<T> _enqueueCollectWrite<T>(Future<T> Function() action) {
    final completer = Completer<T>();
    final previousWrite = _collectChangesWriteQueue;

    _collectChangesWriteQueue = (() async {
      try {
        await previousWrite;
      } catch (_) {}

      try {
        completer.complete(await action());
      } catch (e, stackTrace) {
        completer.completeError(e, stackTrace);
      }
    })();

    return completer.future;
  }

  /// init id generator
  static void _initializeNextCollectChangeIdLocked() {
    if (_collectChangeIdInitialized && _collectChangeOwner == accountOwner) {
      return;
    }

    var maxExistingId = 0;
    for (final key in collectChanges.keys) {
      if (key is int && key > maxExistingId) {
        maxExistingId = key;
      }
    }

    _nextCollectChangeId = maxExistingId;
    _collectChangeOwner = accountOwner;
    _collectChangeIdInitialized = true;
  }

  /// Generate id for collect change
  static int _generateCollectChangeIdLocked() {
    _initializeNextCollectChangeIdLocked();

    final currentSeconds = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    // Ensure ID is greater than any existing ID, or equal to current timestamp.
    var nextId = _nextCollectChangeId < currentSeconds
        ? currentSeconds
        : _nextCollectChangeId + 1;
    while (collectChanges.containsKey(nextId)) {
      nextId++;
    }
    _nextCollectChangeId = nextId;
    return nextId;
  }

  /// Append a new collect change
  static Future<CollectedBangumiChange> appendCollectChange({
    required int bangumiId,
    required int action,
    required int type,
    int? timestamp,
  }) {
    return _runCollectChangesWriteExclusive(() async {
      final change = CollectedBangumiChange(
        _generateCollectChangeIdLocked(),
        bangumiId,
        action,
        type,
        timestamp ?? (DateTime.now().millisecondsSinceEpoch ~/ 1000),
      );
      await collectChanges.put(change.id, change);
      await collectChanges.flush();
      return change;
    });
  }

  /// Update an existing collect change
  static Future<void> putCollectChange(CollectedBangumiChange change) {
    return _runCollectChangesWriteExclusive(() async {
      _initializeNextCollectChangeIdLocked();
      if (change.id > _nextCollectChangeId) {
        _nextCollectChangeId = change.id;
      }
      await collectChanges.put(change.id, change);
      await collectChanges.flush();
    });
  }

  /// Put a collectible using the same write queue
  static Future<void> putCollectible(CollectedBangumi collectible) {
    return _runCollectChangesWriteExclusive(() async {
      await collectibles.put(collectible.bangumiItem.id, collectible);
      await collectibles.flush();
    });
  }

  /// Delete a collectible using the shared collect write queue.
  static Future<void> deleteCollectible(int bangumiId) {
    return _runCollectChangesWriteExclusive(() async {
      await collectibles.delete(bangumiId);
      await collectibles.flush();
    });
  }

  static Future init({String? hivePath}) async {
    _hivePath =
        hivePath ?? '${(await getApplicationSupportDirectory()).path}/hive';

    Hive.registerAdapters();

    _setting = await _openBoxSafe<dynamic>('setting');
    int? userId;
    try {
      final raw = jsonDecode(getSetting(SettingsKeys.aniworldUserJson));
      final id = raw['id'];
      if (getSetting(SettingsKeys.aniworldToken).trim().isNotEmpty &&
          id is int &&
          id > 0) {
        userId = id;
      }
    } catch (_) {}
    final identity =
        AccountIdentity(getSetting(SettingsKeys.serverBaseUrl), userId);
    if (!_setting.containsKey('accountDataLegacyOwner')) {
      await _setting.put('accountDataLegacyOwner', identity.localOwner);
    }
    if (!_setting.containsKey('accountDataLegacyServerId')) {
      await _setting.put('accountDataLegacyServerId', identity.serverId);
    }
    _activeData = await _openAccount(identity);
    await Future.wait<void>([
      _openBoxSafe<String>('shieldList').then((value) => shieldList = value),
      _openBoxSafe<SearchHistory>('searchHistory')
          .then((value) => searchHistory = value),
      _openBoxSafe<DownloadRecord>('downloads')
          .then((value) => downloads = value),
    ]);
  }

  /// Opening failures may be migration or I/O errors. Preserve user data.
  static Future<Box<T>> _openBoxSafe<T>(String boxName) async {
    try {
      return await Hive.openBox<T>(boxName);
    } catch (e, stackTrace) {
      KazumiLogger().e(
          'GStorage: Cannot open "$boxName" at $_hivePath; original files preserved',
          error: e,
          stackTrace: stackTrace);
      rethrow;
    }
  }

  static Future<void> backupBox(String boxName, String backupFilePath) async {
    final scopedName = {
      'histories',
      'collectibles',
      'favorites',
      'collectchanges'
    }.contains(boxName)
        ? accountBoxName(boxName)
        : boxName;
    final appDocumentDir = await getApplicationSupportDirectory();
    final hiveBoxFile = File('${appDocumentDir.path}/hive/$scopedName.hive');
    if (await hiveBoxFile.exists()) {
      await hiveBoxFile.copy(backupFilePath);
      KazumiLogger().i('GStorage: backup created at $backupFilePath');
    } else {
      KazumiLogger().w('GStorage: Hive box "$boxName" does not exist');
    }
  }

  static Future<void> patchHistory(String backupFilePath) async {
    final backupFile = File(backupFilePath);
    final backupContent = await backupFile.readAsBytes();
    final tempBox = await Hive.openBox('tempHistoryBox', bytes: backupContent);
    final tempBoxItems = tempBox.toMap().entries;

    for (var tempBoxItem in tempBoxItems) {
      final tempHistory = tempBoxItem.value as History;
      tempHistory.entryKind = HistoryEntryKind.normalize(tempHistory.entryKind);
      final targetKey = tempHistory.key;
      if (histories.get(targetKey) != null) {
        if (histories
            .get(targetKey)!
            .lastWatchTime
            .isBefore(tempHistory.lastWatchTime)) {
          await histories.delete(targetKey);
          await histories.put(targetKey, tempHistory);
        }
      } else {
        await histories.put(targetKey, tempHistory);
      }
    }
    await tempBox.close();
  }

  static Future<void> restoreCollectibles(String backupFilePath) async {
    final backupFile = File(backupFilePath);
    final backupContent = await backupFile.readAsBytes();
    final tempBox =
        await Hive.openBox('tempCollectiblesBox', bytes: backupContent);
    final tempBoxItems = tempBox.toMap().entries;
    KazumiLogger().i(
        'WebDav: restoring collectibles. tempCollectiblesBox length ${tempBoxItems.length}');

    await collectibles.clear();
    for (var tempBoxItem in tempBoxItems) {
      await collectibles.put(tempBoxItem.key, tempBoxItem.value);
    }
    await tempBox.close();
  }

  static Future<List<CollectedBangumi>> getCollectiblesFromFile(
      String backupFilePath) async {
    final backupFile = File(backupFilePath);
    final backupContent = await backupFile.readAsBytes();
    final tempBox =
        await Hive.openBox('tempCollectiblesBox', bytes: backupContent);
    final tempBoxItems = tempBox.toMap().entries;
    KazumiLogger().i(
        'WebDav: get collectibles from file. tempCollectiblesBox length ${tempBoxItems.length}');

    final List<CollectedBangumi> collectibles = [];
    for (var tempBoxItem in tempBoxItems) {
      collectibles.add(tempBoxItem.value);
    }
    await tempBox.close();
    return collectibles;
  }

  static Future<List<CollectedBangumiChange>> getCollectChangesFromFile(
      String backupFilePath) async {
    final backupFile = File(backupFilePath);
    final backupContent = await backupFile.readAsBytes();
    final tempBox =
        await Hive.openBox('tempCollectChangesBox', bytes: backupContent);
    final tempBoxItems = tempBox.toMap().entries;
    KazumiLogger().i(
        'WebDav: get collectChanges from file. tempCollectChangesBox length ${tempBoxItems.length}');

    final List<CollectedBangumiChange> collectChanges = [];
    for (var tempBoxItem in tempBoxItems) {
      collectChanges.add(tempBoxItem.value);
    }
    await tempBox.close();
    return collectChanges;
  }

  static Future<void> patchCollectibles(
      List<CollectedBangumi> remoteCollectibles,
      List<CollectedBangumiChange> remoteChanges) async {
    await _runCollectChangesWriteExclusive(() async {
      final mergeResult = CollectSyncMerger.mergeWebDav(
        localCollectibles: collectibles.values.toList(),
        localChanges: collectChanges.values.toList(),
        remoteCollectibles: remoteCollectibles,
        remoteChanges: remoteChanges,
      );

      // Update local storage
      await collectibles.clear();
      for (var collect in mergeResult.collectibles) {
        await collectibles.put(collect.bangumiItem.id, collect);
      }
      await collectibles.flush();

      await collectChanges.clear();
      for (var change in mergeResult.changes) {
        await collectChanges.put(change.id, change);
      }
      await collectChanges.flush();

      _collectChangeIdInitialized = false;
      _initializeNextCollectChangeIdLocked();
    });
  }

  static T getSetting<T>(
    SettingKey<T> key, {
    SettingContext context = const SettingContext(),
  }) {
    final defaultValue = key.resolveDefault(context);
    final storedValue = _setting.get(key.name);
    if (storedValue is T) {
      return storedValue;
    }
    return defaultValue;
  }

  static T getAccountSetting<T>(SettingKey<T> key) => _setting.get(
      '${key.name}_${_scope.boxOwner}',
      defaultValue: isLegacyAccount ? getSetting(key) : key.defaultValue) as T;

  static Future<void> putAccountSetting<T>(SettingKey<T> key, T value) =>
      _setting.put('${key.name}_${_scope.boxOwner}', value);

  static Future<void> putSetting<T>(SettingKey<T> key, T value) async {
    await _setting.put(key.name, value);
  }

  static Stream<void> watchSetting<T>(SettingKey<T> key) =>
      _setting.watch(key: key.name).map((_) {});

  static List<String> getStringListSettingByName(
    String key, {
    List<String> defaultValue = const [],
  }) {
    final storedValue = _setting.get(key);
    if (storedValue is List) {
      return storedValue.whereType<String>().toList();
    }
    return defaultValue;
  }

  static Future<void> putStringListSettingByName(
    String key,
    List<String> value,
  ) async {
    await _setting.put(key, value);
  }

  static Future<void> resetSettings(Iterable<SettingKey<Object?>> keys) async {
    await _setting.deleteAll(keys.map((key) => key.name));
    await _setting.flush();
  }

  static Future<void> resetPlayerSettings() async {
    await resetSettings(SettingsKeys.byGroup(SettingGroup.player));
  }

  static Future<void> resetDanmakuSettings() async {
    await resetSettings(SettingsKeys.byGroup(SettingGroup.danmaku));
  }

  GStorage._();
}

class _AccountData {
  final AccountIdentity identity;
  final String boxOwner;
  String get owner => identity.owner;
  final Box<BangumiItem> favorites;
  final Box<CollectedBangumi> collectibles;
  final Box<History> histories;
  final Box<CollectedBangumiChange> collectChanges;
  const _AccountData(this.identity, this.boxOwner, this.favorites,
      this.collectibles, this.histories, this.collectChanges);
}
